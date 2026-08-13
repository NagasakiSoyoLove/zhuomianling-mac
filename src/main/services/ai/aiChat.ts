import type { WebContents } from "electron";
import type {
  AiChatMessage,
  AiChatRequest,
  AiChatResponse,
  AiChatStreamCancelRequest,
  AiChatStreamCancelResult,
  AiChatStreamRequest,
  AiChatStreamEvent,
  AiOutputMode,
  AiProtocolTier
} from "../../../shared/types/ai";
import type {
  ScreenVisionTimingPhase,
  ScreenVisionTimingStage
} from "../../../shared/types/screen";
import type { PetMoodRangeId } from "../../../shared/mood";
import type { PetDefinition, PetReplyLength } from "../../../shared/types/pet";
import { parseFinalAiReply, type NormalizedAiReply } from "../../../shared/aiReply";
import {
  SecureStorageCorruptedError,
  SecureStorageUnavailableError
} from "../config/secureConfigStore";
import { getAiConnectionConfig, recordAiOutputCapability } from "./aiSettings";
import { recallMemoryForAi } from "../memory/memoryRecall";
import { captureCompletedAiTurn } from "../memory/memoryCapture";
import { AiStreamNormalizer } from "./aiStreamNormalizer";
import {
  buildAiChatRequestBody,
  buildAiProviderMessage,
  buildChatCompletionsUrl,
  canFallbackAiOutputMode,
  getAiOutputModeFallbacks
} from "./aiProtocol";
import { moodService } from "../mood/MoodService";
import { buildMoodSystemPrompt } from "../mood/moodPrompt";
import { registerMoodTextToSpeechSnapshot } from "../speech/textToSpeech";
import {
  AI_PROMPT_LIMITS,
  createAiReplyContractForPet,
  getAiProtocolTierForMode,
  type AiReplyContract
} from "../../../shared/aiContract";
import { getLocalPetDefinition } from "../config/petConfigStore";
import { buildAuthoritativeAiSystemPrompt } from "./aiPrompt";
import { screenVisionTiming } from "../screen/ScreenVisionTiming";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

interface ChatCompletionStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
    };
    message?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

function getAiSettingsErrorMessage(error: unknown): string {
  if (
    error instanceof SecureStorageUnavailableError ||
    error instanceof SecureStorageCorruptedError
  ) {
    return error.message;
  }

  return "无法读取本机 AI 设置，请检查配置文件权限后重试。";
}

function normalizeConversationMessages(messages: AiChatMessage[]): AiChatMessage[] {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
      ...(message.image ? { image: message.image } : {})
    }))
    .filter((message) => message.content.length > 0 || Boolean(message.image))
    .slice(-15);
}

function normalizeAssistantContentForContract(
  content: string,
  contract: AiReplyContract
): string {
  const parsed = parseFinalAiReply(content);
  const reply = parsed.reply || content.trim();
  if (contract.tier === "text") return reply;

  const values: Record<string, unknown> = {
    reply,
    moodDelta:
      Number.isInteger(parsed.moodDelta) && Math.abs(parsed.moodDelta as number) <= 12
        ? parsed.moodDelta
        : 0
  };
  if (contract.voiceTextRequired) values.voiceText = parsed.voiceText ?? reply;
  if (contract.emotionRequired) {
    values.emotion = parsed.emotion && contract.emotionKeys.includes(parsed.emotion)
      ? parsed.emotion
      : contract.emotionKeys[0];
  }
  return JSON.stringify(Object.fromEntries(
    contract.requiredFields.map((field) => [field, values[field]])
  ));
}

function buildMessagesForMode(options: {
  conversationMessages: AiChatMessage[];
  pet: PetDefinition;
  mode: AiOutputMode;
  moodContext: string;
  memoryContext?: string;
  systemPromptAppendix?: string;
  replyLengthOverride?: PetReplyLength;
}): { messages: AiChatMessage[]; contract: AiReplyContract } {
  const contract = createAiReplyContractForPet(
    options.pet,
    getAiProtocolTierForMode(options.mode)
  );
  const conversation = options.conversationMessages.map((message) => ({
    role: message.role,
    content: message.role === "assistant"
      ? normalizeAssistantContentForContract(message.content, contract)
      : message.content,
    ...(message.image ? { image: message.image } : {})
  }));
  const authoritativePrompt = buildAuthoritativeAiSystemPrompt({
    pet: options.pet,
    contract,
    moodContext: options.moodContext,
    memoryContext: options.memoryContext,
    replyLengthOverride: options.replyLengthOverride
  });
  const appendix = options.systemPromptAppendix?.trim();
  const remainingAppendixCharacters = Math.max(
    0,
    AI_PROMPT_LIMITS.systemPromptCharacters - authoritativePrompt.length - 2
  );
  return {
    contract,
    messages: [
      {
        role: "system",
        content: appendix && remainingAppendixCharacters > 0
          ? `${authoritativePrompt}\n\n${appendix.slice(0, remainingAppendixCharacters)}`
          : authoritativePrompt
      },
      ...conversation
    ]
  };
}

interface AiCompletionFetchResult {
  response: Response;
  mode: AiOutputMode;
  streaming: boolean;
  contract: AiReplyContract;
}

type ResolvedAiConfig = NonNullable<Awaited<ReturnType<typeof getAiConnectionConfig>>>;

const runtimeOutputCapabilities = new Map<string, NonNullable<ResolvedAiConfig["outputCapability"]>>();

