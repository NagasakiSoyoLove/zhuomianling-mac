import {
  MAX_SCREEN_MONITOR_OUTPUT_CHARACTERS,
  compactScreenReply,
  parseScreenMonitorDecision
} from "../../../shared/screenVision";
import type {
  ScreenMonitorAction,
  ScreenMonitorDecision,
  ScreenMonitorEvent
} from "../../../shared/types/screen";

export interface ScreenMonitorStreamAppendResult {
  overflowed: boolean;
}

export interface ScreenMonitorStreamEarlyResult {
  action: ScreenMonitorAction;
  decision?: ScreenMonitorDecision;
}

interface PartialMonitorFields {
  action?: ScreenMonitorAction;
  event?: string;
  sceneKey?: string;
  reply?: string;
  voiceText?: string;
  emotion?: string;
}

interface ReadJsonStringResult {
  complete: boolean;
  value?: string;
  nextIndex?: number;
}

const monitorEvents = new Set<ScreenMonitorEvent>([
  "app-switch",
  "page-change",
  "content-change",
  "same-scene",
  "uncertain"
]);

function readJsonString(source: string, startIndex: number): ReadJsonStringResult {
  if (source[startIndex] !== '"') return { complete: false };
  let escaped = false;
  for (let index = startIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character !== '"') continue;
    try {
      const value = JSON.parse(source.slice(startIndex, index + 1)) as unknown;
      return typeof value === "string"
        ? { complete: true, value, nextIndex: index + 1 }
        : { complete: false };
    } catch {
      return { complete: false };
    }
  }
  return { complete: false };
}

function skipJsonComposite(source: string, startIndex: number): ReadJsonStringResult {
  const opening = source[startIndex];
  if (opening !== "{" && opening !== "[") return { complete: false };
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === opening) depth += 1;
    if (character === closing) {
      depth -= 1;
      if (depth === 0) return { complete: true, nextIndex: index + 1 };
    }
  }
  return { complete: false };
}

function skipWhitespace(source: string, startIndex: number): number {
  let index = startIndex;
  while (index < source.length && /\s/u.test(source[index] ?? "")) index += 1;
  return index;
}

function skipJsonValue(source: string, startIndex: number): ReadJsonStringResult {
  if (source[startIndex] === '"') return readJsonString(source, startIndex);
  if (source[startIndex] === "{" || source[startIndex] === "[") {
    return skipJsonComposite(source, startIndex);
  }
  for (let index = startIndex; index < source.length; index += 1) {
    if (source[index] === "," || source[index] === "}") {
      return { complete: true, nextIndex: index };
    }
  }
  return { complete: false };
}

/**
 * TIMED DIAGNOSTICS TEST MODULE: only inspect a strict JSON-first prefix for
 * early completion. Reasoning or prose prefixes intentionally stay on the
 * full-response path to avoid accepting a quoted example as a decision.
 */
function readPartialMonitorFields(raw: string): PartialMonitorFields | undefined {
  let source = raw.replace(/^\uFEFF/u, "").trimStart();
  const fence = source.match(/^```(?:json|text)?\s*/iu);
  if (fence) source = source.slice(fence[0].length).trimStart();
  if (!source.startsWith("{")) return undefined;

  const fields: PartialMonitorFields = {};
  let index = 1;
  while (true) {
    index = skipWhitespace(source, index);
    if (index >= source.length || source[index] === "}") return fields;
    if (source[index] !== '"') return undefined;

    const key = readJsonString(source, index);
    if (!key.complete || key.value === undefined || key.nextIndex === undefined) return fields;
    index = skipWhitespace(source, key.nextIndex);
    if (index >= source.length) return fields;
    if (source[index] !== ":") return undefined;
    index = skipWhitespace(source, index + 1);
    if (index >= source.length) return fields;

    const value = skipJsonValue(source, index);
    if (!value.complete || value.nextIndex === undefined) return fields;
    if (value.value !== undefined) {
      if (key.value === "action" && (value.value === "silent" || value.value === "speak")) {
        fields.action = value.value;
      } else if (key.value === "event") {
        fields.event = value.value;
      } else if (key.value === "sceneKey") {
        fields.sceneKey = value.value;
      } else if (key.value === "reply") {
        fields.reply = value.value;
      } else if (key.value === "voiceText") {
        fields.voiceText = value.value;
      } else if (key.value === "emotion") {
        fields.emotion = value.value;
      }
    }
    index = skipWhitespace(source, value.nextIndex);
    if (index >= source.length) return fields;
    if (source[index] === "}") return fields;
    if (source[index] !== ",") return undefined;
    index += 1;
  }
}

/**
 * Accumulates a monitor decision without exposing provider output to the
 * renderer. Full responses remain strictly validated; a conservative
 * JSON-first prefix may produce a minimum decision for the main process.
 */
export class ScreenMonitorStreamNormalizer {
  private raw = "";
  private overflowed = false;

  public append(delta: string): ScreenMonitorStreamAppendResult {
    if (this.overflowed) return { overflowed: true };
    if (typeof delta !== "string" || !delta) return { overflowed: false };

    if (this.raw.length + delta.length > MAX_SCREEN_MONITOR_OUTPUT_CHARACTERS) {
      this.overflowed = true;
      return { overflowed: true };
    }
    this.raw += delta;
    return { overflowed: this.overflowed };
  }

  public finalize(
    expectedSceneKey: string,
    options: { requireVoiceText?: boolean } = {}
  ): ScreenMonitorDecision | undefined {
    if (this.overflowed) return undefined;
    return parseScreenMonitorDecision(this.raw, expectedSceneKey, options);
  }

  public getEarlyResult(
    expectedSceneKey: string,
    options: {
      fallbackEvent: ScreenMonitorEvent;
      requireVoiceText?: boolean;
    }
  ): ScreenMonitorStreamEarlyResult | undefined {
    if (this.overflowed) return undefined;
    const fields = readPartialMonitorFields(this.raw);
    if (!fields?.action) return undefined;

    const result: ScreenMonitorStreamEarlyResult = { action: fields.action };
    const sceneKey = fields.sceneKey ?? expectedSceneKey;
    if (fields.sceneKey !== undefined && fields.sceneKey !== expectedSceneKey) return result;
    const event = fields.event && monitorEvents.has(fields.event as ScreenMonitorEvent)
      ? fields.event as ScreenMonitorEvent
      : options.fallbackEvent;

    if (fields.action === "silent") {
      result.decision = {
        action: "silent",
        event,
        sceneKey,
        reply: ""
      };
      return result;
    }

    const reply = fields.reply?.trim() ?? "";
    if (!reply || reply.length > 2_000) return result;
    const voiceText = fields.voiceText?.trim() ?? "";
    if (options.requireVoiceText && !voiceText) return result;
    if (voiceText.length > 4_000 || (fields.emotion?.trim().length ?? 0) > 128) return result;

    result.decision = {
      action: "speak",
      event,
      sceneKey,
      reply: compactScreenReply(reply),
      ...(voiceText ? { voiceText: compactScreenReply(voiceText) } : {}),
      ...(fields.emotion?.trim() ? { emotion: fields.emotion.trim() } : {})
    };
    return result;
  }

  public hasContent(): boolean {
    return Boolean(this.raw.trim());
  }
}
