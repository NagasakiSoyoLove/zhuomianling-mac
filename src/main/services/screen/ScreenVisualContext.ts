import type {
  ScreenAwarenessMode,
  ScreenFrame,
  ScreenMonitorDecision,
  ScreenMonitorEvent,
  ScreenObservation
} from "../../../shared/types/screen";

/**
 * The monitor keeps a small, session-only visual history. This is deliberately
 * not part of the shared IPC DTOs or the ordinary chat context.
 */
export const SCREEN_VISUAL_CONTEXT_LIMIT = 6 as const;

export interface ScreenVisualContextFrame {
  data: Uint8Array;
  mimeType: ScreenFrame["mimeType"];
  width: number;
  height: number;
  capturedAt: number;
}

export interface ScreenVisualContextDecision {
  action: ScreenMonitorDecision["action"];
  event: ScreenMonitorDecision["event"];
  sceneKey: string;
  reply: string;
}

export interface ScreenVisualContextEntry {
  /** Only replies that reached the played state may enter this context. */
  delivery: "played";
  mode: ScreenAwarenessMode;
  event: ScreenMonitorEvent;
  sceneKey: string;
  frame: ScreenVisualContextFrame;
  observation?: ScreenObservation;
  decision: ScreenVisualContextDecision;
}

function copyFrame(frame: ScreenFrame): ScreenVisualContextFrame {
  return {
    data: new Uint8Array(frame.data),
    mimeType: frame.mimeType,
    width: frame.width,
    height: frame.height,
    capturedAt: frame.capturedAt
  };
}

function copyDecision(decision: ScreenMonitorDecision): ScreenVisualContextDecision {
  return {
    action: decision.action,
    event: decision.event,
    sceneKey: decision.sceneKey,
    reply: decision.reply.slice(0, 4_000)
  };
}

export function createScreenVisualContextEntry(
  frame: ScreenFrame,
  mode: ScreenAwarenessMode,
  candidate: { event: ScreenMonitorEvent; sceneKey: string },
  decision: ScreenMonitorDecision,
  observation?: ScreenObservation
): ScreenVisualContextEntry {
  return {
    delivery: "played",
    mode,
    event: candidate.event,
    sceneKey: candidate.sceneKey,
    frame: copyFrame(frame),
    ...(observation ? { observation } : {}),
    decision: copyDecision(decision)
  };
}

export function appendScreenVisualContext(
  history: ScreenVisualContextEntry[],
  entry: ScreenVisualContextEntry
): void {
  history.push(entry);
  if (history.length > SCREEN_VISUAL_CONTEXT_LIMIT) {
    history.splice(0, history.length - SCREEN_VISUAL_CONTEXT_LIMIT);
  }
}

/**
 * Selects the only history records that are allowed to reach a later monitor
 * analysis. The delivery field is intentionally checked again at this
 * boundary so a future caller cannot accidentally put an accepted or dropped
 * reply into the model context.
 */
export function selectPlayedScreenVisualContext(
  history: readonly ScreenVisualContextEntry[]
): ScreenVisualContextEntry[] {
  return history
    .filter((entry) => entry.delivery === "played")
    .slice(-SCREEN_VISUAL_CONTEXT_LIMIT);
}

export function clearScreenVisualContext(history: ScreenVisualContextEntry[]): void {
  history.splice(0, history.length);
}