// TIMED DIAGNOSTICS TEST MODULE: bounded chat/visual timing instrumentation.
function markChatTiming(
  requestId: string,
  phase: ScreenVisionTimingPhase,
  stage: ScreenVisionTimingStage,
  ok = true
): void {
  screenVisionTiming.mark(requestId, phase, stage, ok, "chat");
}

function getRuntimeCapabilityKey(config: ResolvedAiConfig): string {
  return `${config.petId}\0${config.baseUrl}\0${config.model}`;
}

async function rememberRuntimeCapability(
  config: ResolvedAiConfig,
  mode: AiOutputMode,
  streaming: boolean,
  confidence: "tested" | "fallback"
): Promise<void> {
  const capability = {
    baseUrl: config.baseUrl,
    model: config.model,
    mode,
    protocolTier: getAiProtocolTierForMode(mode),
    streaming,
    confidence,
    checkedAt: new Date().toISOString(),
    probeVersion: 2 as const
  };
  runtimeOutputCapabilities.set(getRuntimeCapabilityKey(config), capability);
  await recordAiOutputCapability(
    config.petId,
    config.baseUrl,
    config.model,
    capability
  ).catch(() => undefined);
}

function getPreferredOutput(config: ResolvedAiConfig): {
  mode: AiOutputMode;
  streaming: boolean;
} {
  const capability = runtimeOutputCapabilities.get(getRuntimeCapabilityKey(config)) ??
    config.outputCapability;
  return {
    mode: capability?.protocolTier === "full"
      ? capability.mode
      : "plain-text",
    streaming: capability?.streaming ?? true
  };
}

