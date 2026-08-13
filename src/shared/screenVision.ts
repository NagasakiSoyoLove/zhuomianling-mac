import type {
  ScreenMonitorDecision,
  ScreenObservation,
  ScreenMonitorEvent,
  ScreenQuestionObservation
} from "./types/screen";

export const MAX_SCREEN_MONITOR_OUTPUT_CHARACTERS = 32 * 1024;
export const MAX_SCREEN_OBSERVATION_OUTPUT_CHARACTERS = 8 * 1024;
export const MAX_CONCISE_SCREEN_REPLY_CHARACTERS = 96;
export const MAX_MEDIUM_SCREEN_REPLY_CHARACTERS = 180;
export const MAX_LONG_SCREEN_REPLY_CHARACTERS = 280;
export const MAX_DETAILED_SCREEN_REPLY_CHARACTERS = 600;
const MAX_MODEL_OUTPUT_CHARACTERS = MAX_SCREEN_MONITOR_OUTPUT_CHARACTERS;
const maxObservationKeyPoints = 5;
const maxObservationKeyPointCharacters = 240;
const maxObservationUncertainPoints = 2;
const maxObservationUncertainPointCharacters = 180;
const maxQuestionSubjectCharacters = 240;
const maxQuestionActivityCharacters = 240;
const maxQuestionVisibleTextCharacters = 360;
const maxQuestionAnswerFocusCharacters = 240;
const sceneKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const monitorDecisionFields = new Set([
  "action",
  "event",
  "sceneKey",
  "reply",
  "voiceText",
  "emotion"
]);
const events = new Set<ScreenMonitorEvent>([
  "app-switch",
  "page-change",
  "content-change",
  "same-scene",
  "uncertain"
]);

function stripReasoning(value: string): string {
  return value
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .replace(/```(?:json|text)?/gi, "")
    .replace(/```/g, "")
    .trim();
}

function extractLastJsonObject(value: string): Record<string, unknown> | undefined {
  const source = stripReasoning(value).slice(0, MAX_MODEL_OUTPUT_CHARACTERS);
  let latest: Record<string, unknown> | undefined;
  for (let start = source.lastIndexOf("{"); start >= 0;) {
    for (let end = source.indexOf("}", start + 1); end >= 0; end = source.indexOf("}", end + 1)) {
      try {
        const parsed: unknown = JSON.parse(source.slice(start, end + 1));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          latest = parsed as Record<string, unknown>;
          break;
        }
      } catch {
        // Continue searching for the last complete object in a bounded buffer.
      }
    }
    if (latest) break;
    if (start === 0) break;
    start = source.lastIndexOf("{", start - 1);
  }
  return latest;
}

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function boundedStringList(value: unknown, maxItems: number, maxCharacters: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const normalized = boundedString(item, maxCharacters);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maxItems) break;
  }
  return result;
}

function safeSceneKey(value: unknown): string {
  const candidate = boundedString(value, 128);
  return sceneKeyPattern.test(candidate) ? candidate : "scene-uncertain";
}

export function normalizeScreenVisionText(value: string): string {
  return stripReasoning(value)
    .replace(/[ \t]+/g, " ")
    .replace(/\r?\n+/g, "\n")
    .trim()
    .slice(0, MAX_MODEL_OUTPUT_CHARACTERS);
}

/**
 * Screen replies are displayed directly in the pet bubble. Keep the default
 * presentation conclusion-first and bounded even when a provider ignores the
 * concise-response instruction. The sentence boundary preserves a usable
 * thought; an ellipsis is only used when the first thought itself is too long.
 */
export function compactScreenReply(
  value: string,
  maxCharacters = MAX_CONCISE_SCREEN_REPLY_CHARACTERS
): string {
  const normalized = normalizeScreenVisionText(value).replace(/\s+/g, " ").trim();
  const limit = Math.max(1, Math.floor(maxCharacters));
  if (!normalized) return "";
  const characters = Array.from(normalized);
  if (characters.length <= limit) return normalized;

  const sentences = normalized.match(/[^。！？!?；;]+[。！？!?；;]?/gu) ?? [];
  let compact = "";
  for (const sentence of sentences) {
    const candidate = `${compact}${sentence.trim()}`;
    if (Array.from(candidate).length > limit) break;
    compact = candidate;
    if (/[。！？!?]$/u.test(sentence.trim())) break;
  }
  if (compact) return compact.trim();
  return `${characters.slice(0, Math.max(1, limit - 1)).join("")}…`;
}

/**
 * Direct screen questions must still answer, but a concise answer should not
 * turn into a report merely because the model returned several short
 * sentences. Keep the conclusion-first prefix and at most two sentences.
 */
export function compactDirectScreenReply(
  value: string,
  maxCharacters = MAX_CONCISE_SCREEN_REPLY_CHARACTERS
): string {
  const normalized = normalizeScreenVisionText(value).replace(/\s+/g, " ").trim();
  const limit = Math.max(1, Math.floor(maxCharacters));
  if (!normalized) return "";

  const characters = Array.from(normalized);
  const sentences = normalized.match(/[^。！？!?；;]+[。！？!?；;]?/gu) ?? [];
  let compact = "";
  let sentenceCount = 0;
  for (const sentence of sentences) {
    const candidate = `${compact}${sentence.trim()}`;
    if (Array.from(candidate).length > limit) break;
    compact = candidate;
    if (/[。！？!?]$/u.test(sentence.trim())) {
      sentenceCount += 1;
      if (sentenceCount >= 2) break;
    }
  }

  if (compact) return compact.trim();
  return `${characters.slice(0, Math.max(1, limit - 1)).join("")}…`;
}

