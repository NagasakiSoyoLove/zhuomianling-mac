import type {
  AiChatMessage,
  AiOutputMode
} from "../../../shared/types/ai";
import {
  buildAiReplyJsonSchema,
  createAiReplyContract,
  type AiReplyContract
} from "../../../shared/aiContract";

export function buildChatCompletionsUrl(baseUrl: string): string {
  const url = new URL(`${baseUrl}/`);
  const normalizedPath = url.pathname.replace(/\/+$/, "");

  if (normalizedPath) {
    url.pathname = `${normalizedPath}/chat/completions`;
    return url.toString();
  }

  url.pathname = "/v1/chat/completions";
  return url.toString();
}

export function buildAiResponseFormat(
  mode: AiOutputMode,
  contract: AiReplyContract = createAiReplyContract({
    tier: mode === "plain-text" ? "text" : "full"
  })
): Record<string, unknown> | undefined {
  if (mode === "plain-text") {
    return undefined;
  }
  if (contract.tier !== "full") {
    throw new Error("Structured AI output mode requires the full desktop-pet protocol.");
  }
  if (mode === "prompt-json") return undefined;

  if (mode === "json-object") {
    return { type: "json_object" };
  }

  return {
    type: "json_schema",
    json_schema: {
      name: "zhuomianling_reply",
      strict: true,
      schema: buildAiReplyJsonSchema(contract)
    }
  };
}

export function buildAiChatRequestBody(options: {
  model: string;
  messages: AiChatMessage[];
  mode: AiOutputMode;
  contract?: AiReplyContract;
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
}): Record<string, unknown> {
  const responseFormat = buildAiResponseFormat(options.mode, options.contract);
  return {
    model: options.model,
    messages: options.messages.map((message) => buildAiProviderMessage(message)),
    temperature: options.temperature ?? 0.8,
    max_tokens: options.maxTokens ?? 1200,
    ...(responseFormat ? { response_format: responseFormat } : {}),
    stream: options.stream
  };
}

export function getAiOutputModeFallbacks(mode: AiOutputMode): AiOutputMode[] {
  if (mode === "json-schema") {
    return ["json-schema", "json-object", "prompt-json", "plain-text"];
  }

  if (mode === "json-object") {
    return ["json-object", "prompt-json", "plain-text"];
  }

  if (mode === "prompt-json") return ["prompt-json", "plain-text"];

  return ["plain-text"];
}

export function canFallbackAiOutputMode(status: number): boolean {
  return status === 400 || status === 404 || status === 415 || status === 422;
}

/**
 * Converts the internal bounded message shape to the OpenAI-compatible
 * multimodal message shape. The screenshot stays attached to its original
 * message instead of becoming an unrelated prompt block.
 */
export function buildAiProviderMessage(
  message: AiChatMessage,
  textLimit?: number
): Record<string, unknown> {
  const content = textLimit === undefined
    ? message.content
    : message.content.slice(0, textLimit);
  if (!message.image) {
    return { role: message.role, content };
  }

  return {
    role: message.role,
    content: [
      { type: "text", text: content },
      {
        type: "image_url",
        image_url: {
          url: `data:${message.image.mimeType};base64,${Buffer.from(message.image.data).toString("base64")}`
        }
      }
    ]
  };
}