async function fetchAiCompletion(options: {
  config: ResolvedAiConfig;
  conversationMessages: AiChatMessage[];
  pet: PetDefinition;
  moodContext: string;
  memoryContext?: string;
  systemPromptAppendix?: string;
  replyLengthOverride?: PetReplyLength;
  streaming: boolean;
  signal?: AbortSignal;
  onTiming?: (stage: ScreenVisionTimingStage, ok?: boolean) => void;
}): Promise<AiCompletionFetchResult> {
  const preferred = getPreferredOutput(options.config);
  const modes = getAiOutputModeFallbacks(preferred.mode);
  const streamingOptions = options.streaming ? [true, false] : [false];
  let lastResponse: Response | undefined;
  let lastMode = modes[modes.length - 1];
  let lastStreaming = options.streaming;
  let lastContract = createAiReplyContractForPet(options.pet, "text");

  for (let streamingIndex = 0; streamingIndex < streamingOptions.length; streamingIndex += 1) {
    const streaming = streamingOptions[streamingIndex];
    for (let modeIndex = 0; modeIndex < modes.length; modeIndex += 1) {
      const mode = modes[modeIndex];
      const prepared = buildMessagesForMode({
        conversationMessages: options.conversationMessages,
        pet: options.pet,
        mode,
        moodContext: options.moodContext,
        memoryContext: options.memoryContext,
        systemPromptAppendix: options.systemPromptAppendix,
        replyLengthOverride: options.replyLengthOverride
      });
      lastContract = prepared.contract;
      options.onTiming?.("request-body-ready");
      options.onTiming?.("model-request-started");
      const response = await fetch(buildChatCompletionsUrl(options.config.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.config.apiKey}`,
          "Content-Type": "application/json",
          Accept: streaming ? "text/event-stream, application/json" : "application/json"
        },
        signal: options.signal,
        body: JSON.stringify(
          buildAiChatRequestBody({
            model: options.config.model,
            messages: prepared.messages,
            mode,
            contract: prepared.contract,
            stream: streaming
          })
        )
      });
      lastResponse = response;
      lastMode = mode;
      lastStreaming = streaming;

      if (response.ok) {
        if (mode !== preferred.mode || streaming !== preferred.streaming) {
          await rememberRuntimeCapability(options.config, mode, streaming, "fallback");
        }
        return { response, mode, streaming, contract: prepared.contract };
      }

      if (!canFallbackAiOutputMode(response.status)) {
        return { response, mode, streaming, contract: prepared.contract };
      }

      const hasModeFallback = modeIndex < modes.length - 1;
      const hasStreamingFallback = streamingIndex < streamingOptions.length - 1;
      if (!hasModeFallback && !hasStreamingFallback) {
        return { response, mode, streaming, contract: prepared.contract };
      }

      await response.body?.cancel("retrying with compatible AI output settings").catch(() => undefined);
      if (hasModeFallback) {
        // The current transport was explicitly rejected with a compatibility
        // status. Persist the next transport before retrying so a completed,
        // canceled, or malformed lower response cannot make the next turn hit
        // the same known response_format error again.
        await rememberRuntimeCapability(
          options.config,
          modes[modeIndex + 1],
          streaming,
          "fallback"
        );
      }
    }
  }

  return {
    response: lastResponse as Response,
    mode: lastMode,
    streaming: lastStreaming,
    contract: lastContract
  };
}

async function repairAiReplyFormat(options: {
  config: ResolvedAiConfig;
  conversationMessages: AiChatMessage[];
  pet: PetDefinition;
  mode: AiOutputMode;
  contract: AiReplyContract;
  moodContext: string;
  memoryContext?: string;
  systemPromptAppendix?: string;
  replyLengthOverride?: PetReplyLength;
  visibleReply: string;
  signal?: AbortSignal;
}): Promise<NormalizedAiReply | undefined> {
  if (options.contract.tier !== "full" || options.mode === "plain-text" || !options.visibleReply.trim()) {
    return undefined;
  }
  const prepared = buildMessagesForMode({
    conversationMessages: options.conversationMessages,
    pet: options.pet,
    mode: options.mode,
    moodContext: options.moodContext,
    memoryContext: options.memoryContext,
    systemPromptAppendix: options.systemPromptAppendix,
    replyLengthOverride: options.replyLengthOverride
  });
  prepared.messages.push(
    { role: "assistant", content: options.visibleReply },
    {
      role: "user",
      content: [
        "上一份回复的可见正文已经确定，但机器协议不完整。",
        "只重新封装同一份 reply，不得改写、增删或翻译 reply。",
        `必须返回且只返回字段：${options.contract.requiredFields.join("、")}。`
      ].join("\n")
    }
  );
  try {
    const response = await fetch(buildChatCompletionsUrl(options.config.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      signal: options.signal,
      body: JSON.stringify(buildAiChatRequestBody({
        model: options.config.model,
        messages: prepared.messages,
        mode: options.mode,
        contract: options.contract,
        stream: false,
        temperature: 0,
        maxTokens: 1200
      }))
    });
    if (!response.ok) {
      await response.body?.cancel("format repair failed").catch(() => undefined);
      return undefined;
    }
    const body = (await response.json()) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) return undefined;
    const repaired = parseFinalAiReply(content, options.contract);
    return repaired.quality === "structured" && repaired.reply === options.visibleReply
      ? repaired
      : undefined;
  } catch {
    return undefined;
  }
}

function recordRuntimeCapability(
  config: ResolvedAiConfig,
  mode: AiOutputMode,
  streaming: boolean
): void {
  if (
    config.outputCapability?.mode === mode &&
    config.outputCapability.streaming === streaming &&
    config.outputCapability.confidence === "tested"
  ) {
    return;
  }

  void rememberRuntimeCapability(config, mode, streaming, "tested");
}

export interface AiChatReplyChunk {
  content: string;
  voiceText?: string;
  protocolTier: AiProtocolTier;
}

export interface AiChatResponseOptions {
  onChunk?: (chunk: AiChatReplyChunk) => void;
  moodRangeId?: PetMoodRangeId;
  systemPromptAppendix?: string;
  replyLengthOverride?: PetReplyLength;
}

export interface AiCompletionRequest {
  petId: string;
  systemPrompt: string;
  messages: AiChatMessage[];
}

export interface AiCompletionOptions {
  streaming?: boolean;
  onTextDelta?: (delta: string) => boolean | void;
  temperature?: number;
  maxTokens?: number;
}

export interface AiCompletionResult {
  ok: boolean;
  message: string;
  text?: string;
  streaming?: boolean;
  canceled?: boolean;
  status?: number;
}

export async function sendAiChat(
  request: AiChatRequest,
  signal?: AbortSignal,
  options: AiChatResponseOptions = {}
): Promise<AiChatResponse> {
  let config: Awaited<ReturnType<typeof getAiConnectionConfig>>;

  try {
    config = await getAiConnectionConfig(request.petId);
  } catch (error: unknown) {
    return {
      ok: false,
      message: getAiSettingsErrorMessage(error)
    };
  }

  if (!config?.baseUrl || !config.model || !config.apiKey) {
    return {
      ok: false,
      message: "请先在 AI 设置中保存该桌宠的服务商、模型和 API Key。"
    };
  }

  const messages = normalizeConversationMessages(request.messages);

  if (!messages.length) {
    return {
      ok: false,
      message: "请输入聊天内容。"
    };
  }

  let response: Response;
  let responseContract: AiReplyContract;
  let responseMode: AiOutputMode = "plain-text";
  let requestedStreaming = false;
  let pet: PetDefinition | undefined;
  const moodRangeId = options.moodRangeId ?? "calm";
  const systemPromptAppendix = options.systemPromptAppendix;
  const replyLengthOverride = options.replyLengthOverride;

  try {
    pet = await getLocalPetDefinition(request.petId);
    if (!pet) {
      return { ok: false, message: "当前桌宠配置不存在。" };
    }
    // Visual fallback replies must use the result of the explicit LLM output
    // capability test. An old or untested configuration deliberately stays on
    // the complete-response path.
    requestedStreaming = Boolean(
      options.onChunk &&
      config.outputCapability?.confidence === "tested" &&
      config.outputCapability.streaming
    );
    const fetched = await fetchAiCompletion({
      config,
      conversationMessages: messages,
      pet,
      moodContext: buildMoodSystemPrompt(moodRangeId),
      systemPromptAppendix,
      replyLengthOverride,
      streaming: requestedStreaming,
      signal
    });
    response = fetched.response;
    responseContract = fetched.contract;
    responseMode = fetched.mode;
    requestedStreaming = requestedStreaming && fetched.streaming;
  } catch {
    return {
      ok: false,
      message: "无法连接 AI 服务，请检查网络或本地服务状态。"
    };
  }

  if (!response.ok) {
    let message = `AI 请求失败，状态码 ${response.status}。`;
    try {
      const body = (await response.json()) as ChatCompletionResponse;
      message = body.error?.message ?? message;
    } catch {
      // Keep the status-based message.
    }
    return { ok: false, message };
  }

  const contentType = response.headers?.get?.("Content-Type")?.toLowerCase() ?? "";
  const isStreamingResponse = Boolean(
    requestedStreaming &&
    response.body &&
    !contentType.includes("application/json")
  );

  if (isStreamingResponse) {
    const responseBody = response.body;
    if (!responseBody) {
      return { ok: false, message: "AI 流式回复没有返回可读取的数据。" };
    }
    const reader = responseBody.getReader();
    const decoder = new TextDecoder();
    const normalizer = new AiStreamNormalizer(responseContract);
    let buffer = "";
    let streamError: string | undefined;

    const processSseLine = (rawLine: string): boolean => {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) return true;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return true;

      const { delta, error } = readStreamChunkDelta(data);
      if (error) {
        streamError = error;
        return false;
      }
      if (!delta) return true;

      const snapshot = normalizer.append(delta);
      if (snapshot.overflowed) {
        streamError = "AI 返回内容过长，已停止本次回复。";
        return false;
      }
      if (snapshot.changed) {
        options.onChunk?.({
          content: snapshot.reply,
          ...(snapshot.voiceText ? { voiceText: snapshot.voiceText } : {}),
          protocolTier: responseContract.tier
        });
      }
      return true;
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!processSseLine(line)) {
            await reader.cancel(streamError ?? "AI stream failed").catch(() => undefined);
            break;
          }
        }
        if (streamError) break;
      }
      if (!streamError) {
        buffer += decoder.decode();
        if (buffer) processSseLine(buffer);
      }
    } catch {
      await reader.cancel("AI stream interrupted").catch(() => undefined);
      return { ok: false, message: "AI 流式回复中断，请稍后再试。" };
    } finally {
      reader.releaseLock?.();
    }

    if (streamError) return { ok: false, message: streamError };
    if (!normalizer.hasContent()) {
      return { ok: false, message: "AI 没有返回可显示的回复。" };
    }

    let parsedReply = normalizer.finalize();
    if (!parsedReply.reply) {
      return {
        ok: false,
        message: "AI 返回的回复格式无法识别，请重试或切换兼容模式。"
      };
    }
    if (responseContract.tier === "full" && parsedReply.quality !== "structured") {
      if (pet) {
        const repaired = await repairAiReplyFormat({
          config,
          conversationMessages: messages,
          pet,
          mode: responseMode,
          contract: responseContract,
          moodContext: buildMoodSystemPrompt(moodRangeId),
          systemPromptAppendix,
          replyLengthOverride,
          visibleReply: parsedReply.reply,
          signal
        });
        if (repaired) parsedReply = repaired;
      }
    }
    return {
      ok: true,
      message: "ok",
      content: parsedReply.reply,
      emotion: parsedReply.emotion,
      voiceText: parsedReply.voiceText
    };
  }

  let body: ChatCompletionResponse;

  try {
    body = (await response.json()) as ChatCompletionResponse;
  } catch {
    return {
      ok: false,
      message: `AI 服务返回异常内容，状态码 ${response.status}。`
    };
  }

  const content = body.choices?.[0]?.message?.content?.trim();

  if (!content) {
    return {
      ok: false,
      message: "AI 没有返回可显示的回复。"
    };
  }

  let parsedReply = parseFinalAiReply(content, responseContract);

  if (!parsedReply.reply) {
    return {
      ok: false,
      message: "AI 返回的回复格式无法识别，请重试或切换兼容模式。"
    };
  }

  return {
    ok: true,
    message: "ok",
    content: parsedReply.reply,
    emotion: parsedReply.emotion,
    voiceText: parsedReply.voiceText
  };
}

const maxCustomCompletionCharacters = 128 * 1024;

async function readCustomCompletionStream(
  response: Response,
  signal: AbortSignal | undefined,
  onTextDelta?: (delta: string) => boolean | void
): Promise<{ text?: string; message?: string; canceled?: boolean }> {
  if (!response.body) return { message: "AI 流式回复没有返回可读取的数据。" };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let failure: string | undefined;
  const cancelReader = (): void => {
    void reader.cancel(signal?.reason ?? "ai-completion-canceled").catch(() => undefined);
  };
  signal?.addEventListener("abort", cancelReader, { once: true });
  if (signal?.aborted) cancelReader();

  const consumeLine = (rawLine: string): boolean => {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return true;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return true;

    const { delta, error } = readStreamChunkDelta(data);
    if (error) {
      failure = error;
      return false;
    }
    if (!delta) return true;

    text += delta;
    if (text.length > maxCustomCompletionCharacters) {
      failure = "AI 返回内容过长，已停止本次回复。";
      return false;
    }
    if (onTextDelta?.(delta) === false) {
      failure = "AI 返回内容超过监测协议限制，已停止本次分析。";
      return false;
    }
    return true;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!consumeLine(line)) break;
      }
      if (failure) {
        await reader.cancel(failure).catch(() => undefined);
        break;
      }
    }
    if (!failure) {
      buffer += decoder.decode();
      if (buffer) consumeLine(buffer);
    }
  } catch {
    await reader.cancel("AI 流式回复中断").catch(() => undefined);
    return signal?.aborted
      ? { canceled: true, message: "AI 回复已取消。" }
      : { message: "AI 流式回复中断，请稍后再试。" };
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock?.();
  }

  if (signal?.aborted) return { canceled: true, message: "AI 回复已取消。" };
  return failure ? { message: failure } : { text };
}

/**
 * Runs a bounded, protocol-neutral completion for services that own their
 * output contract (for example screen monitoring). It intentionally does not
 * build the regular chat prompt, recall memory, apply mood, or capture a
 * completed chat turn.
 */
export async function runAiCompletion(
  request: AiCompletionRequest,
  signal?: AbortSignal,
  options: AiCompletionOptions = {}
): Promise<AiCompletionResult> {
  let config: Awaited<ReturnType<typeof getAiConnectionConfig>>;
  try {
    config = await getAiConnectionConfig(request.petId);
  } catch (error: unknown) {
    return { ok: false, message: getAiSettingsErrorMessage(error) };
  }

  if (!config?.baseUrl || !config.model || !config.apiKey) {
    return { ok: false, message: "请先在 AI 设置中保存该桌宠的服务商、模型和 API Key。" };
  }

  const messages: AiChatMessage[] = [
    { role: "system", content: request.systemPrompt.trim().slice(0, 64 * 1024) },
    ...normalizeConversationMessages(request.messages).slice(-8)
  ];
  if (!messages.some((message) => message.role === "user")) {
    return { ok: false, message: "AI 请求缺少用户输入。" };
  }

  const requestOnce = async (streaming: boolean): Promise<AiCompletionResult> => {
    let response: Response;
    try {
      response = await fetch(buildChatCompletionsUrl(config!.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config!.apiKey}`,
          "Content-Type": "application/json",
          Accept: streaming ? "text/event-stream, application/json" : "application/json"
        },
        signal,
        body: JSON.stringify({
          model: config!.model,
          messages: messages.map((message) => buildAiProviderMessage(message)),
          temperature: options.temperature ?? 0,
          max_tokens: options.maxTokens ?? 1_200,
          stream: streaming
        })
      });
    } catch {
      return signal?.aborted
        ? { ok: false, message: "AI 回复已取消。", canceled: true, streaming }
        : { ok: false, message: "无法连接 AI 服务，请检查网络或本地服务状态。", streaming };
    }

    if (signal?.aborted) {
      await response.body?.cancel("ai-completion-canceled").catch(() => undefined);
      return { ok: false, message: "AI 回复已取消。", canceled: true, streaming };
    }

    if (!response.ok) {
      let message = `AI 请求失败，状态码 ${response.status}。`;
      try {
        const body = (await response.json()) as ChatCompletionResponse;
        message = body.error?.message ?? message;
      } catch {
        // Keep the status-based message.
      }
      return { ok: false, message, streaming, status: response.status };
    }

    const contentType = response.headers?.get?.("Content-Type")?.toLowerCase() ?? "";
    if (streaming && response.body && !contentType.includes("application/json")) {
      const streamed = await readCustomCompletionStream(response, signal, options.onTextDelta);
      if (streamed.canceled) return { ok: false, message: streamed.message ?? "AI 回复已取消。", canceled: true, streaming };
      if (streamed.message) return { ok: false, message: streamed.message, streaming };
      if (!streamed.text?.trim()) return { ok: false, message: "AI 没有返回可识别的监测结果。", streaming };
      return { ok: true, message: "ok", text: streamed.text, streaming };
    }

    let body: ChatCompletionResponse;
    try {
      body = (await response.json()) as ChatCompletionResponse;
    } catch {
      return { ok: false, message: "AI 服务返回异常内容。", streaming };
    }
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      return { ok: false, message: "AI 没有返回可识别的监测结果。", streaming };
    }
    if (signal?.aborted) return { ok: false, message: "AI 回复已取消。", canceled: true, streaming };
    if (text.length > maxCustomCompletionCharacters) {
      return { ok: false, message: "AI 返回内容过长，已停止本次分析。", streaming };
    }
    if (options.onTextDelta?.(text) === false) {
      return { ok: false, message: "AI 返回内容超过监测协议限制，已停止本次分析。", streaming };
    }
    return { ok: true, message: "ok", text, streaming };
  };

  const requestedStreaming = options.streaming === true;
  const streamed = await requestOnce(requestedStreaming);
  if (
    !streamed.ok &&
    requestedStreaming &&
    !streamed.canceled &&
    !signal?.aborted
  ) {
    // A provider that rejects only the streaming transport can still be used
    // for the final, fully validated decision. Do not hide auth/rate-limit or
    // server failures behind this compatibility fallback.
    if (canFallbackAiOutputMode(streamed.status ?? -1)) return requestOnce(false);
  }
  return streamed;
}

