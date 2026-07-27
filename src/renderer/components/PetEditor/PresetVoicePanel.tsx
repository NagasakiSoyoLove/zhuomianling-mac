import {
  AlertCircle,
  AlertTriangle,
  AudioLines,
  CheckCircle2,
  Languages,
  LoaderCircle,
  Play,
  Search,
  Trash2,
  Volume2,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PetDefinition, PetVoiceLanguage } from "../../../shared/types/pet";
import type {
  PresetVoiceGenerationScope,
  PresetVoiceOverview,
  PresetVoiceTarget,
  PresetVoiceTargetKind,
  PresetVoiceTaskSnapshot
} from "../../../shared/types/presetVoice";
import { base64ToBlob } from "../../pet-window/audioUtils";
import { AppleSelect } from "./EditorShared";
import { eventLabels } from "./editorNavigation";

type TargetFilter = "all" | PresetVoiceTargetKind;
type PresetVoiceDeleteRequest = { kind: "all" } | { kind: "target"; target: PresetVoiceTarget };

const languageOptions: Array<{ value: PetVoiceLanguage; label: string }> = [
  { value: "zh", label: "中文" },
  { value: "ja", label: "日语" },
  { value: "en", label: "英语" }
];

const languageLabels: Record<PetVoiceLanguage, string> = {
  zh: "中文",
  ja: "日语",
  en: "英语"
};

export function getPresetVoiceLanguageLabel(language: PetVoiceLanguage): string {
  return languageLabels[language];
}

function getStatusLabel(target: PresetVoiceTarget): string {
  switch (target.status) {
    case "ready": return `已生成 · ${target.audio ? getPresetVoiceLanguageLabel(target.audio.language) : ""}`;
    case "stale": return "台词文字已修改，需重新生成";
    case "invalid": return "语音资源无效，需重新生成";
    default: return "未生成";
  }
}

function getGroupLabel(target: PresetVoiceTarget): string {
  if (target.kind === "mood-enter-line") return `心情 · ${target.groupLabel}`;
  return `事件 · ${eventLabels.find((event) => event.id === target.event)?.label ?? target.groupLabel}`;
}

