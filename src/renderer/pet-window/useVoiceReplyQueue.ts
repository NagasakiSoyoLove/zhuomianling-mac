import { useEffect, useLayoutEffect, useRef } from "react";
import type { PetExpressionKey } from "../../shared/types/pet";
import type { PetExpressionEvent } from "../live2d/Live2DCanvas";
import type { useSubtitle } from "../services/subtitle/subtitleStore";
import { base64ToBlob } from "./audioUtils";
import { StreamingVoiceCommitter } from "./streamingVoiceCommitter";

export interface VoiceReplyAudio {
  audioUrl: string;
  mimeType: string;
}

export function createVoiceReplyAudioSafely(
  audioBase64: string,
  mimeType: string,
  createBlob: (base64: string, type: string) => Blob = base64ToBlob,
  createObjectUrl: (blob: Blob) => string = (blob) => window.URL.createObjectURL(blob)
): VoiceReplyAudio | undefined {
  try {
    return {
      audioUrl: createObjectUrl(createBlob(audioBase64, mimeType)),
      mimeType
    };
  } catch {
    return undefined;
  }
}

interface VoiceReplyQueueItem {
  segment: string;
  audioPromise?: Promise<VoiceReplyAudio | undefined>;
}

interface VoiceReplyQueueState {
  items: VoiceReplyQueueItem[];
  playing: boolean;
  playbackBlocked: boolean;
  queuedVoiceSegments: string[];
}

interface SyncVoiceRevealState {
  requestId: number;
  pendingMessageId: number;
  latestContent: string;
  revealed: boolean;
  firstAudioSettled: boolean;
  watchingFirstAudio: boolean;
}

interface UseVoiceReplyQueueOptions {
  petId: string;
  subtitle: Pick<ReturnType<typeof useSubtitle>, "hide" | "hideAfter">;
  triggerExpression: (
    expression: PetExpressionKey,
    priority?: PetExpressionEvent["priority"],
    durationMs?: number,
    hold?: boolean
  ) => void;
  showVoiceMessage: (text: string, status?: "thinking" | "error") => void;
  onVoiceError: (text: string) => void;
  onSynchronizedReveal: (pendingMessageId: number, replyText: string) => void;
  onPlaybackDrained: (restartContinuousConversation: boolean) => void;
}

export interface UseVoiceReplyQueueResult {
  awaitSynchronizedPlaybackStart: (requestId: number) => Promise<boolean>;
  beginReply: (
    pendingMessageId: number,
    synchronized: boolean,
    voiceReplyEnabled: boolean,
    sessionId?: string
  ) => number;
  cancelSynchronizedReveal: () => void;
  clearPendingExpression: () => void;
  completeSynchronizedReveal: () => void;
  enqueueStreamingText: (voiceText: string, requestId?: number) => void;
  enqueueFinalText: (voiceText: string, requestId?: number) => void;
  hasActiveAudio: () => boolean;
  hasCommittedSpeech: () => boolean;
  holdExpression: (requestId: number, expression?: PetExpressionKey) => boolean;
  finalizeReply: (requestId: number, restartAfterReply: boolean) => void;
  holdSubtitle: (requestId: number) => void;
  isPlaybackBlocked: () => boolean;
  isSubtitleHeld: () => boolean;
  playPresetLineAudio: (audioPath: string) => Promise<void>;
  releaseSubtitle: (requestId: number) => void;
  setPendingExpression: (expression?: PetExpressionKey) => void;
  stop: (options?: { clearPresentation?: boolean }) => void;
  updateSynchronizedContent: (content: string) => void;
}

const synthesisLookahead = 3;
const segmentMaxAttempts = 3;
const segmentRetryBaseMs = 220;

function createEmptyQueue(): VoiceReplyQueueState {
  return {
    items: [],
    playing: false,
    playbackBlocked: false,
    queuedVoiceSegments: []
  };
}

export interface VoiceReplyCompletionState {
  currentRequest: boolean;
  finalized: boolean;
  notified: boolean;
  playing: boolean;
  queuedItems: number;
}

