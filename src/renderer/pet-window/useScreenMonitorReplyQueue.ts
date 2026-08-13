import { useEffect, useLayoutEffect, useRef } from "react";
import type {
  ScreenMonitorReplyDeliveryStatus,
  ScreenVisionPresentationKind
} from "../../shared/types/screen";
import type { UseVoiceReplyQueueResult } from "./useVoiceReplyQueue";

export interface ScreenMonitorReplyQueueItem {
  sessionId: string;
  replyId: string;
  reply: string;
  voiceText?: string;
  emotion?: string;
  presentationKind?: ScreenVisionPresentationKind;
}

interface QueueItem extends ScreenMonitorReplyQueueItem {
  delivery: "analyzed" | ScreenMonitorReplyDeliveryStatus;
  voiceRequestId?: number;
}

interface UseScreenMonitorReplyQueueOptions {
  petId: string;
  voiceReply: UseVoiceReplyQueueResult;
  presentReply: (
    reply: string,
    options: {
      showInChat: false;
      voiceText?: string;
      emotion?: string;
      presentationKind?: ScreenVisionPresentationKind;
      voiceSessionId?: string;
      onStarted?: (requestId: number) => void;
    }
  ) => Promise<number | false>;
  clearPresentation: (requestId?: number) => void;
  /** True while normal chat, voice playback, or another subtitle owns the output. */
  isPlaybackOccupied: () => boolean;
}

export interface UseScreenMonitorReplyQueueResult {
  enqueue: (item: ScreenMonitorReplyQueueItem) => void;
  cancel: () => void;
}

const retryDelayMs = 160;

function normalizeItem(item: ScreenMonitorReplyQueueItem): QueueItem | undefined {
  const reply = item.reply.trim().slice(0, 4_000);
  if (!item.sessionId || !item.replyId || !reply) return undefined;
  const voiceText = item.voiceText?.trim().slice(0, 4_000);
  const emotion = item.emotion?.trim().slice(0, 128);
  return {
    sessionId: item.sessionId,
    replyId: item.replyId,
    reply,
    ...(voiceText ? { voiceText } : {}),
    ...(emotion ? { emotion } : {}),
    ...(item.presentationKind ? { presentationKind: item.presentationKind } : {}),
    delivery: "analyzed"
  };
}

export function useScreenMonitorReplyQueue(
  options: UseScreenMonitorReplyQueueOptions
): UseScreenMonitorReplyQueueResult {
  const optionsRef = useRef(options);
  const currentRef = useRef<QueueItem>();
  const pendingRef = useRef<QueueItem>();
  const generationRef = useRef(0);
  const pumpingRef = useRef(false);
  const pumpRef = useRef<() => Promise<void>>(async () => undefined);

  useLayoutEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const report = (item: QueueItem, status: ScreenMonitorReplyDeliveryStatus): void => {
    window.desktopPet?.screenMonitor.reportReplyStatus({
      petId: optionsRef.current.petId,
      sessionId: item.sessionId,
      replyId: item.replyId,
      status
    });
  };

  const accept = (item: QueueItem): void => {
    if (item.delivery !== "analyzed") return;
    item.delivery = "accepted";
    report(item, "accepted");
  };

  const drop = (item: QueueItem | undefined): void => {
    if (!item || item.delivery === "dropped" || item.delivery === "played") return;
    item.delivery = "dropped";
    report(item, "dropped");
  };

  const waitForRetry = (): Promise<void> => new Promise((resolve) => {
    window.setTimeout(resolve, retryDelayMs);
  });

  const pump = async (): Promise<void> => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    const startGeneration = generationRef.current;
    try {
      while (startGeneration === generationRef.current) {
        const current = currentRef.current;
        if (!current) return;

        while (
          startGeneration === generationRef.current &&
          currentRef.current === current &&
          optionsRef.current.isPlaybackOccupied()
        ) {
          await optionsRef.current.voiceReply.waitForIdle();
          if (optionsRef.current.isPlaybackOccupied()) await waitForRetry();
        }
        if (startGeneration !== generationRef.current || currentRef.current !== current) return;

        let startedRequestId: number | undefined;
        let presentationRequest: Promise<number | false>;
        try {
          presentationRequest = optionsRef.current.presentReply(current.reply, {
            showInChat: false,
            ...(current.voiceText ? { voiceText: current.voiceText } : {}),
            ...(current.emotion ? { emotion: current.emotion } : {}),
            ...(current.presentationKind ? { presentationKind: current.presentationKind } : {}),
            voiceSessionId: current.replyId,
            onStarted: (requestId) => {
              startedRequestId = requestId;
              current.voiceRequestId = requestId;
            }
          });
        } catch {
          presentationRequest = Promise.resolve(false);
        }

        const requestId = await presentationRequest;
        if (startGeneration !== generationRef.current || currentRef.current !== current) {
          if (startedRequestId !== undefined) {
            optionsRef.current.voiceReply.stopForRequest(startedRequestId, { clearPresentation: true });
          }
          return;
        }
        if (requestId === false || startedRequestId === undefined) {
          drop(current);
          currentRef.current = undefined;
          const next = pendingRef.current;
          pendingRef.current = undefined;
          if (next) currentRef.current = next;
          continue;
        }

        const played = await optionsRef.current.voiceReply.waitForPlaybackDrained(requestId);
        if (startGeneration !== generationRef.current || currentRef.current !== current) return;
        if (!played) {
          drop(current);
          currentRef.current = undefined;
          const next = pendingRef.current;
          pendingRef.current = undefined;
          if (next) currentRef.current = next;
          continue;
        }

        current.delivery = "played";
        report(current, "played");
        currentRef.current = undefined;
        const next = pendingRef.current;
        pendingRef.current = undefined;
        if (next) currentRef.current = next;
      }
    } finally {
      pumpingRef.current = false;
      if (currentRef.current && startGeneration === generationRef.current) {
        void pumpRef.current();
      }
    }
  };
  pumpRef.current = pump;

  const enqueue = (item: ScreenMonitorReplyQueueItem): void => {
    const next = normalizeItem(item);
    if (!next) return;
    accept(next);
    const current = currentRef.current;
    if (!current) {
      currentRef.current = next;
      void pumpRef.current();
      return;
    }

    drop(pendingRef.current);
    pendingRef.current = next;
  };

  const cancel = (): void => {
    generationRef.current += 1;
    const current = currentRef.current;
    const pending = pendingRef.current;
    currentRef.current = undefined;
    pendingRef.current = undefined;
    if (current?.voiceRequestId !== undefined) {
      optionsRef.current.clearPresentation(current.voiceRequestId);
      optionsRef.current.voiceReply.stopForRequest(current.voiceRequestId, { clearPresentation: true });
    }
    drop(current);
    drop(pending);
  };

  useEffect(() => () => cancel(), []);

  return { enqueue, cancel };
}
