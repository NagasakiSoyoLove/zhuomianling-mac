import {
  CheckCircle2,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  Link2,
  LoaderCircle,
  Lock,
  RefreshCw,
  ShieldCheck,
  XCircle
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { normalizeAiBaseUrl } from "../../../shared/types/ai";
import type { PetDefinition, LocalPetSaveResult } from "../../../shared/types/pet";
import type {
  ScreenAwarenessAvailability,
  ScreenVisionConnectionDraft,
  ScreenVisionModelListResult,
  ScreenVisionProbeResult
} from "../../../shared/types/screen";
import { AppleSelect, PanelSaveActions } from "./EditorShared";
import { runWithMinimumVisionTestDuration } from "./visionTestTiming";

interface VisionPanelProps {
  pet: PetDefinition;
  onSavedPet?: (pet: PetDefinition) => void;
  onDirtyChange: (dirty: boolean) => void;
}

function capabilityLabel(state: ScreenAwarenessAvailability["effectiveVisionCapabilityState"]): string {
  switch (state) {
    case "tested": return "已验证";
    case "unsupported": return "不支持图片理解";
    case "stale": return "需要重新检测";
    case "transient-error": return "暂时不可用";
    default: return "未检测";
  }
}

function isValidLlm(summary: { baseUrl: string; model: string; hasApiKey: boolean } | undefined): boolean {
  return Boolean(summary?.hasApiKey && summary.baseUrl.trim() && summary.model.trim());
}

export function VisionPanel({ pet, onSavedPet, onDirtyChange }: VisionPanelProps): JSX.Element {
  const [llmReady, setLlmReady] = useState<boolean | undefined>();
  const [availability, setAvailability] = useState<ScreenAwarenessAvailability>();
  const [persistentCaptureEnabled, setPersistentCaptureEnabled] = useState(false);
  const [persistentCaptureDirty, setPersistentCaptureDirty] = useState(false);
  const [draft, setDraft] = useState<ScreenVisionConnectionDraft>({
    petId: pet.id,
    providerName: "OpenAI Compatible",
    baseUrl: "",
    model: "",
    apiKey: "",
    models: []
  });
  const [models, setModels] = useState<ScreenVisionConnectionDraft["models"]>([]);
  const [probe, setProbe] = useState<ScreenVisionProbeResult>();
  const [modelResult, setModelResult] = useState<ScreenVisionModelListResult>();
  const [settingsResult, setSettingsResult] = useState<LocalPetSaveResult>();
  const [message, setMessage] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testingTarget, setTestingTarget] = useState<"chat" | "independent">();
  const [savingIndependent, setSavingIndependent] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const testing = testingTarget !== undefined;

  const refreshAvailability = async (): Promise<ScreenAwarenessAvailability | undefined> => {
    try {
      const next = await window.desktopPet?.screenVision.getAvailability(pet.id);
      if (next) {
        setAvailability(next);
        setPersistentCaptureEnabled(next.persistentCaptureEnabled);
        setPersistentCaptureDirty(false);
      }
      return next;
    } catch {
      setMessage("读取视觉状态失败，请稍后重试。");
      return undefined;
    }
  };

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setMessage(undefined);
    setProbe(undefined);
    setModelResult(undefined);
    setSettingsResult(undefined);
    onDirtyChange(false);
    const load = async (): Promise<void> => {
      try {
        const llm = await window.desktopPet?.aiSettings.get(pet.id);
        const ready = isValidLlm(llm);
        if (disposed) return;
        setLlmReady(ready);
        if (!ready) {
          setAvailability(undefined);
          return;
        }
        const next = await window.desktopPet?.screenVision.getAvailability(pet.id);
        if (disposed || !next) return;
        setAvailability(next);
        setPersistentCaptureEnabled(next.persistentCaptureEnabled);
        setPersistentCaptureDirty(false);
        const independent = next.independentModel;
        setDraft({
          petId: pet.id,
          providerName: independent?.providerName ?? "OpenAI Compatible",
          baseUrl: independent?.baseUrl ?? "",
          model: independent?.model ?? "",
          apiKey: "",
          models: independent?.models ?? []
        });
        setModels(independent?.models ?? []);
      } catch {
        if (!disposed) {
          setLlmReady(false);
          setMessage("读取视觉连接失败，请稍后重试。");
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void load();
    return () => { disposed = true; };
  }, [onDirtyChange, pet.id]);

  const chatModel = availability?.chatModel;
  const independentModel = availability?.independentModel;
  const chatCapabilityState = availability?.chatCapabilityState ?? "untested";
  const chatModelTested = chatCapabilityState === "tested";
  const chatModelUnsupported = chatCapabilityState === "unsupported";
  const normalizedDraftBaseUrl = normalizeAiBaseUrl(draft.baseUrl);
  const canReuseSavedIndependentApiKey = Boolean(
    independentModel?.hasApiKey &&
    normalizedDraftBaseUrl &&
    normalizedDraftBaseUrl === normalizeAiBaseUrl(independentModel.baseUrl)
  );
  const hasUsableIndependentApiKey = Boolean(draft.apiKey.trim() || canReuseSavedIndependentApiKey);
  const independentDraftMatchesProbe = Boolean(
    probe?.capability?.fingerprint.normalizedBaseUrl === normalizedDraftBaseUrl &&
    probe?.capability.fingerprint.model === draft.model.trim()
  );
  const independentDraftTested = Boolean(
    probe?.ok && independentDraftMatchesProbe
  );
  const draftMatchesSavedIndependent = Boolean(
    independentModel &&
    normalizedDraftBaseUrl === normalizeAiBaseUrl(independentModel.baseUrl) &&
    draft.model.trim() === independentModel.model.trim()
  );
  const savedIndependentTested = Boolean(
    draftMatchesSavedIndependent && availability?.independentCapabilityState === "tested"
  );
  const independentTested = savedIndependentTested || independentDraftTested;
  const independentCapabilityState = independentDraftMatchesProbe
    ? probe?.state ?? availability?.independentCapabilityState ?? "untested"
    : availability?.independentCapabilityState ?? "untested";
  const independentRouteActive = Boolean(
    chatModelUnsupported || availability?.effectiveVisionModel?.kind === "independent"
  );
  const canEnable = chatModelTested || (independentRouteActive && independentTested);
  const showEnableStep = Boolean(
    chatModelTested || independentRouteActive || availability?.visionEnabled
  );
  const effectiveCapabilityState = chatModelTested
    ? "tested"
    : independentRouteActive
      ? independentTested ? "tested" : independentCapabilityState
      : chatCapabilityState;
  const showPersistentCaptureOption = canEnable && effectiveCapabilityState === "tested";
  const visionSourceLabel = chatModelTested ? "当前聊天模型" : "独立视觉模型";
  const independentOptions = useMemo(
    () => (models ?? []).map((model) => ({ value: model.id, label: model.name || model.id })),
    [models]
  );

  const updateDraft = (patch: Partial<ScreenVisionConnectionDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
    setProbe(undefined);
    setMessage(undefined);
    onDirtyChange(true);
  };

  const buildDraft = (): ScreenVisionConnectionDraft => ({ ...draft, models: models ?? [] });

  const connectModels = async (): Promise<void> => {
    if (!draft.baseUrl.trim() || !hasUsableIndependentApiKey) {
      setMessage(canReuseSavedIndependentApiKey
        ? "请填写独立视觉服务的 Base URL。"
        : "请填写独立视觉服务的 Base URL 和 API Key。 ");
      return;
    }
    setLoadingModels(true);
    setModelResult(undefined);
    setMessage(undefined);
    try {
      const result = await window.desktopPet?.screenVision.listModels(buildDraft());
      if (!result) return;
      setModelResult(result);
      if (result.ok) {
        setModels(result.models);
        updateDraft({ model: result.models[0]?.id ?? "", models: result.models });
      } else setMessage(result.message);
    } catch {
      setMessage("读取视觉模型列表失败，请检查连接信息。");
    } finally {
      setLoadingModels(false);
    }
  };

  const testCurrent = async (): Promise<void> => {
    setTestingTarget("chat");
    setMessage(undefined);
    try {
      const result = await runWithMinimumVisionTestDuration(
        () => window.desktopPet?.screenVision.testCurrent(pet.id)
      );
      if (result) {
        setProbe(result);
        setMessage(result.message);
        await refreshAvailability();
      }
    } catch {
      setMessage("视觉检测失败，请稍后重试。");
    } finally {
      setTestingTarget(undefined);
    }
  };

  const testIndependent = async (): Promise<void> => {
    if (!draft.baseUrl.trim() || !draft.model.trim() || !hasUsableIndependentApiKey) {
      setMessage(canReuseSavedIndependentApiKey
        ? "请填写 Base URL、选择模型后再检测。"
        : "请填写 Base URL、API Key 并选择模型。 ");
      return;
    }
    setTestingTarget("independent");
    setMessage(undefined);
    try {
      const result = await runWithMinimumVisionTestDuration(
        () => window.desktopPet?.screenVision.testIndependent(buildDraft())
      );
      if (result) {
        setProbe(result);
        setMessage(result.message);
      }
    } catch {
      setMessage("独立视觉模型检测失败，请稍后重试。");
    } finally {
      setTestingTarget(undefined);
    }
  };

  const saveIndependent = async (): Promise<boolean> => {
    if (!independentDraftTested) {
      setMessage("请先检测当前独立视觉模型。");
      return false;
    }
    setSavingIndependent(true);
    setMessage(undefined);
    try {
      const summary = await window.desktopPet?.screenVision.saveIndependent(buildDraft());
      if (!summary) return false;
      setSettingsResult({ ok: true, message: "独立视觉模型已保存。" });
      setDraft((current) => ({ ...current, apiKey: "" }));
      onDirtyChange(false);
      await refreshAvailability();
      return true;
    } catch {
      setSettingsResult({ ok: false, message: "保存独立视觉模型失败，请重试。" });
      return false;
    } finally {
      setSavingIndependent(false);
    }
  };

  const saveSettings = async (enabled: boolean): Promise<void> => {
    if (enabled && !canEnable) {
      setMessage("请先完成视觉理解检测。");
      return;
    }
    setSavingSettings(true);
    setSettingsResult(undefined);
    setMessage(undefined);
    try {
      if (enabled && !chatModelTested && independentDraftTested && availability?.independentCapabilityState !== "tested") {
        const saved = await saveIndependent();
        if (!saved) return;
      }
      const result = await window.desktopPet?.screenVision.saveSettings({
        petId: pet.id,
        enabled,
        mode: availability?.mode ?? "quiet",
        persistentCaptureEnabled
      });
      if (!result) return;
      setSettingsResult(result);
      if (result.ok) {
        onDirtyChange(false);
        setPersistentCaptureDirty(false);
        if (result.pet) onSavedPet?.(result.pet);
        await refreshAvailability();
      }
    } catch {
      setSettingsResult({ ok: false, message: "保存视觉功能状态失败，请重试。" });
    } finally {
      setSavingSettings(false);
    }
  };

  if (llmReady === false) {
    return (
      <section className="editorPanel visionPanel" aria-label="视觉功能">
        <div className="visionLockedState">
          <Lock size={26} />
          <h2>视觉功能已锁定</h2>
          <p>请先在“LLM配置”中保存并应用有效的聊天 AI 连接。</p>
        </div>
      </section>
    );
  }

  const visionEnabled = Boolean(availability?.visionEnabled);
  const savingCaptureChanges = showPersistentCaptureOption && persistentCaptureDirty;
  const visionActionLabel = savingCaptureChanges
    ? "保存设置"
    : visionEnabled ? "关闭视觉" : "开启视觉";
  const visionActionIcon = savingCaptureChanges || !visionEnabled
    ? <Eye size={17} />
    : <EyeOff size={17} />;

  return (
    <section className="editorPanel visionPanel" aria-label="视觉功能">
      <div className="panelHeading">
        <div>
          <span className="panelEyebrow"><Eye size={15} />屏幕理解与观察</span>
          <h2>视觉功能</h2>
          <p>先测试当前聊天模型，只有不支持图片理解时才需要配置独立视觉模型。</p>
        </div>
        <span className={availability?.visionEnabled ? "visionEnabledBadge" : "visionDisabledBadge"}>
          {availability?.visionEnabled ? "已开启" : "未开启"}
        </span>
      </div>

      {loading ? <div className="visionLoading"><LoaderCircle className="spin" size={18} />正在读取视觉连接…</div> : null}
      <div className="visionSteps">
        <article className="visionStepCard">
          <div className="visionStepHeader"><span>1</span><h3>测试当前聊天模型</h3></div>
          <div className="visionConnectionSummary">
            <div><span>当前聊天模型</span><strong>{chatModel?.model || "未配置"}</strong></div>
            <small>{chatModel?.providerName || "请先完成 LLM 配置"}</small>
          </div>
          <div className="visionCapabilityLine">
            <span className={chatModelTested ? "ok" : chatModelUnsupported ? "warning" : ""}>
              {chatModelUnsupported ? <Info size={15} /> : <ShieldCheck size={15} />}
              图片理解能力：{capabilityLabel(chatCapabilityState)}
            </span>
            <button className="secondaryAction" type="button" onClick={() => void testCurrent()} disabled={testing || !chatModel}>
              {testingTarget === "chat" ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
              {testingTarget === "chat" ? "正在测试…" : "测试图片理解"}
            </button>
          </div>
          {chatModelTested ? (
            <div className="visionRouteNotice success">
              <CheckCircle2 size={17} />
              <div><strong>已确认可用</strong><span>视觉处理将使用当前聊天模型。</span></div>
            </div>
          ) : null}
          {chatModelUnsupported ? (
            <div className="visionRouteNotice warning">
              <Info size={17} />
              <div><strong>当前模型不支持图片理解</strong><span>下一步配置独立视觉模型。</span></div>
            </div>
          ) : null}
          {chatCapabilityState === "untested" ? (
            <p className="visionStepHint">完成测试后，页面会根据结果决定下一步。</p>
          ) : null}
          {message && !showEnableStep ? (
            <div className={probe?.ok || settingsResult?.ok ? "visionMessage ok" : "visionMessage"} role="status">
              {probe?.ok || settingsResult?.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
              {message}
            </div>
          ) : null}
        </article>

        {independentRouteActive ? (
          <article className="visionStepCard">
            <div className="visionStepHeader">
              <span>2</span>
              <div className="visionStepHeaderCopy">
                <h3>{chatModelUnsupported ? "配置独立视觉模型" : "使用独立视觉模型"}</h3>
                <p>当前为两模型模式：视觉模型分析画面，聊天模型负责回复。若该模型也适合角色对话，请将它配置到“聊天 AI”。</p>
              </div>
            </div>
              <div className="visionFormGrid">
                <label>Base URL<input value={draft.baseUrl} onChange={(event) => updateDraft({ baseUrl: event.target.value, model: "", models: [] })} placeholder="https://…" /></label>
                <label>API Key<input type="password" value={draft.apiKey} onChange={(event) => updateDraft({ apiKey: event.target.value })} placeholder={independentModel?.hasApiKey ? "已保存，可留空复用" : "输入视觉服务密钥"} /></label>
                <div className="visionConnectionActions">
                  <button className="secondaryAction" type="button" onClick={() => void connectModels()} disabled={loadingModels || !draft.baseUrl || !hasUsableIndependentApiKey}>
                    {loadingModels ? <LoaderCircle size={14} className="spin" /> : <Link2 size={14} />}连接并读取模型
                  </button>
                </div>
                <label>视觉模型<AppleSelect value={draft.model} options={independentOptions} onChange={(model) => updateDraft({ model })} disabled={!independentOptions.length || testing} ariaLabel="视觉模型" placeholder="先读取模型列表" /></label>
              </div>
              <div className="visionCapabilityLine">
                <span className={independentTested ? "ok" : independentCapabilityState === "unsupported" ? "warning" : ""}>
                  {independentCapabilityState === "unsupported" ? <Info size={15} /> : <ShieldCheck size={15} />}
                  独立视觉模型：{capabilityLabel(independentCapabilityState)}
                </span>
                <button className="secondaryAction" type="button" onClick={() => void testIndependent()} disabled={testing || !draft.model || !draft.baseUrl || !hasUsableIndependentApiKey}>
                  {testingTarget === "independent" ? <LoaderCircle size={14} className="spin" /> : <Eye size={14} />}
                  {testingTarget === "independent" ? "正在测试…" : "检测独立模型"}
                </button>
              </div>
              <div className="visionIndependentSaveRow">
                <button className="secondaryAction" type="button" onClick={() => void saveIndependent()} disabled={savingIndependent || !independentDraftTested}>
                  {savingIndependent ? <LoaderCircle size={14} className="spin" /> : <KeyRound size={14} />}保存视觉模型
                </button>
              </div>
          </article>
        ) : null}

        {showEnableStep ? (
          <article className="visionStepCard visionCapabilityCard">
            <div className="visionStepHeader"><span>{independentRouteActive ? "3" : "2"}</span><h3>开启视觉功能</h3></div>
            <div className="visionCapabilityResult">
              <span className={canEnable ? "resultIcon ok" : "resultIcon"}>{canEnable ? <CheckCircle2 size={23} /> : <Info size={23} />}</span>
              <div>
                <strong>视觉理解：{capabilityLabel(effectiveCapabilityState)}</strong>
                <p>{canEnable ? `已验证，将使用${visionSourceLabel}。测试成功不会自动开启视觉功能。` : "请先完成独立视觉模型测试。"}</p>
              </div>
            </div>
            {showPersistentCaptureOption ? (
              <div className="visionPersistentCaptureOption">
                <label className="visionPersistentCaptureLabel">
                  <input
                    type="checkbox"
                    checked={persistentCaptureEnabled}
                    onChange={(event) => {
                      const next = event.currentTarget.checked;
                      setPersistentCaptureEnabled(next);
                      setPersistentCaptureDirty(next !== Boolean(availability?.persistentCaptureEnabled));
                      onDirtyChange(next !== Boolean(availability?.persistentCaptureEnabled));
                    }}
                  />
                  <span className="visionPersistentCaptureCopy">
                    <strong>持续开启屏幕捕获</strong>
                    <span>开启后，桌宠打开期间会保持屏幕捕获，让识屏回复更快。</span>
                    <span>优点：大幅加快识屏速度。缺点：会持续占用少量 CPU/GPU、内存和电量。</span>
                    </span>
                  </label>
              </div>
            ) : null}
            {message ? <div className={probe?.ok || settingsResult?.ok ? "visionMessage ok" : "visionMessage"} role="status">{probe?.ok || settingsResult?.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}{message}</div> : null}
            <PanelSaveActions
              onSave={() => void saveSettings(savingCaptureChanges ? visionEnabled : !visionEnabled)}
              saving={savingSettings}
              disabled={!canEnable && !visionEnabled}
              disabledReason={!canEnable && !visionEnabled ? "请先完成视觉理解检测" : undefined}
              result={settingsResult}
              actionLabel={visionActionLabel}
              actionIcon={visionActionIcon}
            />
            {visionEnabled ? <p className="visionEnabledHint">视觉快捷按钮将在当前已打开的桌宠菜单中可见。点击“关闭视觉”会立即停止观察。</p> : null}
          </article>
        ) : null}
      </div>
    </section>
  );
}
