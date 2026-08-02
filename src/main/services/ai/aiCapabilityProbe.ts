import {
  maxAiReplyInputCharacters,
  parseFinalAiReply
} from "../../../shared/aiReply";
import type {
  AiChatMessage,
  AiOutputCapability,
  AiOutputMode
} from "../../../shared/types/ai";
import {
  buildAiChatRequestBody,
  buildChatCompletionsUrl,
  canFallbackAiOutputMode
} from "./aiProtocol";
import { getAiProtocolTierForMode } from "../../../shared/aiContract";
import { createAiReplyContract } from "../../../shared/aiContract";

export interface AiCapabilityProbeResult {
  capability: AiOutputCapability;
  tested: boolean;
  failureKind?: "authentication" | "rate-limit" | "server" | "network" | "invalid-response";
  status?: number;
}

const structuredProbeModes: AiOutputMode[] = ["json-schema", "json-object", "prompt-json"];
const probeAttempts: Array<{ mode: AiOutputMode; streaming: boolean }> = [
  ...structuredProbeModes.flatMap((mode) => [
    { mode, streaming: true },
    { mode, streaming: false }
  ]),
  { mode: "plain-text", streaming: true },
  { mode: "plain-text", streaming: false }
];
const structuredProbeMessages: AiChatMessage[] = [
  {
    role: "system",
    content: "这是固定连接能力测试。只返回 JSON，不要输出推理、Markdown 或解释。必须且只能返回 reply 和 moodDelta。"
  },
  {
    role: "user",
    content: "将 reply 设置为 probe-ok，将 moodDelta 设置为 0。"
  }
];
const textProbeMessages: AiChatMessage[] = [
  {
    role: "system",
    content: "这是固定连接能力测试。只返回普通文字 probe-ok，不要输出 JSON、推理、Markdown 或解释。"
  },
  {
    role: "user",
    content: "回复 probe-ok。"
  }
];
const probeRequestTimeoutMs = 12_000;
const probeTotalTimeoutMs = 120_000;

async function readBoundedText(response: Response): Promise<string | undefined> {
  if (!response.body) {
    return undefined;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    content += decoder.decode(value, { stream: true });
    if (content.length > maxAiReplyInputCharacters) {
      await reader.cancel("AI capability probe exceeded its response budget").catch(() => undefined);
      return undefined;
    }
  }

  content += decoder.decode();
  return content;
}

function extractProbeContent(rawBody: string): { content?: string; streaming: boolean } {
  const trimmed = rawBody.trim();
  if (!trimmed) return { streaming: false };

  if (trimmed.startsWith("data:")) {
    let content = "";
    for (const rawLine of trimmed.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{
            delta?: { content?: unknown };
            message?: { content?: unknown };
          }>;
        };
        const delta = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content;
        if (typeof delta === "string") content += delta;
      } catch {
        return { streaming: true };
      }
    }
    return { content, streaming: true };
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = parsed.choices?.[0]?.message?.content;
    return { content: typeof content === "string" ? content : undefined, streaming: false };
  } catch {
    return { streaming: false };
  }
}

function isProbeReplyValid(content: string | undefined, mode: AiOutputMode): boolean {
  if (!content) return false;
  if (mode === "plain-text") return content.trim() === "probe-ok";
  const contract = createAiReplyContract({ tier: getAiProtocolTierForMode(mode) });
  const parsed = parseFinalAiReply(content, contract);
  if (parsed.reply !== "probe-ok") return false;
  return parsed.quality === "structured" && parsed.moodDelta === 0;
}

function fallbackCapability(baseUrl: string, model: string, checkedAt: string): AiOutputCapability {
  return {
    baseUrl,
    model,
    mode: "plain-text",
    protocolTier: "text",
    streaming: true,
    confidence: "fallback",
    checkedAt,
    probeVersion: 2
  };
}

function getProbeFailureKind(status: number): NonNullable<AiCapabilityProbeResult["failureKind"]> {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "server";
  return "invalid-response";
}

