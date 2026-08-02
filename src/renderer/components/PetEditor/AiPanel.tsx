import {
  CheckCircle2,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  List,
  PlugZap,
  Save,
  ShieldCheck,
  XCircle
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { aiProviderOptions, findAiProviderByBaseUrl, getOpenAiCompatibleProviderName, normalizeAiBaseUrl } from "../../../shared/types/ai";
import type {
  AiConnectionDraft,
  AiConnectionSaveResult,
  AiConnectionSummary,
  AiModelListResult,
  AiModelOption,
  AiOutputCapability,
  AiOutputCapabilityTestResult,
  AiProviderSelectId
} from "../../../shared/types/ai";
import type { PetDefinition } from "../../../shared/types/pet";
import { AppleSelect, SaveSuccessToast } from "./EditorShared";

interface AiSettingsForm {
  petId: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

const aiProviderSelectOptions: { value: AiProviderSelectId; label: string }[] = [
  ...aiProviderOptions.map((provider) => ({
    value: provider.id,
    label: provider.name
  })),
  {
    value: "custom",
    label: "自定义"
  }
];

function getProviderName(baseUrl: string): string {
  return getOpenAiCompatibleProviderName(baseUrl);
}

function getCapabilityStatusLabel(capability: AiOutputCapability): string {
  const mode = capability.protocolTier === "full" ? "完整桌宠能力" : "兼容模式";
  const verification = capability.confidence === "tested" ? "已验证" : "自动回退";
  return `${mode} · ${verification}`;
}

function getCapabilityItems(capability: AiOutputCapability): string[] {
  if (capability.protocolTier !== "full") {
    return ["聊天与字幕", "本地表情推断", "同语言朗读"];
  }

  return [
    "结构化回复",
    capability.streaming ? "流式回复" : "完整回复",
    "情绪变化",
    "语义表情",
    "跨语言语音"
  ];
}

export function AiPanel({
  pet,
  onDirtyChange
}: {
  pet: PetDefinition;
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element {
  const [summary, setSummary] = useState<AiConnectionSummary | undefined>();
  const [models, setModels] = useState<AiModelOption[]>([]);
  const [form, setForm] = useState<AiSettingsForm>({
    petId: pet.id,
    baseUrl: aiProviderOptions[0].baseUrl,
    model: "",
    apiKey: ""
  });
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [testingOutput, setTestingOutput] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [result, setResult] = useState<AiConnectionSaveResult | undefined>();
  const [modelResult, setModelResult] = useState<AiModelListResult | undefined>();
  const [outputResult, setOutputResult] = useState<AiOutputCapabilityTestResult | undefined>();
  const [asyncError, setAsyncError] = useState<string>();
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const requestSequenceRef = useRef(0);

  const selectedProviderId = useMemo(() => {
    return findAiProviderByBaseUrl(form.baseUrl)?.id ?? "custom";
  }, [form.baseUrl]);
  const normalizedFormBaseUrl = useMemo(
    () => normalizeAiBaseUrl(form.baseUrl),
    [form.baseUrl]
  );
  const normalizedSavedBaseUrl = useMemo(
    () => normalizeAiBaseUrl(summary?.baseUrl ?? ""),
    [summary?.baseUrl]
  );
  const canReuseSavedApiKey = Boolean(
    summary?.hasApiKey &&
    normalizedFormBaseUrl &&
    normalizedFormBaseUrl === normalizedSavedBaseUrl
  );
  const hasEnteredApiKey = Boolean(form.apiKey.trim());
  const hasUsableApiKey = hasEnteredApiKey || canReuseSavedApiKey;
  const savedKeyBelongsToAnotherEndpoint = Boolean(
    summary?.hasApiKey &&
    normalizedFormBaseUrl &&
    normalizedFormBaseUrl !== normalizedSavedBaseUrl
  );
  const credentialMessage = loadingSummary
    ? undefined
    : !normalizedFormBaseUrl
      ? "请先填写 Base URL。"
      : hasUsableApiKey
        ? undefined
        : savedKeyBelongsToAnotherEndpoint
          ? "Base URL 已更改。为避免把旧密钥发送到新地址，请输入新地址自己的 API Key。"
          : "请填写 API Key；只有 Base URL 与已保存地址一致时，才能复用本机旧密钥。";
  const formDisabled = loadingSummary || saving || connecting || testingOutput;
  const markDirty = (): void => {
    setHasUnsavedChanges(true);
    onDirtyChange(true);
  };
  const saveFeedbackResult = useMemo(
    () => (result?.test.ok ? { ok: true, message: result.test.message } : undefined),
    [result]
  );
  const modelFeedbackResult = useMemo(
    () => (modelResult?.ok ? { ok: true, message: modelResult.message } : undefined),
    [modelResult]
  );
  const activeOutputCapability = useMemo<AiOutputCapability | undefined>(() => {
    const candidate = outputResult?.capability ?? summary?.outputCapability;
    if (!candidate) return undefined;
    return normalizeAiBaseUrl(candidate.baseUrl) === normalizedFormBaseUrl &&
      candidate.model === form.model.trim()
      ? candidate
      : undefined;
  }, [form.model, normalizedFormBaseUrl, outputResult?.capability, summary?.outputCapability]);
  const capabilityItems = activeOutputCapability ? getCapabilityItems(activeOutputCapability) : [];

  useEffect(() => {
    let cancelled = false;
    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;

    setLoadingSummary(true);
    setConnecting(false);
    setTestingOutput(false);
    setSaving(false);
    setSummary(undefined);
    setModels([]);
    setResult(undefined);
    setModelResult(undefined);
    setOutputResult(undefined);
    setAsyncError(undefined);
    setHasUnsavedChanges(false);
    setShowApiKey(false);
    onDirtyChange(false);
    setForm({
      petId: pet.id,
      baseUrl: aiProviderOptions[0].baseUrl,
      model: "",
      apiKey: ""
    });

    const loadSummary = async (): Promise<void> => {
      try {
        const nextSummary = await window.desktopPet?.aiSettings.get(pet.id);

        if (cancelled || requestId !== requestSequenceRef.current) {
          return;
        }

        setSummary(nextSummary);

        if (!nextSummary) {
          return;
        }

        const savedModels = nextSummary.models.length
          ? nextSummary.models
          : nextSummary.model
            ? [{ id: nextSummary.model, name: nextSummary.model }]
            : [];

        setModels(savedModels);
        setForm({
          petId: pet.id,
          baseUrl: nextSummary.baseUrl,
          model: nextSummary.model,
          apiKey: ""
        });
      } catch (error) {
        if (!cancelled && requestId === requestSequenceRef.current) {
          console.error("Failed to load AI settings summary.", error);
          setAsyncError("读取已保存的 AI 设置失败，请稍后重试。为了保护密钥，当前不会复用旧配置。");
        }
      } finally {
        if (!cancelled && requestId === requestSequenceRef.current) {
          setLoadingSummary(false);
        }
      }
    };

    void loadSummary();

    return () => {
      cancelled = true;
      requestSequenceRef.current += 1;
    };
  }, [pet.id]);

  useEffect(() => {
    if (!modelResult?.ok) {
      return;
    }

    const timer = window.setTimeout(() => {
      setModelResult(undefined);
    }, 2200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [modelResult]);

  useEffect(() => {
    if (!result?.test.ok) {
      return;
    }

    const timer = window.setTimeout(() => {
      setResult(undefined);
    }, 2200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [result]);

  const updateField = (field: keyof AiSettingsForm, value: string): void => {
    markDirty();
    setResult(undefined);
    setModelResult(undefined);
    setOutputResult(undefined);
    setAsyncError(undefined);

    if (field === "baseUrl") {
      setModels([]);
      setForm((currentForm) => ({
        ...currentForm,
        baseUrl: value,
        apiKey: "",
        model: ""
      }));
      return;
    }

    if (field === "apiKey") {
      setModels([]);
      setForm((currentForm) => ({
        ...currentForm,
        apiKey: value,
        model: ""
      }));
      return;
    }

    setForm((currentForm) => ({
      ...currentForm,
      [field]: value
    }));
  };

  const updateProvider = (providerId: string): void => {
    if (providerId === "custom") {
      setResult(undefined);
      setModelResult(undefined);
      setOutputResult(undefined);
      setAsyncError(undefined);
      markDirty();
      setModels([]);
      setForm((currentForm) => ({
        ...currentForm,
        baseUrl: findAiProviderByBaseUrl(currentForm.baseUrl) ? "" : currentForm.baseUrl,
        apiKey: "",
        model: ""
      }));
      return;
    }

    const provider = aiProviderOptions.find((option) => option.id === providerId);

    if (!provider) {
      return;
    }

    setResult(undefined);
    setModelResult(undefined);
    setOutputResult(undefined);
    setAsyncError(undefined);
    markDirty();
    setModels([]);
    setForm((currentForm) => ({
      ...currentForm,
      baseUrl: provider.baseUrl,
      apiKey: "",
      model: ""
    }));
  };

  const buildDraft = (): AiConnectionDraft => {
    return {
      petId: form.petId,
      providerName: getProviderName(form.baseUrl),
      baseUrl: form.baseUrl,
      model: form.model,
      apiKey: form.apiKey,
      models
    };
  };

  const connectModels = async (): Promise<void> => {
    if (!hasUsableApiKey) {
      setAsyncError(credentialMessage ?? "请填写当前 Base URL 对应的 API Key。");
      return;
    }

    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;
    setConnecting(true);
    setResult(undefined);
    setModelResult(undefined);
    setOutputResult(undefined);
    setAsyncError(undefined);

    try {
      const nextResult = await window.desktopPet?.aiSettings.listModels(buildDraft());

      if (requestId !== requestSequenceRef.current) {
        return;
      }

      if (!nextResult) {
        setAsyncError("连接没有返回结果，请稍后重试。");
        return;
      }

      setModelResult(nextResult);
      setModels(nextResult.models);

      if (nextResult.models.length) {
        markDirty();
        setForm((currentForm) => ({
          ...currentForm,
          model:
            nextResult.models.find((model) => model.id === currentForm.model)?.id ??
            nextResult.models[0]?.id ??
            ""
        }));
      }
    } catch (error) {
      if (requestId === requestSequenceRef.current) {
        console.error("Failed to list AI models.", error);
        setAsyncError("连接 AI 服务失败，请检查 Base URL、API Key 和网络后重试。");
      }
    } finally {
      if (requestId === requestSequenceRef.current) {
        setConnecting(false);
      }
    }
  };

  const testOutputCapability = async (): Promise<void> => {
    if (!hasUsableApiKey || !form.model.trim()) {
      setAsyncError(credentialMessage ?? "请先连接并选择当前模型。");
      return;
    }

    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;
    setTestingOutput(true);
    setOutputResult(undefined);
    setAsyncError(undefined);

    try {
      const nextResult = await window.desktopPet?.aiSettings.testOutput(buildDraft());
      if (requestId !== requestSequenceRef.current) return;
      if (!nextResult) {
        setAsyncError("输出能力测试没有返回结果，请稍后重试。");
        return;
      }
      setOutputResult(nextResult);
      if (nextResult.capability) {
        setSummary((current) => current
          ? { ...current, outputCapability: nextResult.capability }
          : current);
      }
    } catch (error) {
      if (requestId === requestSequenceRef.current) {
        console.error("Failed to test AI output capability.", error);
        setAsyncError("输出能力测试失败，聊天将继续使用兼容模式。");
      }
    } finally {
      if (requestId === requestSequenceRef.current) setTestingOutput(false);
    }
  };

  const saveSettings = async (): Promise<void> => {
    if (!hasUsableApiKey) {
      setAsyncError(credentialMessage ?? "请填写当前 Base URL 对应的 API Key。");
      return;
    }

    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;
    setSaving(true);
    setResult(undefined);
    setOutputResult(undefined);
    setAsyncError(undefined);

    try {
      const nextResult = await window.desktopPet?.aiSettings.save(buildDraft());

      if (requestId !== requestSequenceRef.current) {
        return;
      }

      if (!nextResult) {
        setAsyncError("保存没有返回结果，请稍后重试。");
        return;
      }

      setResult(nextResult);
      setSummary(nextResult.config);

      if (nextResult.test.ok) {
        setHasUnsavedChanges(false);
        onDirtyChange(false);
        setForm((currentForm) => ({
          ...currentForm,
          apiKey: ""
        }));
      }
    } catch (error) {
      if (requestId === requestSequenceRef.current) {
        console.error("Failed to save AI settings.", error);
        setAsyncError("保存 AI 设置失败，请检查连接信息后重试。");
      }
    } finally {
      if (requestId === requestSequenceRef.current) {
        setSaving(false);
      }
    }
  };

  const connectionBadgeClass = loadingSummary
    ? "connectionBadge wait"
    : hasUnsavedChanges
      ? "connectionBadge dirty"
      : summary?.model
        ? "connectionBadge ok"
        : "connectionBadge wait";
  const connectionBadgeLabel = loadingSummary
    ? "读取中"
    : hasUnsavedChanges
      ? "未保存更改"
      : summary?.model
        ? "已连接"
        : "未配置";
  const testOutputDisabled = connecting || saving || testingOutput || loadingSummary || !form.model || !hasUsableApiKey;

  return (
    <div className="editorPanel llmConfigPanel">
      <div className="panelTitleRow">
        <div>
          <h2>AI 服务</h2>
          <p>为 {pet.name} 配置兼容 OpenAI 的模型连接，API Key 只保存在本机。</p>
        </div>
        <span className={connectionBadgeClass}>{connectionBadgeLabel}</span>
      </div>

      <div className="llmConfigFlow">
        <section className="llmSection" aria-labelledby="llm-connection-title">
          <div className="llmSectionHeader">
            <div className="llmSectionHeading">
              <span className="llmStep" aria-hidden="true">1</span>
              <div>
                <h3 id="llm-connection-title">连接信息</h3>
                <p>先选择服务商，再填写接口地址和 API Key。</p>
              </div>
            </div>
          </div>

          <div className="settingsForm llmSettingsForm">
            <label className="settingsField">
              <span>服务商</span>
              <AppleSelect
                value={selectedProviderId}
                disabled={formDisabled}
                ariaLabel="服务商"
                options={aiProviderSelectOptions}
                onChange={updateProvider}
              />
            </label>

            <label className="settingsField">
              <span>接口地址（Base URL）</span>
              <input
                type="url"
                value={form.baseUrl}
                disabled={formDisabled}
                onChange={(event) => updateField("baseUrl", event.target.value)}
                placeholder="https://api.example.com"
              />
              <p className="llmFieldHint">
                <Info size={14} aria-hidden="true" />
                <span>预设服务商会自动填入地址；自定义服务商需填写兼容 OpenAI 接口的地址。</span>
              </p>
            </label>

            <label className="settingsField">
              <span>API Key</span>
              <div className="secretInputWrap">
                <KeyRound size={16} aria-hidden="true" />
                <input
                  type={showApiKey ? "text" : "password"}
                  value={form.apiKey}
                  disabled={formDisabled}
                  onChange={(event) => updateField("apiKey", event.target.value)}
                  placeholder={loadingSummary ? "正在读取已保存配置" : "输入当前接口的 API Key"}
                />
                <button
                  className="secretInputToggle"
                  type="button"
                  disabled={formDisabled}
                  aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                  title={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                  onClick={() => setShowApiKey((visible) => !visible)}
                >
                  {showApiKey ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                </button>
              </div>
              <p className={savedKeyBelongsToAnotherEndpoint ? "llmFieldHint warning" : "llmFieldHint"}>
                {savedKeyBelongsToAnotherEndpoint ? <Info size={14} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
                <span>
                  {savedKeyBelongsToAnotherEndpoint
                    ? "接口地址已更换，请输入新地址自己的 API Key。"
                    : canReuseSavedApiKey
                      ? "此地址已有已保存的 API Key，留空即可复用。"
                      : "密钥只保存在本机，不会写入桌宠配置文件。"}
                </span>
              </p>
            </label>
          </div>
        </section>

        <section className="llmSection" aria-labelledby="llm-model-title">
          <div className="llmSectionHeader">
            <div className="llmSectionHeading">
              <span className="llmStep" aria-hidden="true">2</span>
              <div>
                <h3 id="llm-model-title">选择模型</h3>
                <p>先获取服务提供的模型列表，再从中选择要使用的模型。</p>
              </div>
            </div>
            <button
              className="secondaryAction llmInlineAction llmCapabilityHeaderAction"
              type="button"
              disabled={formDisabled || !hasUsableApiKey}
              onClick={() => void connectModels()}
            >
              <List size={17} aria-hidden="true" />
              {connecting ? "获取中" : "获取模型列表"}
            </button>
          </div>

          <label className="settingsField llmModelField">
            <span>模型 ID</span>
            <AppleSelect
              value={form.model}
              disabled={formDisabled || !models.length}
              ariaLabel="模型 ID"
              placeholder={models.length ? "请选择模型" : "请先获取模型列表"}
              options={models.map((model) => ({
                value: model.id,
                label: model.name
              }))}
              onChange={(nextModel) => updateField("model", nextModel)}
            />
            <p className="llmFieldHint">
              <Info size={14} aria-hidden="true" />
              <span>{models.length ? `已获取 ${models.length} 个模型，请从列表中选择。` : "请先点击“获取模型列表”，再从服务返回的模型中选择。"}</span>
            </p>
          </label>
        </section>

        <section className="llmSection" aria-labelledby="llm-capability-title">
          <div className="llmSectionHeader">
            <div className="llmSectionHeading">
              <span className="llmStep" aria-hidden="true">3</span>
              <div>
                <h3 id="llm-capability-title">当前能力</h3>
              </div>
            </div>
            <button
              className="secondaryAction llmInlineAction"
              type="button"
              disabled={testOutputDisabled}
              onClick={() => void testOutputCapability()}
            >
              <PlugZap size={17} aria-hidden="true" />
              {testingOutput ? "测试中" : "测试 AI 回复"}
            </button>
          </div>

          <div className="llmCapabilityCard">
            {activeOutputCapability ? (
              <>
                <div className="llmCapabilitySummary">
                  <CheckCircle2 size={20} aria-hidden="true" />
                  <div>
                    <strong>{getCapabilityStatusLabel(activeOutputCapability)}</strong>
                    <span>当前模型已完成固定格式探测，聊天会按以下能力工作。</span>
                  </div>
                </div>
                <div className="llmCapabilityTags" aria-label="当前可用能力">
                  {capabilityItems.map((item) => <span key={item}>{item}</span>)}
                </div>
              </>
            ) : (
              <div className="llmCapabilitySummary pending">
                <Info size={20} aria-hidden="true" />
                <div>
                  <strong>{outputResult ? "这次测试没有完成" : "还没有验证当前模型"}</strong>
                  <span>{outputResult?.message ?? "点击“测试 AI 回复”即可验证；保存时也会自动验证。"}</span>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      {credentialMessage ? (
        <div className="settingsResult error" role="alert">
          <XCircle size={17} aria-hidden="true" />
          <span>{credentialMessage}</span>
        </div>
      ) : null}

      {asyncError ? (
        <div className="settingsResult error" role="alert">
          <XCircle size={17} aria-hidden="true" />
          <span>{asyncError}</span>
        </div>
      ) : null}

      <SaveSuccessToast
        result={modelFeedbackResult}
        title="模型列表已更新"
        message={modelResult?.message ?? "已获取模型列表。"}
      />

      {modelResult && !modelResult.ok ? (
        <div className="settingsResult error" role="alert">
          <XCircle size={17} aria-hidden="true" />
          <span>{modelResult.message}</span>
        </div>
      ) : null}

      <SaveSuccessToast result={saveFeedbackResult} title="已保存并应用" />

      {result && !result.test.ok ? (
        <div className="settingsResult error" role="alert">
          <XCircle size={17} aria-hidden="true" />
          <span>{result.test.message}</span>
        </div>
      ) : null}

      <div className="settingsActions llmSettingsActions">
        <button
          className="primaryAction"
          type="button"
          disabled={saving || connecting || testingOutput || loadingSummary || !form.model || !hasUsableApiKey}
          onClick={() => void saveSettings()}
        >
          <Save size={17} aria-hidden="true" />
          {saving ? "保存中" : "保存并应用"}
        </button>
      </div>
    </div>
  );
}