function sendStreamEvent(target: WebContents, event: AiChatStreamEvent): void {
  if (!target.isDestroyed()) {
    target.send("ai-chat:stream-event", event);
  }
}

export interface AiChatStreamTimeouts {
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
}

type AiChatAbortReason = NonNullable<AiChatStreamEvent["reason"]>;

interface AiChatStreamEntry {
  target: WebContents;
  streamId: string;
  requestId: string;
  petId: string;
  controller: AbortController;
  active: boolean;
  connectTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  totalTimer?: NodeJS.Timeout;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
}

interface AiChatOwnerState {
  streams: Map<string, AiChatStreamEntry>;
  ownerGoneListener: () => void;
}

const defaultAiChatStreamTimeouts: AiChatStreamTimeouts = {
  connectTimeoutMs: 15_000,
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 120_000
};
const aiChatOwners = new WeakMap<WebContents, AiChatOwnerState>();

function emitEntryEvent(
  entry: AiChatStreamEntry,
  event: Omit<AiChatStreamEvent, "streamId" | "requestId" | "petId">
): void {
  if (!entry.active) {
    return;
  }

  if (event.type === "chunk" || event.type === "done") {
    markChatTiming(entry.requestId, "main", "reply-event-sent", event.ok ?? true);
  } else if (event.type === "error" || event.type === "canceled") {
    markChatTiming(entry.requestId, "main", "request-failed", false);
  }

  sendStreamEvent(entry.target, {
    ...event,
    streamId: entry.streamId,
    requestId: entry.requestId,
    petId: entry.petId
  });
}

