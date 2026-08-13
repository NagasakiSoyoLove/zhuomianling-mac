import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  AiChatImageAttachment,
  AiChatStreamEvent,
  AiProtocolTier
} from "../../shared/types/ai";
import type {
  PetDefinition,
  PetExpressionKey,
  PetExpressionSourceItem,
  PetLineEvent
} from "../../shared/types/pet";
import type { PetExpressionEvent } from "../live2d/Live2DCanvas";
import type { SpeechFrontendSettings } from "../services/speech/speechSettings";
import type { useSubtitle } from "../services/subtitle/subtitleStore";
import {
  inferExpressionFromAiReply,
  resolveMappedExpression
} from "./aiReplyUtils";
import { isCurrentAiStreamEvent } from "./aiStreamGuard";
import type { ChatMessage } from "./petWindowChatTypes";
import { buildAiMessages } from "./promptBuilder";
import type { UseVoiceReplyQueueResult } from "./useVoiceReplyQueue";
import type {
  ScreenVisionPresentationKind,
  ScreenVisionTimingStage
} from "../../shared/types/screen";

interface UseAiStreamOptions {
  petId: string;
  petDefinition?: PetDefinition;
  settings: SpeechFrontendSettings;
  draftRef: MutableRefObject<string>;
  setDraft: Dispatch<SetStateAction<string>>;
  subtitle: Pick<
    ReturnType<typeof useSubtitle>,
    | "show"
    | "showTypewriterProgress"
    | "finishTypewriterProgress"
    | "hide"
    | "isConversationBubbleActive"
  >;
  voiceReply: UseVoiceReplyQueueResult;
  clearVoiceTypewriter: () => void;
  triggerExpression: (
    expression: PetExpressionKey,
    priority?: PetExpressionEvent["priority"],
    durationMs?: number,
    hold?: boolean
  ) => void;
  triggerExpressionSource: (
    source: PetExpressionSourceItem,
    priority?: PetExpressionEvent["priority"],
    durationMs?: number
  ) => void;
  pickRandomExpressionSource: () => PetExpressionSourceItem | undefined;
  speakLine: (eventName: PetLineEvent, fallbackText: string) => void;
  resetIdleTimer: () => void;
  scheduleVoiceRestart: (isVoiceTriggered: boolean) => void;
}

interface AiStreamContext {
  kind: "stream" | "external";
  requestId: string;
  petId: string;
  pendingMessageId?: number;
  isVoiceTriggered: boolean;
  voiceReplyRequestId: number;
  voiceReplyEnabled: boolean;
  syncTextWithVoice: boolean;
  useReplyAsVoiceText: boolean;
  latestSafeReply: string;
  active: boolean;
  presentationKind?: ScreenVisionPresentationKind;
  externalReplyReceived?: boolean;
  visionTimingRequestId?: string;
  visionBubbleQueued?: boolean;
  chatFirstReplyReported?: boolean;
  chatBubbleQueued?: boolean;
}

interface TypewriterPresentation {
  messageId?: number;
  fullText: string;
  displayedCharacters: number;
  voiceText?: string;
  aiStructuredContent?: string;
  presentationKind?: ScreenVisionPresentationKind;
  finalized: boolean;
  holdMs?: number;
}

export interface AiStreamSettingsSnapshot {
  voiceReplyEnabled: boolean;
  syncTextWithVoice: boolean;
  useReplyAsVoiceText: boolean;
}

export interface SafeAiStreamPresentation {
  replyText: string;
}

export interface UseAiStreamResult {
  beginExternalQuestion: (userText: string, visionTimingRequestId?: string) => number | false;
  attachMessageScreenshot: (messageId: number, screenshot: AiChatImageAttachment) => void;
  cancel: (options?: { updateUi?: boolean }) => void;
  clearExternalPresentation: (requestId?: number) => void;
  failExternalQuestion: (message: string) => void;
  messages: ChatMessage[];
  presentExternalChunk: (
    reply: string,
    options?: {
      showInChat?: boolean;
      voiceText?: string;
      protocolTier?: AiProtocolTier;
      presentationKind?: ScreenVisionPresentationKind;
      voiceSessionId?: string;
    }
  ) => void;
  presentExternalReply: (
    reply: string,
    options?: {
      userText?: string;
      addToHistory?: boolean;
      showInChat?: boolean;
      voiceText?: string;
      emotion?: string;
      presentationKind?: ScreenVisionPresentationKind;
      voiceSessionId?: string;
      onStarted?: (requestId: number) => void;
    }
  ) => Promise<number | false>;
  reportVoiceError: (text: string) => void;
  sendMessageText: (text: string, isVoiceTriggered?: boolean) => Promise<void>;
  sending: boolean;
  showStreamingReply: (pendingMessageId: number, replyText: string) => boolean;
  typewriterActive: boolean;
}