export async function probeAiOutputCapability(options: {
  baseUrl: string;
  model: string;
  apiKey: string;
  checkedAt?: string;
  signal?: AbortSignal;
}): Promise<AiCapabilityProbeResult> {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const totalController = new AbortController();
  const abortFromCaller = (): void => totalController.abort("capability-probe-canceled");
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (options.signal?.aborted) abortFromCaller();
  const totalTimeout = setTimeout(
    () => totalController.abort("capability-probe-total-timeout"),
    probeTotalTimeoutMs
  );

  try {
    // Exhaust every structured protocol in both streaming and complete-response
    // transport before probing plain text. A provider that only supports
    // non-streaming structured output must never be classified as text-only.
    for (const attempt of probeAttempts) {
      if (totalController.signal.aborted) {
        return {
          capability: fallbackCapability(options.baseUrl, options.model, checkedAt),
          tested: false,
          failureKind: "network"
        };
      }

      const attemptController = new AbortController();
      const abortAttemptFromTotal = (): void => {
        attemptController.abort(totalController.signal.reason ?? "capability-probe-total-timeout");
      };
      totalController.signal.addEventListener("abort", abortAttemptFromTotal, { once: true });
      const requestTimeout = setTimeout(
        () => attemptController.abort("capability-probe-request-timeout"),
        probeRequestTimeoutMs
      );

      try {
        const response = await fetch(buildChatCompletionsUrl(options.baseUrl), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
            Accept: attempt.streaming
              ? "text/event-stream, application/json"
              : "application/json"
          },
          signal: attemptController.signal,
          body: JSON.stringify(
            buildAiChatRequestBody({
              model: options.model,
              messages: attempt.mode === "plain-text" ? textProbeMessages : structuredProbeMessages,
              mode: attempt.mode,
              contract: createAiReplyContract({ tier: getAiProtocolTierForMode(attempt.mode) }),
              stream: attempt.streaming,
              temperature: 0,
              maxTokens: 256
            })
          )
        });

        if (!response.ok) {
          const mayTryCompatibleFormat = canFallbackAiOutputMode(response.status);
          await response.body?.cancel(
            mayTryCompatibleFormat
              ? "trying the next AI capability probe"
              : "AI capability probe stopped on a non-compatibility error"
          ).catch(() => undefined);
          if (mayTryCompatibleFormat) continue;
          return {
            capability: fallbackCapability(options.baseUrl, options.model, checkedAt),
            tested: false,
            failureKind: getProbeFailureKind(response.status),
            status: response.status
          };
        }

        const rawBody = await readBoundedText(response);
        if (!rawBody) continue;
        const extracted = extractProbeContent(rawBody);
        if (!isProbeReplyValid(extracted.content, attempt.mode)) continue;

        return {
          capability: {
            baseUrl: options.baseUrl,
            model: options.model,
            mode: attempt.mode,
            protocolTier: getAiProtocolTierForMode(attempt.mode),
            streaming: attempt.streaming && extracted.streaming,
            confidence: "tested",
            checkedAt,
            probeVersion: 2
          },
          tested: true
        };
      } catch {
        if (totalController.signal.aborted) {
          return {
            capability: fallbackCapability(options.baseUrl, options.model, checkedAt),
            tested: false,
            failureKind: "network"
          };
        }
        if (attemptController.signal.reason === "capability-probe-request-timeout") {
          continue;
        }
        return {
          capability: fallbackCapability(options.baseUrl, options.model, checkedAt),
          tested: false,
          failureKind: "network"
        };
      } finally {
        clearTimeout(requestTimeout);
        totalController.signal.removeEventListener("abort", abortAttemptFromTotal);
      }
    }
  } catch {
    return {
      capability: fallbackCapability(options.baseUrl, options.model, checkedAt),
      tested: false,
      failureKind: "network"
    };
  } finally {
    clearTimeout(totalTimeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }

  return {
    capability: fallbackCapability(options.baseUrl, options.model, checkedAt),
    tested: false,
    failureKind: "invalid-response"
  };
}