function clearEntryTimers(entry: AiChatStreamEntry): void {
  clearTimeout(entry.connectTimer);
  clearTimeout(entry.idleTimer);
  clearTimeout(entry.totalTimer);
  entry.connectTimer = undefined;
  entry.idleTimer = undefined;
  entry.totalTimer = undefined;
}

function detachEntry(entry: AiChatStreamEntry, abortReason?: AiChatAbortReason): boolean {
  if (!entry.active) {
    return false;
  }

  entry.active = false;
  moodService.releaseReplySnapshot(entry.target.id, entry.petId, entry.requestId);
  clearEntryTimers(entry);

  const ownerState = aiChatOwners.get(entry.target);
  ownerState?.streams.delete(entry.streamId);

  if (ownerState && ownerState.streams.size === 0) {
    entry.target.removeListener("render-process-gone", ownerState.ownerGoneListener);
    entry.target.removeListener("destroyed", ownerState.ownerGoneListener);
    aiChatOwners.delete(entry.target);
  }

  if (abortReason && !entry.controller.signal.aborted) {
    entry.controller.abort(abortReason);
  }

  if (abortReason && entry.reader) {
    void entry.reader.cancel(abortReason).catch(() => undefined);
  }

  return true;
}

function completeEntry(
  entry: AiChatStreamEntry,
  event: Omit<AiChatStreamEvent, "streamId" | "requestId" | "petId">
): void {
  if (event.type === "done" && event.ok) {
    markChatTiming(entry.requestId, "main", "reply-result-ready");
  }
  emitEntryEvent(entry, event);
  detachEntry(entry);
}