const chatReplyTypewriterDelayMs = 34;

// TIMED DIAGNOSTICS TEST MODULE: renderer-side chat and visual timing instrumentation.
function reportExternalVisionTiming(
  context: AiStreamContext,
  stage: ScreenVisionTimingStage,
  ok = true
): void {
  if (context.kind !== "external" || !context.visionTimingRequestId) return;
  if (stage === "bubble-queued" && context.visionBubbleQueued) return;
  if (stage === "bubble-queued") context.visionBubbleQueued = true;
  window.desktopPet?.screenMonitor.timing?.({
    petId: context.petId,
    requestId: context.visionTimingRequestId,
    phase: "renderer",
    stage,
    ok
  });
}

function reportChatTiming(
  context: AiStreamContext,
  stage: ScreenVisionTimingStage,
  ok = true
): void {
  if (context.kind !== "stream") return;
  if (stage === "reply-chunk-received" && context.chatFirstReplyReported) return;
  if (stage === "reply-chunk-received") context.chatFirstReplyReported = true;
  if (stage === "bubble-queued" && context.chatBubbleQueued) return;
  if (stage === "bubble-queued") context.chatBubbleQueued = true;
  window.desktopPet?.screenMonitor.timing?.({
    petId: context.petId,
    requestId: context.requestId,
    kind: "chat",
    phase: "renderer",
    stage,
    ok
  });
}

function getTextDisplayDurationMs(text: string): number {
  const textLength = text.trim().length;
  return textLength * 42 + Math.min(Math.max(textLength * 110, 2200), 6200);
}

export function createAiStreamSettingsSnapshot(
  settings: SpeechFrontendSettings,
  petDefinition?: PetDefinition
): AiStreamSettingsSnapshot {
  const voiceReplyEnabled = settings.voiceReplyEnabled;
  return {
    voiceReplyEnabled,
    syncTextWithVoice: voiceReplyEnabled && settings.syncTextWithVoice,
    useReplyAsVoiceText:
      voiceReplyEnabled &&
      (petDefinition?.personaSettings?.chatLanguage ?? "zh") ===
        (petDefinition?.voiceModelSettings?.language ?? "zh")
  };
}

export function selectSafeAiStreamPresentation(
  event: Pick<AiChatStreamEvent, "content">
): SafeAiStreamPresentation {
  return {
    replyText: event.content ?? ""
  };
}