export function shouldCompleteVoiceReply(state: VoiceReplyCompletionState): boolean {
  return (
    state.currentRequest &&
    state.finalized &&
    !state.notified &&
    !state.playing &&
    state.queuedItems === 0
  );
}

export function normalizeVoiceReplyText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function startsWithAscii(bytes: Uint8Array, offset: number, value: string): boolean {
  return Array.from(value).every(
    (character, index) => bytes[offset + index] === character.charCodeAt(0)
  );
}

export function getVoiceAudioPayloadError(
  audioBase64: string,
  mimeType: string,
  decodeBase64: (value: string) => string = (value) => window.atob(value)
): string | undefined {
  const normalizedBase64 = audioBase64.trim();
  if (!normalizedBase64) {
    return "语音未播放：声音模型没有返回音频数据。";
  }

  let binary: string;
  try {
    // File signatures fit in the first 18 decoded bytes; avoid decoding a
    // potentially large reply twice before it is converted to a Blob.
    binary = decodeBase64(normalizedBase64.slice(0, 24));
  } catch {
    return "语音未播放：声音模型返回了无法读取的音频数据。";
  }

  const bytes = Uint8Array.from(binary.slice(0, 16), (character) => character.charCodeAt(0));
  const normalizedMimeType = mimeType.split(";", 1)[0]?.trim().toLowerCase();
  const isWav = startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WAVE");
  const isMp3 = startsWithAscii(bytes, 0, "ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  const isOgg = startsWithAscii(bytes, 0, "OggS");
  const isAac = bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  const hasKnownDeclaredFormat =
    normalizedMimeType === "audio/wav" ||
    normalizedMimeType === "audio/x-wav" ||
    normalizedMimeType === "audio/wave" ||
    normalizedMimeType === "audio/vnd.wave" ||
    normalizedMimeType === "audio/mpeg" ||
    normalizedMimeType === "audio/ogg" ||
    normalizedMimeType === "audio/aac";
  const expectedFormatMatches =
    ((normalizedMimeType === "audio/wav" ||
      normalizedMimeType === "audio/x-wav" ||
      normalizedMimeType === "audio/wave" ||
      normalizedMimeType === "audio/vnd.wave") && isWav) ||
    (normalizedMimeType === "audio/mpeg" && isMp3) ||
    (normalizedMimeType === "audio/ogg" && isOgg) ||
    (normalizedMimeType === "audio/aac" && isAac);

  if (expectedFormatMatches) {
    return undefined;
  }

  if (hasKnownDeclaredFormat && (isWav || isMp3 || isOgg || isAac)) {
    return "语音未播放：声音模型返回的音频格式与声明格式不一致。";
  }

  if (isWav || isMp3 || isOgg || isAac) return undefined;

  return "语音未播放：声音模型返回的不是有效的受支持音频。";
}

export function getVoicePlaybackErrorMessage(mediaErrorCode?: number): string {
  if (mediaErrorCode === 3) {
    return "语音未播放：当前环境无法解码生成的音频。";
  }
  if (mediaErrorCode === 4) {
    return "语音未播放：当前环境不支持生成的音频格式。";
  }
  return "语音未播放：当前环境未能启动音频播放。";
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

export function useVoiceReplyQueue(
  options: UseVoiceReplyQueueOptions
): UseVoiceReplyQueueResult {
  const optionsRef = useRef(options);
  const presetLineAudioRef = useRef<HTMLAudioElement | null>(null);
  const presetLineUrlRef = useRef<string>();
  const presetLineRequestRef = useRef(0);
  const voiceReplyAudioRef = useRef<HTMLAudioElement | null>(null);
  const activePlaybackCancelRef = useRef<(() => void) | undefined>();
  const voiceReplyUrlRef = useRef<string | undefined>();
  const pendingUrlsRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<VoiceReplyQueueState>(createEmptyQueue());
  const streamingCommitterRef = useRef(new StreamingVoiceCommitter());
  const syncRevealRef = useRef<SyncVoiceRevealState | undefined>();
  const requestIdRef = useRef(0);
  const voiceSessionIdRef = useRef<string | undefined>();
  const textToSpeechRequestSequenceRef = useRef(0);
  const voiceConfigurationErrorRequestRef = useRef<number | undefined>();
  const voiceErrorReportedRequestRef = useRef<number | undefined>();
  const subtitleHoldRef = useRef<{ requestId: number; active: boolean } | undefined>();
  const expressionHoldRef = useRef<{ requestId: number; active: boolean } | undefined>();
  const pendingExpressionRef = useRef<PetExpressionKey | undefined>();
  const restartAfterReplyRef = useRef(false);
  const replyFinalizedRef = useRef(true);
  const completionNotifiedRef = useRef(false);
  const voiceReplyEnabledRef = useRef(false);
  const stopRef = useRef<(options?: { clearPresentation?: boolean }) => void>(
    () => undefined
  );

  const reportVoiceError = (requestId: number, text: string): void => {
    if (
      requestId !== requestIdRef.current ||
      voiceErrorReportedRequestRef.current === requestId
    ) {
      return;
    }
    voiceErrorReportedRequestRef.current = requestId;
    optionsRef.current.showVoiceMessage(text, "error");
    optionsRef.current.onVoiceError(text);
  };

  const releaseSubtitle = (requestId: number): void => {
    const hold = subtitleHoldRef.current;

    if (!hold?.active || hold.requestId !== requestId || requestId !== requestIdRef.current) {
      return;
    }

    hold.active = false;
    optionsRef.current.subtitle.hideAfter(1800);
  };

  const releaseExpression = (requestId: number): void => {
    const hold = expressionHoldRef.current;

    if (!hold?.active || hold.requestId !== requestId || requestId !== requestIdRef.current) {
      return;
    }

    hold.active = false;
    optionsRef.current.triggerExpression("normal", "high", 1800);
  };

  const holdExpression = (requestId: number, expression?: PetExpressionKey): boolean => {
    if (!expression || requestId !== requestIdRef.current || expressionHoldRef.current?.active) {
      return false;
    }

    expressionHoldRef.current = { requestId, active: true };
    optionsRef.current.triggerExpression(expression, "high", undefined, true);
    return true;
  };

  const hasActiveAudio = (): boolean =>
    Boolean(
      voiceReplyAudioRef.current ||
        queueRef.current.playing ||
        queueRef.current.items.length ||
        pendingUrlsRef.current.size
    );

  const synthesizeSegment = async (
    segment: string,
    requestId: number
  ): Promise<VoiceReplyAudio | undefined> => {
    if (voiceConfigurationErrorRequestRef.current === requestId) {
      return undefined;
    }

    const textToSpeechRequestId =
      `voice-${requestId}-${++textToSpeechRequestSequenceRef.current}`;
    let failureMessage: string | undefined;

    for (let attempt = 1; attempt <= segmentMaxAttempts; attempt += 1) {
      if (requestId !== requestIdRef.current) {
        return undefined;
      }

      let response;
      try {
        response = await window.desktopPet?.textToSpeech.speak({
          petId: optionsRef.current.petId,
          text: segment,
          requestId: textToSpeechRequestId,
          sessionId: voiceSessionIdRef.current
        });
      } catch {
        if (requestId !== requestIdRef.current) {
          return undefined;
        }
        failureMessage = "请求 GPT-SoVITS 时发生通信错误，请稍后重试。";
        if (attempt < segmentMaxAttempts) {
          await waitForRetry(segmentRetryBaseMs * attempt);
        }
        continue;
      }

      if (requestId !== requestIdRef.current) {
        return undefined;
      }

      if (
        response?.ok &&
        response.audioBase64 &&
        (!response.requestId || response.requestId === textToSpeechRequestId)
      ) {
        const mimeType = response.mimeType ?? "audio/wav";
        const payloadError = getVoiceAudioPayloadError(response.audioBase64, mimeType);
        if (payloadError) {
          reportVoiceError(requestId, payloadError);
          return undefined;
        }
        const audio = createVoiceReplyAudioSafely(response.audioBase64, mimeType);
        if (audio) {
          pendingUrlsRef.current.add(audio.audioUrl);
          return audio;
        }
        failureMessage = "语音未播放：生成的音频数据无法加载。";
      }

      if (response?.code === "CANCELED") {
        return undefined;
      }

      if (response?.code === "INVALID_CONFIG") {
        const shouldShowMessage = voiceConfigurationErrorRequestRef.current !== requestId;
        voiceConfigurationErrorRequestRef.current = requestId;
        failureMessage = response.message?.trim() || "声音模型资源不可用，请重新配置并连接。";
        if (shouldShowMessage && requestId === requestIdRef.current) {
          reportVoiceError(requestId, `GPT-SoVITS：${failureMessage}`);
        }
        return undefined;
      }

      if (response?.message?.trim()) {
        failureMessage = response.message.trim();
      }

      if (attempt < segmentMaxAttempts) {
        await waitForRetry(segmentRetryBaseMs * attempt);
      }
    }

    if (requestId === requestIdRef.current && failureMessage) {
      reportVoiceError(requestId, `GPT-SoVITS：${failureMessage}`);
    }

    return undefined;
  };

  const primeItems = (
    queue: VoiceReplyQueueState,
    requestId: number,
    lookahead = synthesisLookahead
  ): void => {
    if (requestId !== requestIdRef.current) {
      return;
    }

    let primedCount = 0;
    for (const item of queue.items) {
      if (primedCount >= lookahead) {
        return;
      }
      item.audioPromise ??= synthesizeSegment(item.segment, requestId);
      primedCount += 1;
    }
  };

  const revealSynchronizedOutput = (requestId: number): boolean => {
    const revealState = syncRevealRef.current;
    const queue = queueRef.current;

    if (
      !revealState ||
      revealState.requestId !== requestId ||
      revealState.revealed ||
      !revealState.firstAudioSettled ||
      requestId !== requestIdRef.current
    ) {
      return false;
    }

    revealState.revealed = true;
    queue.playbackBlocked = false;
    optionsRef.current.onSynchronizedReveal(
      revealState.pendingMessageId,
      revealState.latestContent
    );
    void drainQueue(requestId);
    return true;
  };

  const watchFirstQueuedItem = (requestId: number): void => {
    const revealState = syncRevealRef.current;
    const firstItem = queueRef.current.items[0];

    if (
      !revealState ||
      !firstItem ||
      revealState.requestId !== requestId ||
      revealState.revealed ||
      revealState.firstAudioSettled ||
      revealState.watchingFirstAudio ||
      requestId !== requestIdRef.current
    ) {
      return;
    }

    revealState.watchingFirstAudio = true;
    firstItem.audioPromise ??= synthesizeSegment(firstItem.segment, requestId);
    void firstItem.audioPromise.then(() => {
      const current = syncRevealRef.current;
      if (!current || current.requestId !== requestId || requestId !== requestIdRef.current) {
        return;
      }
      current.firstAudioSettled = true;
      revealSynchronizedOutput(requestId);
    });
  };

  const playAudioUrl = async (
    audioUrl: string,
    requestId: number
  ): Promise<boolean> => {
    if (requestId !== requestIdRef.current) {
      window.URL.revokeObjectURL(audioUrl);
      pendingUrlsRef.current.delete(audioUrl);
      return false;
    }

    pendingUrlsRef.current.delete(audioUrl);
    let audio: HTMLAudioElement;
    try {
      audio = new Audio(audioUrl);
    } catch {
      window.URL.revokeObjectURL(audioUrl);
      reportVoiceError(requestId, getVoicePlaybackErrorMessage());
      return false;
    }
    voiceReplyAudioRef.current = audio;
    voiceReplyUrlRef.current = audioUrl;

    return new Promise((resolve) => {
      let settled = false;
      const cleanup = (): void => {
        if (voiceReplyAudioRef.current === audio) {
          voiceReplyAudioRef.current = null;
        }
        window.URL.revokeObjectURL(audioUrl);
        if (voiceReplyUrlRef.current === audioUrl) {
          voiceReplyUrlRef.current = undefined;
        }
      };

      const finish = (canContinue: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (activePlaybackCancelRef.current === cancelPlayback) {
          activePlaybackCancelRef.current = undefined;
        }
        resolve(canContinue);
      };
      const cancelPlayback = (): void => finish(false);
      activePlaybackCancelRef.current = cancelPlayback;

      audio.addEventListener("ended", () => {
        finish(true);
      }, { once: true });
      audio.addEventListener("error", () => {
        if (settled || requestId !== requestIdRef.current) {
          return;
        }
        const message = getVoicePlaybackErrorMessage(audio.error?.code);
        queueRef.current.items.splice(0);
        finish(false);
        reportVoiceError(requestId, message);
      }, { once: true });
      void audio.play().catch(() => {
        if (settled || requestId !== requestIdRef.current) {
          return;
        }
        queueRef.current.items.splice(0);
        finish(false);
        reportVoiceError(requestId, getVoicePlaybackErrorMessage());
        releaseSubtitle(requestId);
        releaseExpression(requestId);
      });
    });
  };

  const drainQueue = async (requestId: number): Promise<void> => {
    const queue = queueRef.current;
    if (queue.playing || queue.playbackBlocked) {
      return;
    }

    queue.playing = true;
    try {
      while (requestId === requestIdRef.current && queue.items.length > 0) {
        const item = queue.items.shift();
        if (!item) {
          continue;
        }
        item.audioPromise ??= synthesizeSegment(item.segment, requestId);
        const audio = await item.audioPromise;
        if (requestId !== requestIdRef.current) {
          return;
        }
        if (!audio) {
          continue;
        }
        primeItems(queue, requestId);
        if (!(await playAudioUrl(audio.audioUrl, requestId))) {
          return;
        }
      }
    } finally {
      if (queueRef.current !== queue) {
        return;
      }

      queue.playing = false;
      if (requestId === requestIdRef.current && queue.items.length > 0) {
        void drainQueue(requestId);
      } else {
        completePlaybackIfReady(requestId);
      }
    }
  };

  const completePlaybackIfReady = (requestId: number): void => {
    const queue = queueRef.current;
    if (
      !shouldCompleteVoiceReply({
        currentRequest: requestId === requestIdRef.current,
        finalized: replyFinalizedRef.current,
        notified: completionNotifiedRef.current,
        playing: queue.playing,
        queuedItems: queue.items.length
      })
    ) {
      return;
    }

    completionNotifiedRef.current = true;
    releaseSubtitle(requestId);
    releaseExpression(requestId);
    optionsRef.current.onPlaybackDrained(restartAfterReplyRef.current);
    restartAfterReplyRef.current = false;
  };

  const enqueuePreparedSegments = (
    segments: Array<{ segment: string; audio?: VoiceReplyAudio }>,
    requestId: number
  ): void => {
    const filtered = segments
      .map(({ segment, audio }) => ({ segment: normalizeVoiceReplyText(segment), audio }))
      .filter((item) => item.segment);

    if (!filtered.length || requestId !== requestIdRef.current) {
      return;
    }

    if (pendingExpressionRef.current) {
      if (holdExpression(requestId, pendingExpressionRef.current)) {
        pendingExpressionRef.current = undefined;
      }
    }

    queueRef.current.queuedVoiceSegments.push(...filtered.map(({ segment }) => segment));
    queueRef.current.items.push(
      ...filtered.map(({ segment, audio }) => ({
        segment,
        audioPromise: audio ? Promise.resolve(audio) : undefined
      }))
    );
    primeItems(queueRef.current, requestId);

    if (queueRef.current.playbackBlocked) {
      watchFirstQueuedItem(requestId);
    } else {
      void drainQueue(requestId);
    }
  };

  const enqueueSegments = (segments: string[], requestId: number): void => {
    enqueuePreparedSegments(segments.map((segment) => ({ segment })), requestId);
  };

  const enqueueStreamingText = (
    voiceText: string,
    requestId = requestIdRef.current
  ): void => {
    if (requestId !== requestIdRef.current || !voiceReplyEnabledRef.current) {
      return;
    }

    enqueueSegments(streamingCommitterRef.current.append(voiceText), requestId);
  };

  const enqueueFinalText = (voiceText: string, requestId = requestIdRef.current): void => {
    if (requestId !== requestIdRef.current || !voiceReplyEnabledRef.current) {
      return;
    }

    enqueueSegments(streamingCommitterRef.current.finalize(voiceText), requestId);
  };

  const stop = (stopOptions?: { clearPresentation?: boolean }): void => {
    const voiceSessionId = voiceSessionIdRef.current;
    if (stopOptions?.clearPresentation ?? true) {
      if (subtitleHoldRef.current?.active) {
        optionsRef.current.subtitle.hide();
      }
      if (expressionHoldRef.current?.active) {
        optionsRef.current.triggerExpression("normal", "high", 1800);
      }
    }
    requestIdRef.current += 1;
    voiceConfigurationErrorRequestRef.current = undefined;
    voiceErrorReportedRequestRef.current = undefined;
    syncRevealRef.current = undefined;
    subtitleHoldRef.current = undefined;
    expressionHoldRef.current = undefined;
    pendingExpressionRef.current = undefined;
    restartAfterReplyRef.current = false;
    replyFinalizedRef.current = true;
    completionNotifiedRef.current = false;
    voiceReplyEnabledRef.current = false;
    voiceSessionIdRef.current = undefined;
    presetLineAudioRef.current?.pause();
    presetLineAudioRef.current = null;
    presetLineRequestRef.current += 1;
    if (presetLineUrlRef.current) {
      window.URL.revokeObjectURL(presetLineUrlRef.current);
      presetLineUrlRef.current = undefined;
    }
    voiceReplyAudioRef.current?.pause();
    activePlaybackCancelRef.current?.();
    activePlaybackCancelRef.current = undefined;
    voiceReplyAudioRef.current = null;
    queueRef.current = createEmptyQueue();
    streamingCommitterRef.current = new StreamingVoiceCommitter();

    if (voiceReplyUrlRef.current) {
      window.URL.revokeObjectURL(voiceReplyUrlRef.current);
      voiceReplyUrlRef.current = undefined;
    }
    for (const audioUrl of pendingUrlsRef.current) {
      window.URL.revokeObjectURL(audioUrl);
    }
    pendingUrlsRef.current.clear();
    void window.desktopPet?.textToSpeech
      .stop({ petId: optionsRef.current.petId, sessionId: voiceSessionId })
      .catch(() => undefined);
  };
  useLayoutEffect(() => {
    optionsRef.current = options;
    stopRef.current = stop;
  });

  useEffect(
    () => () => stopRef.current({ clearPresentation: false }),
    []
  );

  useEffect(() => {
    const stopWhenHidden = (): void => {
      if (document.hidden) {
        stopRef.current();
      }
    };
    const stopOnPageHide = (): void => stopRef.current();
    document.addEventListener("visibilitychange", stopWhenHidden);
    window.addEventListener("pagehide", stopOnPageHide);
    return () => {
      document.removeEventListener("visibilitychange", stopWhenHidden);
      window.removeEventListener("pagehide", stopOnPageHide);
    };
  }, []);

  const beginReply = (
    pendingMessageId: number,
    synchronized: boolean,
    voiceReplyEnabled: boolean,
    sessionId?: string
  ): number => {
    stop();
    const requestId = requestIdRef.current;
    replyFinalizedRef.current = false;
    completionNotifiedRef.current = false;
    voiceReplyEnabledRef.current = voiceReplyEnabled;
    voiceSessionIdRef.current = voiceReplyEnabled ? (sessionId ?? `voice-session-${requestId}`) : undefined;
    queueRef.current.playbackBlocked = synchronized;
    syncRevealRef.current = synchronized
      ? {
          requestId,
          pendingMessageId,
          latestContent: "",
          revealed: false,
          firstAudioSettled: false,
          watchingFirstAudio: false
        }
      : undefined;
    return requestId;
  };

  const playPresetLineAudio = async (targetId: string): Promise<void> => {
    const normalizedTargetId = targetId.trim();
    if (!normalizedTargetId || voiceReplyAudioRef.current || queueRef.current.playing) {
      return;
    }
    const requestSequence = ++presetLineRequestRef.current;
    presetLineAudioRef.current?.pause();
    if (presetLineUrlRef.current) {
      window.URL.revokeObjectURL(presetLineUrlRef.current);
      presetLineUrlRef.current = undefined;
    }
    const response = await window.desktopPet?.presetVoice.load({
      petId: optionsRef.current.petId,
      targetId: normalizedTargetId
    }).catch(() => undefined);
    if (
      requestSequence !== presetLineRequestRef.current ||
      !response?.ok || !response.audioBase64 ||
      voiceReplyAudioRef.current || queueRef.current.playing
    ) {
      return;
    }
    const created = createVoiceReplyAudioSafely(response.audioBase64, response.mimeType ?? "audio/wav");
    if (!created) return;
    presetLineUrlRef.current = created.audioUrl;
    const audio = new Audio(created.audioUrl);
    presetLineAudioRef.current = audio;
    const cleanup = (): void => {
      if (presetLineAudioRef.current === audio) {
        presetLineAudioRef.current = null;
      }
      if (presetLineUrlRef.current === created.audioUrl) {
        window.URL.revokeObjectURL(created.audioUrl);
        presetLineUrlRef.current = undefined;
      }
    };
    audio.addEventListener("ended", cleanup, { once: true });
    audio.addEventListener("error", cleanup, { once: true });
    try {
      await audio.play();
    } catch {
      cleanup();
    }
  };

  const awaitSynchronizedPlaybackStart = async (requestId: number): Promise<boolean> => {
    watchFirstQueuedItem(requestId);
    const firstItem = queueRef.current.items[0];
    if (firstItem) {
      firstItem.audioPromise ??= synthesizeSegment(firstItem.segment, requestId);
      await firstItem.audioPromise;
    }
    if (requestId !== requestIdRef.current) {
      return false;
    }
    queueRef.current.playbackBlocked = false;
    void drainQueue(requestId);
    return true;
  };

  return {
    awaitSynchronizedPlaybackStart,
    beginReply,
    cancelSynchronizedReveal: () => {
      syncRevealRef.current = undefined;
      queueRef.current.playbackBlocked = false;
    },
    clearPendingExpression: () => {
      pendingExpressionRef.current = undefined;
    },
    completeSynchronizedReveal: () => {
      syncRevealRef.current = undefined;
    },
    enqueueStreamingText,
    enqueueFinalText,
    hasActiveAudio,
    hasCommittedSpeech: () => queueRef.current.queuedVoiceSegments.length > 0,
    holdExpression,
    finalizeReply: (requestId: number, restartAfterReply: boolean) => {
      if (requestId !== requestIdRef.current) {
        return;
      }
      restartAfterReplyRef.current = restartAfterReply;
      replyFinalizedRef.current = true;
      completePlaybackIfReady(requestId);
    },
    holdSubtitle: (requestId: number) => {
      subtitleHoldRef.current = { requestId, active: true };
    },
    isPlaybackBlocked: () => queueRef.current.playbackBlocked,
    isSubtitleHeld: () =>
      Boolean(
        subtitleHoldRef.current?.active &&
          subtitleHoldRef.current.requestId === requestIdRef.current
      ),
    playPresetLineAudio,
    releaseSubtitle,
    setPendingExpression: (expression?: PetExpressionKey) => {
      pendingExpressionRef.current = expression;
    },
    stop,
    updateSynchronizedContent: (content: string) => {
      const revealState = syncRevealRef.current;
      if (revealState?.requestId === requestIdRef.current) {
        revealState.latestContent = content;
        if (revealState.revealed) {
          optionsRef.current.onSynchronizedReveal(
            revealState.pendingMessageId,
            revealState.latestContent
          );
        }
      }
    }
  };
}