function abortEntry(entry: AiChatStreamEntry, reason: AiChatAbortReason): boolean {
  if (!entry.active) {
    return false;
  }

  if (reason === "connect-timeout" || reason === "idle-timeout" || reason === "total-timeout") {
    const timeoutLabel =
      reason === "connect-timeout"
        ? "连接超时"
        : reason === "idle-timeout"
          ? "等待回复超时"
          : "总时长超时";
    emitEntryEvent(entry, {
      ok: false,
      type: "error",
      reason,
      message: `AI ${timeoutLabel}，请检查网络或服务状态后重试。`
    });
  } else if (reason !== "owner-destroyed") {
    emitEntryEvent(entry, {
      ok: false,
      type: "canceled",
      reason,
      message: reason === "replaced" ? "旧回复已由新请求替换。" : "AI 回复已取消。"
    });
  }

  return detachEntry(entry, reason);
}

function getOrCreateOwnerState(target: WebContents): AiChatOwnerState {
  const existingState = aiChatOwners.get(target);

  if (existingState) {
    return existingState;
  }

  const ownerState: AiChatOwnerState = {
    streams: new Map(),
    ownerGoneListener: () => {
      for (const entry of [...ownerState.streams.values()]) {
        abortEntry(entry, "owner-destroyed");
      }
    }
  };
  aiChatOwners.set(target, ownerState);
  target.on("render-process-gone", ownerState.ownerGoneListener);
  target.once("destroyed", ownerState.ownerGoneListener);

  return ownerState;
}

function createStreamEntry(
  target: WebContents,
  request: AiChatStreamRequest,
  streamId: string,
  timeouts: AiChatStreamTimeouts
): AiChatStreamEntry {
  const currentOwnerState = getOrCreateOwnerState(target);

  for (const existingEntry of [...currentOwnerState.streams.values()]) {
    if (existingEntry.petId === request.petId) {
      abortEntry(existingEntry, "replaced");
    }
  }

  const ownerState = getOrCreateOwnerState(target);

  const entry: AiChatStreamEntry = {
    target,
    streamId,
    requestId: request.requestId,
    petId: request.petId,
    controller: new AbortController(),
    active: true
  };
  ownerState.streams.set(streamId, entry);

  entry.connectTimer = setTimeout(() => {
    abortEntry(entry, "connect-timeout");
  }, timeouts.connectTimeoutMs);
  entry.totalTimer = setTimeout(() => {
    abortEntry(entry, "total-timeout");
  }, timeouts.totalTimeoutMs);

  return entry;
}

function resetIdleTimeout(entry: AiChatStreamEntry, idleTimeoutMs: number): void {
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    abortEntry(entry, "idle-timeout");
  }, idleTimeoutMs);
}

export function cancelAiChatStreams(
  target: WebContents,
  request: AiChatStreamCancelRequest = {}
): AiChatStreamCancelResult {
  const ownerState = aiChatOwners.get(target);
  let canceled = 0;

  for (const entry of [...(ownerState?.streams.values() ?? [])]) {
    if (request.petId && entry.petId !== request.petId) {
      continue;
    }

    if (request.requestId && entry.requestId !== request.requestId) {
      continue;
    }

    if (request.streamId && entry.streamId !== request.streamId) {
      continue;
    }

    canceled += Number(abortEntry(entry, "renderer"));
  }

  return {
    ok: true,
    message: "ok",
    canceled
  };
}