export function selectFinalVoiceText(
  replyText: string,
  voiceText: string | undefined,
  useReplyAsVoiceText: boolean,
  protocolTier: "full" | "text" = "full"
): string | undefined {
  if (protocolTier === "text" && !useReplyAsVoiceText) return undefined;
  const selected = (useReplyAsVoiceText ? replyText : voiceText?.trim() ?? "").trim();

  if (
    !selected ||
    /<\/?(?:think|analysis|reasoning)\b/i.test(selected) ||
    /```/.test(selected) ||
    /^\s*[{[]/.test(selected) ||
    /"(?:reply|emotion|voiceText|moodDelta)"\s*:/.test(selected)
  ) {
    return undefined;
  }

  return selected;
}

export function selectStreamingVoiceText(
  event: Pick<AiChatStreamEvent, "content" | "voiceText" | "protocolTier">,
  useReplyAsVoiceText: boolean
): string {
  if (event.protocolTier === "text" && !useReplyAsVoiceText) return "";
  return (useReplyAsVoiceText ? event.content : event.voiceText) ?? "";
}

export function enqueueSafeStreamingVoiceChunk(
  event: Pick<AiChatStreamEvent, "content" | "voiceText" | "protocolTier">,
  options: {
    enabled: boolean;
    useReplyAsVoiceText: boolean;
    requestId: number;
  },
  voiceReply: Pick<UseVoiceReplyQueueResult, "enqueueStreamingText">
): void {
  if (!options.enabled) {
    return;
  }

  voiceReply.enqueueStreamingText(
    selectStreamingVoiceText(event, options.useReplyAsVoiceText),
    options.requestId
  );
}

export function reconcileTypewriterText(
  currentFullText: string,
  displayedCharacters: number,
  nextFullText: string
): string {
  const displayedPrefix = Array.from(currentFullText)
    .slice(0, displayedCharacters)
    .join("");

  return nextFullText.startsWith(displayedPrefix) ? nextFullText : currentFullText;
}

export function buildInterruptedReplyText(
  safeReply: string,
  interruptionLabel: "回复生成中断" | "回复已取消"
): string {
  const normalizedReply = safeReply.trim();
  return normalizedReply
    ? `${normalizedReply}\n（${interruptionLabel}）`
    : `${interruptionLabel}。`;
}

export function appendVoiceErrorMessage(
  messages: ChatMessage[],
  text: string,
  now = Date.now()
): ChatMessage[] {
  const normalizedText = text.trim();
  if (!normalizedText) return messages;
  const lastMessage = messages.at(-1);
  if (lastMessage?.status === "error" && lastMessage.text === normalizedText) {
    return messages;
  }
  const nextId = Math.max(now, ...messages.map((message) => message.id + 1));
  return [...messages, { id: nextId, role: "pet", text: normalizedText, status: "error" }];
}

export function useAiStream(options: UseAiStreamOptions): UseAiStreamResult {
  const optionsRef = useRef(options);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [typewriterActive, setTypewriterActive] = useState(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const sendingRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const streamIdRef = useRef<string | undefined>();
  const streamRequestIdRef = useRef<string | undefined>();
  const streamContextRef = useRef<AiStreamContext | undefined>();
  const streamEventHandlerRef = useRef<(event: AiChatStreamEvent) => void>(() => undefined);
  const typewriterTimerRef = useRef<number | undefined>();
  const typewriterSequenceRef = useRef(0);
  const typewriterPresentationRef = useRef<TypewriterPresentation | undefined>();
  const externalContextRef = useRef<AiStreamContext | undefined>();
  const externalPresentationRequestIdRef = useRef<number | undefined>();
  const cancelRef = useRef<(options?: { updateUi?: boolean }) => void>(() => undefined);

  useLayoutEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useLayoutEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const setSendingState = (nextSending: boolean): void => {
    sendingRef.current = nextSending;
    setSending(nextSending);
  };

  const clearTypewriter = (): void => {
    typewriterSequenceRef.current += 1;
    window.clearTimeout(typewriterTimerRef.current);
    typewriterTimerRef.current = undefined;
    typewriterPresentationRef.current = undefined;
    setTypewriterActive(false);
  };

  const renderTypewriterProgress = (presentation: TypewriterPresentation): void => {
    const visibleText = Array.from(presentation.fullText)
      .slice(0, presentation.displayedCharacters)
      .join("");
    const currentDefinition = optionsRef.current.petDefinition;
    if (presentation.messageId !== undefined) {
      setMessages((current) =>
        current.map((message) =>
          message.id === presentation.messageId
            ? {
                ...message,
                text: visibleText,
                status: undefined,
                presentationKind: presentation.presentationKind,
                voiceText: presentation.finalized ? presentation.voiceText : message.voiceText,
                aiStructuredContent: presentation.finalized
                  ? presentation.aiStructuredContent
                  : message.aiStructuredContent
              }
            : message
        )
      );
    }
    optionsRef.current.subtitle.showTypewriterProgress({
      text: visibleText,
      fullText: presentation.fullText,
      tone: currentDefinition?.subtitleStyle?.tone,
      maxWidth: currentDefinition?.subtitleStyle?.maxWidth,
      kind: presentation.presentationKind === "fallback" ? "fallback" : "conversation"
    });
  };

  const advanceTypewriter = (sequenceId: number): void => {
    if (sequenceId !== typewriterSequenceRef.current) return;
    const presentation = typewriterPresentationRef.current;
    if (!presentation) return;
    const characterCount = Array.from(presentation.fullText).length;

    if (presentation.displayedCharacters >= characterCount) {
      typewriterTimerRef.current = undefined;
      if (presentation.finalized) {
        renderTypewriterProgress(presentation);
        optionsRef.current.subtitle.finishTypewriterProgress(presentation.holdMs);
        setTypewriterActive(false);
      }
      return;
    }

    presentation.displayedCharacters += 1;
    renderTypewriterProgress(presentation);
    typewriterTimerRef.current = window.setTimeout(
      () => advanceTypewriter(sequenceId),
      chatReplyTypewriterDelayMs
    );
  };

  const queuePetMessageWithTypewriter = (
    messageId: number | undefined,
    fullText: string,
    messageOptions?: {
      voiceText?: string;
      aiStructuredContent?: string;
      presentationKind?: ScreenVisionPresentationKind;
    },
    completionOptions?: { finalized?: boolean; holdMs?: number }
  ): void => {
    const normalizedText = fullText.trim();
    if (!normalizedText) return;
    let presentation = typewriterPresentationRef.current;

    if (!presentation || presentation.messageId !== messageId) {
      clearTypewriter();
      presentation = {
        messageId,
        fullText: normalizedText,
        displayedCharacters: 0,
        voiceText: messageOptions?.voiceText,
        aiStructuredContent: messageOptions?.aiStructuredContent,
        presentationKind: messageOptions?.presentationKind,
        finalized: Boolean(completionOptions?.finalized),
        holdMs: completionOptions?.holdMs
      };
      typewriterPresentationRef.current = presentation;
    } else {
      presentation.fullText = reconcileTypewriterText(
        presentation.fullText,
        presentation.displayedCharacters,
        normalizedText
      );
      presentation.voiceText = messageOptions?.voiceText ?? presentation.voiceText;
      presentation.aiStructuredContent =
        messageOptions?.aiStructuredContent ?? presentation.aiStructuredContent;
      presentation.presentationKind =
        messageOptions?.presentationKind ?? presentation.presentationKind;
      presentation.finalized ||= Boolean(completionOptions?.finalized);
      presentation.holdMs = completionOptions?.holdMs ?? presentation.holdMs;
      presentation.displayedCharacters = Math.min(
        presentation.displayedCharacters,
        Array.from(presentation.fullText).length
      );
    }

    setTypewriterActive(true);
    if (typewriterTimerRef.current === undefined) {
      advanceTypewriter(typewriterSequenceRef.current);
    }
  };

  const showStreamingReply = (pendingMessageId: number, replyText: string): boolean => {
    if (!replyText) {
      return false;
    }

    queuePetMessageWithTypewriter(pendingMessageId, replyText);
    return true;
  };

  const finishReply = async (context: AiStreamContext, event: AiChatStreamEvent): Promise<void> => {
    if (!context.active) return;
    reportChatTiming(context, "reply-chunk-received");
    const currentOptions = optionsRef.current;
    const definition = currentOptions.petDefinition;
    const replyText = event.content ?? "";
    const voiceText = event.voiceText;
    const effectiveVoiceText = context.voiceReplyEnabled
      ? selectFinalVoiceText(
          replyText,
          voiceText,
          context.useReplyAsVoiceText,
          event.protocolTier
        )
      : undefined;
    const inferredExpression = inferExpressionFromAiReply(replyText);
    const randomExpressionMode = definition?.expressionSelectionMode === "random";
    const randomReplySource = randomExpressionMode
      ? currentOptions.pickRandomExpressionSource()
      : undefined;
    const replyExpression = randomExpressionMode
      ? undefined
      : resolveMappedExpression(event.emotion, definition?.expressions, inferredExpression);
    const shouldHoldSubtitleForVoice =
      context.voiceReplyEnabled && Boolean(effectiveVoiceText?.trim());
    const requestId = context.voiceReplyRequestId;
    const syncTextWithVoice =
      shouldHoldSubtitleForVoice && context.syncTextWithVoice;

    if (syncTextWithVoice) {
      currentOptions.voiceReply.updateSynchronizedContent(replyText);
      currentOptions.voiceReply.enqueueFinalText(
        effectiveVoiceText ?? "",
        requestId
      );
      if (currentOptions.voiceReply.isPlaybackBlocked()) {
        if (context.pendingMessageId !== undefined) {
          setMessages((current) =>
            current.map((message) =>
              message.id === context.pendingMessageId
                ? { ...message, text: "首句语音生成中..." }
                : message
            )
          );
        }
        if (!(await currentOptions.voiceReply.awaitSynchronizedPlaybackStart(requestId))) {
          return;
        }
        if (!context.active) return;
      }
    }

    queuePetMessageWithTypewriter(
      context.pendingMessageId,
      replyText,
      {
        voiceText: effectiveVoiceText,
        aiStructuredContent: JSON.stringify({
          ...(effectiveVoiceText ? { voiceText: effectiveVoiceText } : {}),
          reply: replyText,
          ...(event.emotion ? { emotion: event.emotion } : {})
        }),
        ...(context.presentationKind ? { presentationKind: context.presentationKind } : {})
      },
      { finalized: true, holdMs: shouldHoldSubtitleForVoice ? Number.POSITIVE_INFINITY : undefined }
    );
    reportChatTiming(context, "bubble-queued");
    reportExternalVisionTiming(context, "bubble-queued");

    if (randomReplySource) {
      currentOptions.triggerExpressionSource(
        randomReplySource,
        "normal",
        randomReplySource.sourceKind === "expression"
          ? getTextDisplayDurationMs(replyText)
          : undefined
      );
    } else if (shouldHoldSubtitleForVoice && replyExpression) {
      currentOptions.voiceReply.setPendingExpression(replyExpression);
      if (currentOptions.voiceReply.holdExpression(requestId, replyExpression)) {
        currentOptions.voiceReply.clearPendingExpression();
      }
    } else if (replyExpression) {
      currentOptions.triggerExpression(
        replyExpression,
        "normal",
        replyExpression === "focus" ? 3600 : 2600
      );
    }

    if (shouldHoldSubtitleForVoice) {
      currentOptions.voiceReply.holdSubtitle(requestId);
    }

    if (!syncTextWithVoice && shouldHoldSubtitleForVoice) {
      currentOptions.voiceReply.enqueueFinalText(
        effectiveVoiceText ?? "",
        requestId
      );
    }
    if (syncTextWithVoice) {
      currentOptions.voiceReply.completeSynchronizedReveal();
    }
    currentOptions.voiceReply.finalizeReply(
      requestId,
      shouldHoldSubtitleForVoice && context.isVoiceTriggered
    );

    setSendingState(false);
    currentOptions.resetIdleTimer();
    if (!shouldHoldSubtitleForVoice) {
      currentOptions.scheduleVoiceRestart(context.isVoiceTriggered);
    }
    reportChatTiming(context, "reply-completed");
  };

  const failReply = (context: AiStreamContext, errorText: string): void => {
    const currentOptions = optionsRef.current;
    reportChatTiming(context, "request-failed", false);
    reportExternalVisionTiming(context, "request-failed", false);
    const preserveCommittedReply =
      currentOptions.voiceReply.hasCommittedSpeech() && Boolean(context.latestSafeReply.trim());
    const presentationText = preserveCommittedReply
      ? buildInterruptedReplyText(context.latestSafeReply, "回复生成中断")
      : errorText;
    currentOptions.voiceReply.stop();
    clearTypewriter();
    if (context.pendingMessageId !== undefined) {
      setMessages((current) =>
        current.map((message) =>
          message.id === context.pendingMessageId
            ? { id: context.pendingMessageId, role: "pet", text: presentationText, status: "error" }
            : message
        )
      );
    }
    currentOptions.triggerExpression("panic", "high", 3600);
    currentOptions.subtitle.show({
      text: preserveCommittedReply ? "回复生成中断。" : errorText,
      mode: "typewriter",
      tone: currentOptions.petDefinition?.subtitleStyle?.tone,
      maxWidth: currentOptions.petDefinition?.subtitleStyle?.maxWidth,
      kind: "system"
    });
    setSendingState(false);
    currentOptions.resetIdleTimer();
    currentOptions.scheduleVoiceRestart(context.isVoiceTriggered);
  };

  const cancel = (cancelOptions?: { updateUi?: boolean }): void => {
    const requestId = streamRequestIdRef.current;
    const streamId = streamIdRef.current;
    const externalContext = externalContextRef.current;
    const context = streamContextRef.current ?? externalContext;
    const preserveCommittedReply = Boolean(
      context &&
        optionsRef.current.voiceReply.hasCommittedSpeech() &&
        context.latestSafeReply.trim()
    );
    streamRequestIdRef.current = undefined;
    streamIdRef.current = undefined;
    streamContextRef.current = undefined;
    if (externalContext) {
      externalContext.active = false;
      externalContextRef.current = undefined;
    }
    optionsRef.current.voiceReply.cancelSynchronizedReveal();

    if ((requestId || streamId) && context?.kind !== "external") {
      void window.desktopPet?.aiChat
        .cancel({
          petId: context?.petId ?? optionsRef.current.petId,
          requestId,
          streamId
        })
        .catch(() => undefined);
    }
    if (context) {
      optionsRef.current.voiceReply.stop({
        clearPresentation: cancelOptions?.updateUi ?? true
      });
    }
    if (cancelOptions?.updateUi ?? true) {
      optionsRef.current.subtitle.hide();
      clearTypewriter();
      if (context) {
        setMessages((current) =>
          current.map((message) =>
            message.id === context.pendingMessageId
              ? {
                  ...message,
                  text: preserveCommittedReply
                    ? buildInterruptedReplyText(context.latestSafeReply, "回复已取消")
                    : "回复已取消。",
                  status: "error"
                }
              : message
          )
        );
      }
      setSendingState(false);
    }
  };

  useLayoutEffect(() => {
    cancelRef.current = cancel;
  });

  useLayoutEffect(() => {
    streamEventHandlerRef.current = (event: AiChatStreamEvent): void => {
      const context = streamContextRef.current;
      if (
        !context ||
        !isCurrentAiStreamEvent(event, {
          requestId: streamRequestIdRef.current,
          streamId: streamIdRef.current,
          petId: context.petId
        })
      ) {
        return;
      }

      if (event.type === "chunk") {
        const { replyText } = selectSafeAiStreamPresentation(event);
        context.latestSafeReply = replyText;
        if (context.syncTextWithVoice) {
          optionsRef.current.voiceReply.updateSynchronizedContent(replyText);
        } else if (context.pendingMessageId !== undefined) {
          if (showStreamingReply(context.pendingMessageId, replyText)) {
            reportChatTiming(context, "reply-chunk-received");
            reportChatTiming(context, "bubble-queued");
          }
        }
        enqueueSafeStreamingVoiceChunk(
          event,
          {
            enabled: context.voiceReplyEnabled,
            useReplyAsVoiceText: context.useReplyAsVoiceText,
            requestId: context.voiceReplyRequestId
          },
          optionsRef.current.voiceReply
        );
        return;
      }

      streamRequestIdRef.current = undefined;
      streamIdRef.current = undefined;
      streamContextRef.current = undefined;
      if (event.type === "done" && event.ok && event.content) {
        void finishReply(context, event);
      } else {
        failReply(
          context,
          event.message ??
            (event.type === "canceled" ? "回复已取消。" : "AI 暂时没有回应，请稍后再试。")
        );
      }
    };
  });

  useEffect(() => {
    return window.desktopPet?.aiChat.onStreamEvent((event) => {
      streamEventHandlerRef.current(event);
    });
  }, []);

  useEffect(() => {
    const cancelWhenHidden = (): void => {
      if (document.hidden) {
        cancelRef.current();
      }
    };
    const cancelOnPageHide = (): void => cancelRef.current({ updateUi: false });
    document.addEventListener("visibilitychange", cancelWhenHidden);
    window.addEventListener("pagehide", cancelOnPageHide);
    return () => {
      document.removeEventListener("visibilitychange", cancelWhenHidden);
      window.removeEventListener("pagehide", cancelOnPageHide);
    };
  }, []);

  useEffect(() => {
    return () => {
      clearTypewriter();
      cancelRef.current({ updateUi: false });
    };
  }, []);

  const sendMessageText = async (text: string, isVoiceTriggered = false): Promise<void> => {
    const nextText = text.trim();
    if (!nextText || sendingRef.current) {
      return;
    }

    cancel({ updateUi: false });
    clearTypewriter();
    const currentOptions = optionsRef.current;
    currentOptions.subtitle.hide();
    const settingsSnapshot = createAiStreamSettingsSnapshot(
      currentOptions.settings,
      currentOptions.petDefinition
    );
    const userMessageId = Date.now();
    const pendingMessageId = userMessageId + 1;
    const requestId = `chat-${Date.now()}-${++requestSequenceRef.current}`;
    const shouldSynchronize = settingsSnapshot.syncTextWithVoice;
    const voiceReplyRequestId = currentOptions.voiceReply.beginReply(
      pendingMessageId,
      shouldSynchronize,
      settingsSnapshot.voiceReplyEnabled,
      requestId
    );
    const context: AiStreamContext = {
      kind: "stream",
      requestId,
      petId: currentOptions.petId,
      pendingMessageId,
      isVoiceTriggered,
      voiceReplyRequestId,
      latestSafeReply: "",
      active: true,
      ...settingsSnapshot
    };
    streamRequestIdRef.current = requestId;
    streamIdRef.current = undefined;
    streamContextRef.current = context;
    reportChatTiming(context, "request-started");
    const aiMessages = buildAiMessages({
      messages: messagesRef.current,
      nextUserText: nextText
    });

    setSendingState(true);
    setMessages((current) => [
      ...current,
      { id: userMessageId, role: "user", text: nextText },
      { id: pendingMessageId, role: "pet", text: "思考中...", status: "thinking" }
    ]);
    currentOptions.draftRef.current = "";
    currentOptions.setDraft("");
    currentOptions.clearVoiceTypewriter();
    currentOptions.triggerExpression("focus", "normal", 1800);
    currentOptions.speakLine("userMessage", "嗯，我听见了。");
    currentOptions.resetIdleTimer();

    try {
      const streamResult = await window.desktopPet?.aiChat.stream({
        petId: context.petId,
        requestId,
        messages: aiMessages
      });

      if (
        streamRequestIdRef.current !== requestId ||
        streamContextRef.current?.requestId !== requestId
      ) {
        if (streamResult?.streamId) {
          void window.desktopPet?.aiChat
            .cancel({
              petId: context.petId,
              requestId,
              streamId: streamResult.streamId
            })
            .catch(() => undefined);
        }
        return;
      }

      if (!streamResult?.ok || !streamResult.streamId) {
        streamRequestIdRef.current = undefined;
        streamContextRef.current = undefined;
        failReply(context, streamResult?.message ?? "AI 暂时没有回应，请稍后再试。");
      } else if (streamResult.requestId && streamResult.requestId !== requestId) {
        streamRequestIdRef.current = undefined;
        streamContextRef.current = undefined;
        void window.desktopPet?.aiChat
          .cancel({
            petId: context.petId,
            requestId: streamResult.requestId,
            streamId: streamResult.streamId
          })
          .catch(() => undefined);
        failReply(context, "AI 请求标识不一致，请稍后再试。");
      } else {
        streamIdRef.current = streamResult.streamId;
      }
    } catch {
      if (streamRequestIdRef.current !== requestId) {
        return;
      }
      streamRequestIdRef.current = undefined;
      streamIdRef.current = undefined;
      streamContextRef.current = undefined;
      failReply(context, "无法连接 AI 服务，请检查网络或本地服务状态。");
    }
  };

  const clearExternalPresentation = (requestId?: number): void => {
    const context = externalContextRef.current;
    const activeRequestId = context?.voiceReplyRequestId ?? externalPresentationRequestIdRef.current;
    if (requestId !== undefined && activeRequestId !== requestId) return;
    if (context) {
      context.active = false;
      externalContextRef.current = undefined;
    }
    if (activeRequestId === undefined && requestId !== undefined) return;
    clearTypewriter();
    optionsRef.current.subtitle.hide();
    optionsRef.current.triggerExpression("normal", "high", 1_800);
    if (requestId === undefined || activeRequestId === requestId) {
      externalPresentationRequestIdRef.current = undefined;
    }
  };

  const createExternalContext = (
    pendingMessageId?: number,
    visionTimingRequestId?: string,
    voiceSessionId?: string
  ): AiStreamContext => {
    const currentOptions = optionsRef.current;
    const settingsSnapshot = createAiStreamSettingsSnapshot(
      currentOptions.settings,
      currentOptions.petDefinition
    );
    const requestId = `external-${Date.now()}-${++requestSequenceRef.current}`;
    const voiceReplyRequestId = currentOptions.voiceReply.beginReply(
      pendingMessageId ?? Date.now(),
      settingsSnapshot.syncTextWithVoice,
      settingsSnapshot.voiceReplyEnabled,
      voiceSessionId ?? visionTimingRequestId ?? requestId
    );
    externalPresentationRequestIdRef.current = voiceReplyRequestId;
    return {
      kind: "external",
      requestId,
      petId: currentOptions.petId,
      pendingMessageId,
      isVoiceTriggered: false,
      voiceReplyRequestId,
      latestSafeReply: "",
      active: true,
      visionTimingRequestId,
      ...settingsSnapshot
    };
  };

  const beginExternalQuestion = (userText: string, visionTimingRequestId?: string): number | false => {
    const normalizedText = userText.trim().slice(0, 8_000);
    if (!normalizedText || sendingRef.current) return false;

    cancel({ updateUi: false });
    clearTypewriter();
    const currentOptions = optionsRef.current;
    currentOptions.subtitle.hide();
    const userMessageId = Date.now();
    const pendingMessageId = userMessageId + 1;
    const context = createExternalContext(pendingMessageId, visionTimingRequestId);
    externalContextRef.current = context;

    setSendingState(true);
    setMessages((current) => [
      ...current,
      { id: userMessageId, role: "user", text: normalizedText },
      { id: pendingMessageId, role: "pet", text: "正在观察屏幕…", status: "thinking" }
    ]);
    currentOptions.clearVoiceTypewriter();
    currentOptions.triggerExpression("focus", "normal", 1800);
    currentOptions.speakLine("userMessage", "嗯，我听见了。");
    currentOptions.resetIdleTimer();
    return userMessageId;
  };

  const failExternalQuestion = (message: string): void => {
    const context = externalContextRef.current;
    if (!context) return;
    externalContextRef.current = undefined;
    context.active = false;
    failReply(context, message);
  };

  const reportVoiceError = (text: string): void => {
    setMessages((current) => appendVoiceErrorMessage(current, text));
  };

  const attachMessageScreenshot = (messageId: number, screenshot: AiChatImageAttachment): void => {
    setMessages((current) => current.map((message) =>
      message.id === messageId && message.role === "user"
        ? {
            ...message,
            screenshot: {
              data: screenshot.data.slice(),
              mimeType: screenshot.mimeType
            }
          }
        : message
    ));
  };

  const presentExternalChunk = (
    reply: string,
    presentationOptions: {
      showInChat?: boolean;
      voiceText?: string;
      protocolTier?: AiProtocolTier;
      presentationKind?: ScreenVisionPresentationKind;
      voiceSessionId?: string;
    } = {}
  ): void => {
    const showInChat = presentationOptions.showInChat !== false;
    let context = externalContextRef.current;
    if (!context) {
      if (showInChat) return;
      if (
        sendingRef.current ||
        optionsRef.current.voiceReply.hasActiveAudio() ||
        optionsRef.current.subtitle.isConversationBubbleActive()
      ) {
        return;
      }
      cancel({ updateUi: false });
      clearTypewriter();
      context = createExternalContext(
        undefined,
        undefined,
        presentationOptions.voiceSessionId
      );
      externalContextRef.current = context;
    }
    if (!context.active || context.externalReplyReceived) return;
    if (presentationOptions.presentationKind) {
      context.presentationKind = presentationOptions.presentationKind;
    }

    const normalizedReply = reply.trim().slice(0, 4_000);
    const normalizedVoiceText = presentationOptions.voiceText?.trim().slice(0, 4_000);
    if (!normalizedReply && !normalizedVoiceText) return;

    if (normalizedReply) {
      context.latestSafeReply = normalizedReply;
      if (context.syncTextWithVoice) {
        optionsRef.current.voiceReply.updateSynchronizedContent(normalizedReply);
      } else if (context.pendingMessageId !== undefined) {
        showStreamingReply(context.pendingMessageId, normalizedReply);
        reportExternalVisionTiming(context, "bubble-queued");
      }
    }

    enqueueSafeStreamingVoiceChunk(
      {
        content: normalizedReply,
        ...(normalizedVoiceText ? { voiceText: normalizedVoiceText } : {}),
        protocolTier: presentationOptions.protocolTier
      },
      {
        enabled: context.voiceReplyEnabled,
        useReplyAsVoiceText: context.useReplyAsVoiceText,
        requestId: context.voiceReplyRequestId
      },
      optionsRef.current.voiceReply
    );
  };

  const presentExternalReply = async (
    reply: string,
    presentationOptions: {
      userText?: string;
      addToHistory?: boolean;
      showInChat?: boolean;
      voiceText?: string;
      emotion?: string;
      presentationKind?: ScreenVisionPresentationKind;
      voiceSessionId?: string;
      onStarted?: (requestId: number) => void;
    } = {}
  ): Promise<number | false> => {
    const normalizedReply = reply.trim().slice(0, 4_000);
    if (!normalizedReply) return false;

    const showInChat = presentationOptions.showInChat !== false;
    let context = externalContextRef.current;
    if (!context) {
      if (showInChat) return false;
      const currentOptions = optionsRef.current;
      if (
        !showInChat &&
        (
          sendingRef.current ||
          currentOptions.voiceReply.hasActiveAudio() ||
          currentOptions.subtitle.isConversationBubbleActive()
        )
      ) {
        return false;
      }

      cancel({ updateUi: false });
      clearTypewriter();
      context = createExternalContext(
        undefined,
        undefined,
        presentationOptions.voiceSessionId
      );
      externalContextRef.current = context;
    }
    if (!context.active || context.externalReplyReceived) return false;
    if (!showInChat && context.pendingMessageId !== undefined) return false;
    if (presentationOptions.presentationKind) {
      context.presentationKind = presentationOptions.presentationKind;
    }
    context.externalReplyReceived = true;
    context.latestSafeReply = normalizedReply;

    const voiceText = presentationOptions.voiceText?.trim() || undefined;
    presentationOptions.onStarted?.(context.voiceReplyRequestId);
    const presentation = finishReply(context, {
      streamId: context.requestId,
      requestId: context.requestId,
      petId: context.petId,
      ok: true,
      type: "done",
      content: normalizedReply,
      ...(voiceText ? { voiceText } : {}),
      ...(presentationOptions.emotion?.trim()
        ? { emotion: presentationOptions.emotion.trim() }
        : {}),
      protocolTier: voiceText ? "full" : "text"
    }).then(() => context.voiceReplyRequestId);
    return presentation.finally(() => {
      reportExternalVisionTiming(context, "reply-completed");
      if (externalContextRef.current === context) {
        externalContextRef.current = undefined;
        context.active = false;
      }
    });
  };

  return {
    beginExternalQuestion,
    attachMessageScreenshot,
    cancel,
    clearExternalPresentation,
    failExternalQuestion,
    messages,
    presentExternalChunk,
    presentExternalReply,
    reportVoiceError,
    sendMessageText,
    sending,
    showStreamingReply,
    typewriterActive
  };
}