export function PresetVoicePanel({
  pet,
  onDirtyChange
}: {
  pet: PetDefinition;
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element {
  const [overview, setOverview] = useState<PresetVoiceOverview>();
  const [task, setTask] = useState<PresetVoiceTaskSnapshot>();
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string>();
  const [filter, setFilter] = useState<TargetFilter>("all");
  const [query, setQuery] = useState("");
  const [generationOpen, setGenerationOpen] = useState(false);
  const [generationTarget, setGenerationTarget] = useState<PresetVoiceTarget>();
  const [scope, setScope] = useState<PresetVoiceGenerationScope>("missing");
  const [translation, setTranslation] = useState<"source" | "translate">("source");
  const [targetLanguage, setTargetLanguage] = useState<PetVoiceLanguage>(
    pet.voiceModelSettings?.language ?? "zh"
  );
  const [starting, setStarting] = useState(false);
  const [deleteRequest, setDeleteRequest] = useState<PresetVoiceDeleteRequest>();
  const [deleting, setDeleting] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement>();
  const previewUrlRef = useRef<string>();

  const loadOverview = useCallback(async (): Promise<void> => {
    try {
      const [nextOverview, nextTask] = await Promise.all([
        window.desktopPet?.presetVoice.getOverview(pet.id),
        window.desktopPet?.presetVoice.getTask(pet.id)
      ]);
      if (nextOverview) setOverview(nextOverview);
      if (nextTask) setTask(nextTask);
      setMessage(undefined);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "预设台词语音读取失败，请重试。");
    } finally {
      setLoading(false);
    }
  }, [pet.id]);

  useEffect(() => {
    onDirtyChange(false);
    setLoading(true);
    setTargetLanguage(pet.voiceModelSettings?.language ?? "zh");
    void loadOverview();
  }, [loadOverview, onDirtyChange, pet.personaPrompt, pet.voiceModelSettings?.language]);

  useEffect(() => window.desktopPet?.presetVoice.onProgress((snapshot) => {
    if (snapshot.petId !== pet.id) return;
    setTask(snapshot);
    if (snapshot.status !== "running") void loadOverview();
  }), [loadOverview, pet.id]);

  useEffect(() => () => {
    previewAudioRef.current?.pause();
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  const visibleTargets = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return (overview?.targets ?? []).filter((target) =>
      (filter === "all" || target.kind === filter) &&
      (!normalizedQuery || target.text.toLocaleLowerCase().includes(normalizedQuery) ||
        getGroupLabel(target).toLocaleLowerCase().includes(normalizedQuery))
    );
  }, [filter, overview?.targets, query]);

  const groups = useMemo(() => {
    const grouped = new Map<string, PresetVoiceTarget[]>();
    for (const target of visibleTargets) {
      const key = `${target.kind}:${target.groupId}`;
      grouped.set(key, [...(grouped.get(key) ?? []), target]);
    }
    return [...grouped.entries()];
  }, [visibleTargets]);

  const pendingCount = overview
    ? overview.summary.missing + overview.summary.stale + overview.summary.invalid
    : 0;
  const coverage = overview?.summary.total
    ? Math.round((overview.summary.ready / overview.summary.total) * 100)
    : 0;
  const running = task?.status === "running";
  const hasStoredAudio = Boolean(overview?.targets.some((target) => target.audio));
  const voiceConfigured = overview?.voiceConfigured ?? Boolean(
    pet.capabilities.voiceOutput && pet.voiceModelSettings?.enabled &&
    pet.voiceModelSettings.connected && pet.voiceModelSettings.referenceAudioPath &&
    pet.voiceModelSettings.referenceText.trim()
  );

  const startGeneration = async (): Promise<void> => {
    setStarting(true);
    setMessage(undefined);
    try {
      const result = await window.desktopPet?.presetVoice.start({
        petId: pet.id,
        scope: generationTarget ? "all" : scope,
        ...(generationTarget ? { targetId: generationTarget.targetId } : {}),
        translation,
        ...(translation === "translate" ? { targetLanguage } : {})
      });
      if (!result?.ok) {
        setMessage(result?.message ?? "预设语音任务未能开始。");
        return;
      }
      setTask(result.task);
      setGenerationOpen(false);
      setGenerationTarget(undefined);
    } catch {
      setMessage("启动预设语音生成任务失败，请重试。");
    } finally {
      setStarting(false);
    }
  };

  const openBatchGeneration = (): void => {
    setGenerationTarget(undefined);
    setScope(pendingCount ? "missing" : "all");
    setGenerationOpen(true);
  };

  const openSingleGeneration = (target: PresetVoiceTarget): void => {
    if (running) return;
    setGenerationTarget(target);
    setGenerationOpen(true);
  };

  const closeGeneration = (): void => {
    if (starting) return;
    setGenerationOpen(false);
    setGenerationTarget(undefined);
  };

  const cancelGeneration = async (): Promise<void> => {
    if (!task) return;
    const result = await window.desktopPet?.presetVoice.cancel({ petId: pet.id, taskId: task.taskId });
    if (!result?.ok) setMessage(result?.message ?? "任务取消失败。");
  };

  const preview = async (target: PresetVoiceTarget): Promise<void> => {
    try {
      previewAudioRef.current?.pause();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      const result = await window.desktopPet?.presetVoice.preview({ petId: pet.id, targetId: target.targetId });
      if (!result?.ok || !result.audioBase64) {
        setMessage(result?.message ?? "预设语音无法试听。");
        return;
      }
      const url = URL.createObjectURL(base64ToBlob(result.audioBase64, result.mimeType ?? "audio/wav"));
      previewUrlRef.current = url;
      const audio = new Audio(url);
      previewAudioRef.current = audio;
      audio.addEventListener("ended", () => {
        if (previewUrlRef.current === url) {
          URL.revokeObjectURL(url);
          previewUrlRef.current = undefined;
          previewAudioRef.current = undefined;
        }
      }, { once: true });
      await audio.play();
    } catch {
      setMessage("预设语音播放失败，请重新生成后再试。");
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (running || !deleteRequest) return;
    setDeleting(true);
    try {
      previewAudioRef.current?.pause();
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = undefined;
        previewAudioRef.current = undefined;
      }
      const result = deleteRequest.kind === "all"
        ? await window.desktopPet?.presetVoice.deleteAll(pet.id)
        : await window.desktopPet?.presetVoice.deleteOne({
            petId: pet.id,
            targetId: deleteRequest.target.targetId
          });
      setMessage(result?.message ?? "预设语音删除失败，请重试。");
      await loadOverview();
    } catch {
      setMessage("预设语音删除失败，请重试。");
    } finally {
      setDeleting(false);
      setDeleteRequest(undefined);
    }
  };

  return <section className="editorPanel presetVoicePanel" aria-label="预设台词语音">
    <div className="panelTitleRow presetVoiceTitleRow">
      <div>
        <h2>预设台词语音</h2>
        <p>统一为所有事件候选台词与心情进入台词生成音频；桌宠运行时不会临时合成。</p>
      </div>
      <div className="presetVoiceTitleActions">
        <span className={voiceConfigured ? "connectionBadge ok" : "connectionBadge wait"}>
          {voiceConfigured ? "声音模型可用" : "声音模型未就绪"}
        </span>
        {hasStoredAudio ? <button className="secondaryAction dangerText" type="button" disabled={running} onClick={() => setDeleteRequest({ kind: "all" })}><Trash2 size={15} />删除全部语音</button> : null}
      </div>
    </div>

    {message ? <div className="settingsHint presetVoiceMessage" role="alert"><AlertCircle size={16} />{message}</div> : null}

    <section className="presetVoiceOverview" aria-label="预设语音覆盖率">
      <div className="presetVoiceOverviewCopy">
        <span className="presetVoiceOverviewIcon" aria-hidden="true"><AudioLines size={22} /></span>
        <div><span>语音覆盖</span><strong>{overview?.summary.ready ?? 0} / {overview?.summary.total ?? 0} 条</strong></div>
      </div>
      <div className="presetVoiceCoverage">
        <div className="presetVoiceProgressTrack" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={coverage} aria-label="预设语音覆盖率">
          <span style={{ width: `${coverage}%` }} />
        </div>
        <div className="presetVoiceCoverageMeta">
          <span>事件 {overview?.summary.eventTotal ?? 0} 条 · 心情 {overview?.summary.moodTotal ?? 0} 条</span>
          <strong>{coverage}%</strong>
        </div>
      </div>
      <button
        className="primaryAction presetVoiceGenerateButton"
        type="button"
        disabled={loading || running || !voiceConfigured || !overview || overview.summary.total === 0}
        title={!voiceConfigured ? "请先保存并连接声音模型" : undefined}
        onClick={openBatchGeneration}
      >
        <Volume2 size={17} />
        {pendingCount ? `生成 ${pendingCount} 条缺失语音` : "重新生成全部"}
      </button>
    </section>

    {running && task ? <section className="presetVoiceTask" aria-live="polite">
      <LoaderCircle className="presetVoiceSpinner" size={20} aria-hidden="true" />
      <div>
        <strong>正在生成 {task.completed} / {task.total}</strong>
        <span>已成功 {task.succeeded} 条{task.failed ? ` · 失败 ${task.failed} 条` : ""}</span>
      </div>
      <button className="secondaryAction" type="button" onClick={() => void cancelGeneration()}>取消任务</button>
    </section> : task && task.status !== "running" ? <p className={task.failed ? "presetVoiceTaskResult warning" : "presetVoiceTaskResult success"} aria-live="polite">
      {task.failed ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}{task.message}
    </p> : null}

    <div className="presetVoiceToolbar">
      <div className="presetVoiceFilters" role="group" aria-label="台词类型筛选">
        {([
          ["all", `全部 ${overview?.summary.total ?? 0}`],
          ["event-line", `事件 ${overview?.summary.eventTotal ?? 0}`],
          ["mood-enter-line", `心情 ${overview?.summary.moodTotal ?? 0}`]
        ] as const).map(([value, label]) => <button
          className={filter === value ? "secondaryAction active" : "secondaryAction"}
          type="button"
          key={value}
          aria-pressed={filter === value}
          onClick={() => setFilter(value)}
        >{label}</button>)}
      </div>
      <label className="presetVoiceSearch">
        <Search size={16} aria-hidden="true" />
        <span className="srOnly">搜索台词</span>
        <input aria-label="搜索台词" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索台词或事件" />
      </label>
    </div>

    <div className="presetVoiceGroups" aria-busy={loading}>
      {loading ? <p className="presetVoiceEmpty"><LoaderCircle className="presetVoiceSpinner" size={20} />正在读取预设台词…</p>
        : groups.length ? groups.map(([key, targets]) => <section className="presetVoiceGroup" key={key}>
          <header><strong>{getGroupLabel(targets[0])}</strong><span>{targets.filter((target) => target.status === "ready").length} / {targets.length}</span></header>
          <div>{targets.map((target) => <article className="presetVoiceLine" key={target.targetId}>
            <div><strong>{target.text}</strong><span className={`presetVoiceStatus ${target.status}`}>{getStatusLabel(target)}</span></div>
            <div className="presetVoiceLineActions">
              <button
                className="secondaryAction presetVoiceSingleGenerate"
                type="button"
                disabled={running || !voiceConfigured}
                title={!voiceConfigured ? "请先保存并连接声音模型" : undefined}
                onClick={() => openSingleGeneration(target)}
              >{running && task?.currentTargetId === target.targetId ? <LoaderCircle className="presetVoiceSpinner" size={15} /> : <Volume2 size={15} />}{target.audio ? "重新生成" : "生成"}</button>
              <button
                className="iconButton"
                type="button"
                disabled={running || target.status !== "ready"}
                title={target.status === "ready" ? "试听预设语音" : "尚无可试听语音"}
                aria-label={`试听台词：${target.text}`}
                onClick={() => void preview(target)}
              ><Play size={16} fill="currentColor" /></button>
              <button
                className="iconButton dangerText"
                type="button"
                disabled={running || !target.audio}
                title={target.audio ? "删除这条预设语音" : "没有可删除的语音"}
                aria-label={`删除台词语音：${target.text}`}
                onClick={() => setDeleteRequest({ kind: "target", target })}
              ><Trash2 size={16} /></button>
            </div>
          </article>)}</div>
        </section>) : <p className="presetVoiceEmpty">{overview?.summary.total ? "没有符合筛选条件的台词。" : "尚未配置事件台词或心情进入台词。"}</p>}
    </div>

    {generationOpen ? createPortal(<div className="presetVoiceDialogBackdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeGeneration();
    }}>
      <section className="presetVoiceDialog" role="dialog" aria-modal="true" aria-labelledby="preset-voice-dialog-title">
        <header><div><span><Languages size={18} /></span><div><h3 id="preset-voice-dialog-title">{generationTarget ? "生成这句台词语音" : "生成预设台词语音"}</h3><p>{generationTarget ? getGroupLabel(generationTarget) : "范围包含所有普通事件台词和心情进入台词。"}</p></div></div><button className="iconButton" type="button" disabled={starting} aria-label="关闭生成设置" onClick={closeGeneration}><X size={17} /></button></header>
        {generationTarget ? <div className="presetVoiceDialogTarget"><span>待生成台词</span><strong>{generationTarget.text}</strong></div> : <fieldset><legend>生成范围</legend>
          <label><input type="radio" name="preset-scope" checked={scope === "missing"} onChange={() => setScope("missing")} /><span><strong>仅生成缺失或过期项</strong><small>保留现有有效音频，预计生成 {pendingCount} 条。</small></span></label>
          <label><input type="radio" name="preset-scope" checked={scope === "all"} onChange={() => setScope("all")} /><span><strong>全部重新生成</strong><small>覆盖当前 {overview?.summary.total ?? 0} 条台词的已有音频。</small></span></label>
        </fieldset>}
        <fieldset><legend>朗读语言</legend>
          <label><input type="radio" name="preset-language" checked={translation === "source"} onChange={() => setTranslation("source")} /><span><strong>按原台词合成</strong><small>使用声音模型当前设置的语言。</small></span></label>
          <label><input type="radio" name="preset-language" checked={translation === "translate"} onChange={() => setTranslation("translate")} /><span><strong>按人设风格化翻译后合成</strong><small>台词和当前宠物人设会发送给该宠物配置的 AI 服务；不会进入聊天或记忆。</small></span></label>
          {translation === "translate" ? <div className="presetVoiceLanguageSelect"><span>目标语言</span><AppleSelect value={targetLanguage} options={languageOptions} ariaLabel="预设语音目标语言" menuBoundarySelector=".presetVoiceDialog" onChange={(value) => setTargetLanguage(value as PetVoiceLanguage)} /></div> : null}
        </fieldset>
        <footer><button className="secondaryAction" type="button" disabled={starting} onClick={closeGeneration}>取消</button><button className="primaryAction" type="button" disabled={starting || (!generationTarget && scope === "missing" && pendingCount === 0)} onClick={() => void startGeneration()}>{starting ? <LoaderCircle className="presetVoiceSpinner" size={17} /> : <Volume2 size={17} />}{starting ? "正在启动" : generationTarget ? "生成这一句" : `开始生成 ${scope === "all" ? overview?.summary.total ?? 0 : pendingCount} 条`}</button></footer>
      </section>
    </div>, document.querySelector("#editor-canvas-overlay") ?? document.body) : null}
    {deleteRequest ? createPortal(<div className="presetVoiceDialogBackdrop" role="presentation" onMouseDown={(event) => {
      if (!deleting && event.target === event.currentTarget) setDeleteRequest(undefined);
    }}>
      <section className="presetVoiceDialog presetVoiceDeleteDialog" role="dialog" aria-modal="true" aria-labelledby="preset-voice-delete-title">
        <header>
          <div><span className="presetVoiceDeleteIcon"><AlertTriangle size={18} /></span><div><h3 id="preset-voice-delete-title">{deleteRequest.kind === "all" ? "删除全部预设语音？" : "删除这条预设语音？"}</h3><p>{deleteRequest.kind === "all" ? "所有事件和心情进入台词的已生成音频都会被移除。" : "只移除这句台词已绑定的音频。"}</p></div></div>
          <button className="iconButton" type="button" disabled={deleting} aria-label="关闭删除确认" onClick={() => setDeleteRequest(undefined)}><X size={17} /></button>
        </header>
        {deleteRequest.kind === "target" ? <div className="presetVoiceDialogTarget presetVoiceDeleteTarget"><span>待删除语音对应台词</span><strong>{deleteRequest.target.text}</strong></div> : null}
        <p className="presetVoiceDeleteHint">台词文本{deleteRequest.kind === "all" ? "、心情参考音频" : ""}不会被删除。</p>
        <footer><button className="secondaryAction" type="button" autoFocus disabled={deleting} onClick={() => setDeleteRequest(undefined)}>取消</button><button className="primaryAction danger" type="button" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? <LoaderCircle className="presetVoiceSpinner" size={17} /> : <Trash2 size={17} />}{deleting ? "正在删除" : deleteRequest.kind === "all" ? "删除全部语音" : "删除这条语音"}</button></footer>
      </section>
    </div>, document.querySelector("#editor-canvas-overlay") ?? document.body) : null}
  </section>;
}