function readStreamChunkDelta(line: string): { delta?: string; error?: string } {
  try {
    const parsed = JSON.parse(line) as ChatCompletionStreamChunk;

    return {
      delta: parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content,
      error: parsed.error?.message
    };
  } catch {
    return {};
  }
}

export async function startAiChatStream(
  target: WebContents,
  request: AiChatStreamRequest,
  streamId: string,
  timeoutOverrides: Partial<AiChatStreamTimeouts> = {}
): Promise<void> {
  const timeouts = {
    ...defaultAiChatStreamTimeouts,
    ...timeoutOverrides
  };
  const entry = createStreamEntry(target, request, streamId, timeouts);
  let moodSnapshot: Awaited<ReturnType<typeof moodService.createReplySnapshot>>;
  try {
    moodSnapshot = await moodService.createReplySnapshot(target.id, request.petId, request.requestId);
    registerMoodTextToSpeechSnapshot(target, request.petId, request.requestId, moodSnapshot.rangeId);
  } catch {
    completeEntry(entry, { ok: false, type: "error", message: "无法读取桌宠心情状态，请检查本地数据后重试。" });
    return;
  }

  let config: Awaited<ReturnType<typeof getAiConnectionConfig>>;

  try {
    config = await getAiConnectionConfig(request.petId);
  } catch (error: unknown) {
    completeEntry(entry, {
      ok: false,
      type: "error",
      message: getAiSettingsErrorMessage(error)
    });
    return;
  }

  if (!entry.active) {
    return;
  }

  if (!config?.baseUrl || !config.model || !config.apiKey) {
    completeEntry(entry, {
      ok: false,
      type: "error",
      message: "请先在 AI 设置中保存该桌宠的服务商、模型和 API Key。"
    });
    return;
  }

  let pet: PetDefinition | undefined;
  try {
    pet = await getLocalPetDefinition(request.petId);
  } catch {
    completeEntry(entry, {
      ok: false,
      type: "error",
      message: "无法读取桌宠配置，请检查本地数据后重试。"
    });
    return;
  }
  if (!pet) {
    completeEntry(entry, { ok: false, type: "error", message: "当前桌宠配置不存在。" });
    return;
  }

  const conversationMessages = normalizeConversationMessages(request.messages);

  if (!conversationMessages.length) {
    completeEntry(entry, {
      ok: false,
      type: "error",
      message: "请输入聊天内容。"
    });
    return;
  }
  const currentUserText = [...conversationMessages].reverse().find((message) => message.role === "user")?.content;
  const moodContext = buildMoodSystemPrompt(moodSnapshot.rangeId);
  let memoryContext: string | undefined;

  try {
    const recalled = await recallMemoryForAi(request.petId, conversationMessages, entry.controller.signal);
    if (!entry.active) return;
    memoryContext = recalled.context;
  } catch {
    // Recall is optional and must never block the original chat path.
    if (!entry.active) return;
  }

  let response: Response;
  let responseMode: AiOutputMode;
  let requestedStreaming: boolean;
  let responseContract: AiReplyContract;

  try {
    const preferred = getPreferredOutput(config);
    const fetched = await fetchAiCompletion({
      config,
      conversationMessages,
      pet,
      moodContext,
      memoryContext,
      streaming: preferred.streaming,
      signal: entry.controller.signal,
      onTiming: (stage, ok) => markChatTiming(request.requestId, "chat-model", stage, ok)
    });
    response = fetched.response;
    responseMode = fetched.mode;
    requestedStreaming = fetched.streaming;
    responseContract = fetched.contract;
  } catch {
    if (!entry.active) {
      return;
    }

    completeEntry(entry, {
      ok: false,
      type: "error",
      message: "无法连接 AI 服务，请检查网络或本地服务状态。"
    });
    return;
  }

  if (!entry.active) {
    return;
  }

  clearTimeout(entry.connectTimer);
  entry.connectTimer = undefined;

  if (!response.ok || !response.body) {
    let message = `AI 请求失败，状态码 ${response.status}。`;

    try {
      const body = (await response.json()) as ChatCompletionResponse;
      message = body.error?.message ?? message;
    } catch {
      // Keep the status-based message.
    }

    if (!entry.active) {
      return;
    }

    completeEntry(entry, {
      ok: false,
      type: "error",
      message
    });
    return;
  }

  const contentType = response.headers?.get?.("Content-Type")?.toLowerCase() ?? "";
  if (!requestedStreaming || contentType.includes("application/json")) {
    let body: ChatCompletionResponse;
    try {
      body = (await response.json()) as ChatCompletionResponse;
    } catch {
      markChatTiming(request.requestId, "chat-model", "model-output-completed", false);
      completeEntry(entry, {
        ok: false,
        type: "error",
        message: "AI 服务返回异常内容。"
      });
      return;
    }

    const content = body.choices?.[0]?.message?.content?.trim();
    if (content) {
      markChatTiming(request.requestId, "chat-model", "model-first-output");
    }
    markChatTiming(request.requestId, "chat-model", "model-output-completed", Boolean(content));
    let parsedReply = content ? parseFinalAiReply(content, responseContract) : undefined;
    if (!parsedReply?.reply) {
      completeEntry(entry, {
        ok: false,
        type: "error",
        message: "AI 返回的回复格式无法识别，请重试或切换兼容模式。"
      });
      return;
    }

    if (responseContract.tier === "full" && parsedReply.quality !== "structured") {
      const repaired = await repairAiReplyFormat({
        config,
        conversationMessages,
        pet,
        mode: responseMode,
        contract: responseContract,
        moodContext,
        memoryContext,
        visibleReply: parsedReply.reply,
        signal: entry.controller.signal
      });
      if (repaired) parsedReply = repaired;
    }

    if (parsedReply.quality === "structured" && parsedReply.moodDelta !== undefined) {
      await moodService.applyAiDelta(request.petId, request.requestId, parsedReply.moodDelta);
    }
    completeEntry(entry, {
      ok: true,
      type: "done",
      content: parsedReply.reply,
      emotion: parsedReply.emotion,
      voiceText: parsedReply.voiceText,
      protocolTier: responseContract.tier,
      quality: parsedReply.quality === "invalid" ? undefined : parsedReply.quality
    });
    if (responseContract.tier === "text" || parsedReply.quality === "structured") {
      recordRuntimeCapability(config, responseMode, false);
    }
    if (currentUserText && parsedReply.completeForMemory) {
      void captureCompletedAiTurn({
        petId: request.petId,
        requestId: request.requestId,
        userText: currentUserText,
        assistantReply: parsedReply.reply,
        occurredAt: new Date().toISOString()
      }).catch(() => undefined);
    }
    return;
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  entry.reader = reader;
  let buffer = "";
  const normalizer = new AiStreamNormalizer(responseContract);
  resetIdleTimeout(entry, timeouts.idleTimeoutMs);

  const processSseLine = async (rawLine: string): Promise<boolean> => {
    const line = rawLine.trim();

    if (!line.startsWith("data:")) {
      return true;
    }

    const data = line.slice(5).trim();

    if (!data || data === "[DONE]") {
      return true;
    }

    const { delta, error } = readStreamChunkDelta(data);

    if (error) {
      await reader.cancel("AI provider returned a stream error").catch(() => undefined);
      completeEntry(entry, {
        ok: false,
        type: "error",
        message: error
      });
      return false;
    }

    if (!delta) {
      return true;
    }

    const safeSnapshot = normalizer.append(delta);
    if (safeSnapshot.overflowed) {
      await reader.cancel("AI response exceeded the bounded parser budget").catch(() => undefined);
      completeEntry(entry, {
        ok: false,
        type: "error",
        message: "AI 返回内容过长，已停止本次回复。"
      });
      return false;
    }

    if (safeSnapshot.changed) {
      markChatTiming(request.requestId, "chat-model", "model-first-output");
      emitEntryEvent(entry, {
        ok: true,
        type: "chunk",
        delta: safeSnapshot.replyDelta,
        content: safeSnapshot.reply,
        voiceText: safeSnapshot.voiceText,
        protocolTier: responseContract.tier
      });
    }

    return true;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (!entry.active) {
        return;
      }

      if (done) {
        break;
      }

      resetIdleTimeout(entry, timeouts.idleTimeoutMs);

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        if (!(await processSseLine(rawLine))) {
          return;
        }
      }
    }

    buffer += decoder.decode();
    if (buffer && !(await processSseLine(buffer))) {
      return;
    }
    markChatTiming(request.requestId, "chat-model", "model-output-completed");
  } catch {
    if (!entry.active) {
      return;
    }

    markChatTiming(request.requestId, "chat-model", "model-output-completed", false);
    completeEntry(entry, {
      ok: false,
      type: "error",
      message: "AI 流式回复中断，请稍后再试。"
    });
    return;
  }

  if (!normalizer.hasContent()) {
    completeEntry(entry, {
      ok: false,
      type: "error",
      message: "AI 没有返回可显示的回复。"
    });
    return;
  }

  let parsedReply = normalizer.finalize();
  if (!parsedReply.reply) {
    completeEntry(entry, {
      ok: false,
      type: "error",
      message: "AI 返回的回复格式无法识别，请重试或切换兼容模式。"
    });
    return;
  }
  if (responseContract.tier === "full" && parsedReply.quality !== "structured") {
    const repaired = await repairAiReplyFormat({
      config,
      conversationMessages,
      pet,
      mode: responseMode,
      contract: responseContract,
      moodContext,
      memoryContext,
      visibleReply: parsedReply.reply,
      signal: entry.controller.signal
    });
    if (repaired) parsedReply = repaired;
  }
  if (parsedReply.quality === "structured" && parsedReply.moodDelta !== undefined) {
    await moodService.applyAiDelta(request.petId, request.requestId, parsedReply.moodDelta);
  }
  completeEntry(entry, {
    ok: true,
    type: "done",
    content: parsedReply.reply,
    emotion: parsedReply.emotion,
    voiceText: parsedReply.voiceText,
    protocolTier: responseContract.tier,
    quality: parsedReply.quality === "invalid" ? undefined : parsedReply.quality
  });
  if (responseContract.tier === "text" || parsedReply.quality === "structured") {
    recordRuntimeCapability(config, responseMode, true);
  }
  if (currentUserText && parsedReply.completeForMemory && parsedReply.reply) {
    void captureCompletedAiTurn({
      petId: request.petId,
      requestId: request.requestId,
      userText: currentUserText,
      assistantReply: parsedReply.reply,
      occurredAt: new Date().toISOString()
    }).catch(() => undefined);
  }
}