export function parseScreenObservation(raw: string, observedAt = new Date().toISOString()): ScreenObservation | undefined {
  if (raw.length > MAX_SCREEN_OBSERVATION_OUTPUT_CHARACTERS) return undefined;
  const parsed = extractLastJsonObject(raw);
  if (!parsed) return undefined;
  const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
    ? Math.min(1, Math.max(0, parsed.confidence))
    : undefined;
  if (confidence === undefined) return undefined;
  const sceneKey = safeSceneKey(parsed.sceneKey);
  const activity = boundedString(parsed.activity, 240);
  const changeSummary = boundedString(parsed.changeSummary, 360);
  const visibleTextSummary = boundedString(parsed.visibleTextSummary, 360);
  const keyPoints = boundedStringList(parsed.keyPoints, maxObservationKeyPoints, maxObservationKeyPointCharacters);
  if (!activity || !changeSummary) return undefined;
  return {
    sceneKey,
    activity,
    changeSummary,
    visibleTextSummary,
    keyPoints: keyPoints.length
      ? keyPoints
      : [changeSummary, visibleTextSummary].filter(Boolean).slice(0, maxObservationKeyPoints),
    confidence,
    observedAt
  };
}

export function parseScreenQuestionObservation(
  raw: string,
  observedAt = new Date().toISOString()
): ScreenQuestionObservation | undefined {
  if (raw.length > MAX_SCREEN_OBSERVATION_OUTPUT_CHARACTERS) return undefined;
  const parsed = extractLastJsonObject(raw);
  if (!parsed) return undefined;
  const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
    ? Math.min(1, Math.max(0, parsed.confidence))
    : undefined;
  if (confidence === undefined) return undefined;
  const keyPoints = boundedStringList(parsed.keyPoints, maxObservationKeyPoints, maxObservationKeyPointCharacters);
  const uncertainPoints = boundedStringList(
    parsed.uncertainPoints,
    maxObservationUncertainPoints,
    maxObservationUncertainPointCharacters
  );
  if (!keyPoints.length && !uncertainPoints.length) return undefined;
  const subject = boundedString(parsed.subject, maxQuestionSubjectCharacters);
  const activity = boundedString(parsed.activity, maxQuestionActivityCharacters);
  const visibleTextSummary = boundedString(parsed.visibleTextSummary, maxQuestionVisibleTextCharacters);
  const answerFocus = boundedString(parsed.answerFocus, maxQuestionAnswerFocusCharacters) || keyPoints[0] || "";
  return {
    subject,
    activity,
    visibleTextSummary,
    answerFocus,
    keyPoints,
    uncertainPoints,
    confidence,
    observedAt
  };
}

export function parseScreenMonitorDecision(
  raw: string,
  expectedSceneKey?: string,
  options: { requireVoiceText?: boolean } = {}
): ScreenMonitorDecision | undefined {
  if (raw.length > MAX_SCREEN_MONITOR_OUTPUT_CHARACTERS) return undefined;
  const parsed = extractLastJsonObject(raw);
  if (!parsed || (parsed.action !== "speak" && parsed.action !== "silent")) return undefined;

  if (Object.keys(parsed).some((key) => !monitorDecisionFields.has(key))) return undefined;

  const event = typeof parsed.event === "string" && events.has(parsed.event as ScreenMonitorEvent)
    ? parsed.event as ScreenMonitorEvent
    : "uncertain";
  if (typeof parsed.sceneKey !== "string") return undefined;
  const sceneKeyValue = parsed.sceneKey.trim();
  const sceneKey = expectedSceneKey !== undefined
    ? parsed.sceneKey
    : safeSceneKey(sceneKeyValue);
  if (!sceneKeyPattern.test(sceneKey)) return undefined;
  if (expectedSceneKey !== undefined && (!sceneKeyPattern.test(expectedSceneKey) || sceneKey !== expectedSceneKey)) {
    return undefined;
  }

  if (typeof parsed.reply !== "string") return undefined;
  const rawReply = parsed.reply.trim();
  if (rawReply.length > 2_000) return undefined;
  const reply = compactScreenReply(rawReply);
  if (reply.length > 2_000) return undefined;

  for (const field of ["voiceText", "emotion"] as const) {
    if (field in parsed && typeof parsed[field] !== "string") return undefined;
    if (typeof parsed[field] === "string" && parsed[field].trim().length > (field === "voiceText" ? 4_000 : 128)) {
      return undefined;
    }
  }

  if (parsed.action === "speak" && !reply) return undefined;
  const voiceText = typeof parsed.voiceText === "string" ? compactScreenReply(parsed.voiceText) : "";
  const emotion = typeof parsed.emotion === "string" ? parsed.emotion.trim() : "";
  if (parsed.action === "speak" && options.requireVoiceText && !voiceText) return undefined;
  if (parsed.action === "silent") {
    return {
      action: "silent",
      event,
      sceneKey,
      reply: ""
    };
  }

  return {
    action: parsed.action,
    event,
    sceneKey,
    reply,
    ...(voiceText ? { voiceText } : {}),
    ...(emotion ? { emotion } : {})
  };
}

export function parseDirectScreenReply(raw: string): string | undefined {
  const normalized = normalizeScreenVisionText(raw);
  const parsed = extractLastJsonObject(normalized);
  if (parsed && typeof parsed.reply === "string") {
    const reply = boundedString(parsed.reply, 4_000);
    return reply || undefined;
  }
  if (!normalized || /^\s*[[{]/.test(normalized) || /\b(?:action|sceneKey|changeSummary)\s*:/i.test(normalized)) {
    return undefined;
  }
  return normalized.slice(0, 4_000);
}
