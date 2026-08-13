// TIMED DIAGNOSTICS TEST MODULE: paged visual diagnostics dashboard.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  CheckCircle2,
  Clock3,
  Eraser,
  Gauge,
  ListChecks,
  MessageCircle,
  MonitorCog,
  RefreshCw,
  ScanEye,
  TimerReset,
  XCircle
} from "lucide-react";
import {
  TIMED_DIAGNOSTICS_TEST_MODULE,
  type TimedDiagnosticEvent,
  type TimedDiagnosticGroup
} from "../../../shared/types/timedDiagnostics";
import {
  averageTimedDiagnosticRunMs,
  dedupeTimedDiagnosticEvents,
  groupTimedDiagnosticRuns,
  SCREEN_MONITOR_TEST_TIMEOUT_MS,
  TIMED_DIAGNOSTICS_TEST_ENABLED,
  TIMED_DIAGNOSTICS_TEST_MAX_REQUESTS,
  type TimedDiagnosticRun
} from "./timedDiagnosticsTest";

const diagnosticGroups: TimedDiagnosticGroup[] = ["startup", "chat", "vision", "monitor"];

const phaseLabels: Record<TimedDiagnosticEvent["phase"], string> = {
  renderer: "渲染端",
  main: "主进程",
  "vision-model": "视觉模型",
  "chat-model": "聊天模型",
  startup: "启动链路"
};

const groupMeta: Record<TimedDiagnosticGroup, {
  title: string;
  tabLabel: string;
  description: string;
  icon: typeof Activity;
}> = {
  startup: {
    title: "软件启动耗时",
    tabLabel: "软件启动",
    description: "从主进程启动到首屏可用，定位白屏和启动动画到底卡在哪一段。",
    icon: Gauge
  },
  chat: {
    title: "聊天回复耗时",
    tabLabel: "聊天回复",
    description: "普通聊天从发起、请求体、模型首字节到气泡完成的完整链路。",
    icon: MessageCircle
  },
  vision: {
    title: "识图回复耗时",
    tabLabel: "识图回复",
    description: "主动要求桌宠看屏幕时，拆开截图、传输、视觉模型和回复展示阶段。",
    icon: ScanEye
  },
  monitor: {
    title: "自动检测屏幕耗时",
    tabLabel: "自动检测",
    description: "只统计截图真正进入 AI 模型请求的轮次，本地未送达的采样不计入最近 10 次。",
    icon: MonitorCog
  }
};

const statusMeta: Record<TimedDiagnosticRun["status"], { label: string; className: string }> = {
  running: { label: "进行中", className: "running" },
  completed: { label: "完成", className: "completed" },
  failed: { label: "失败", className: "failed" },
  timeout: { label: "超时", className: "timeout" }
};

function formatMilliseconds(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1_000) return (value / 1_000).toFixed(2) + " s";
  return String(Math.round(Math.max(0, value))) + " ms";
}

function formatCompactMilliseconds(value: number): string {
  if (value >= 1_000) return (value / 1_000).toFixed(1) + "s";
  return Math.round(Math.max(0, value)) + "ms";
}

function eventOrder(event: TimedDiagnosticEvent): number {
  return Number(event.eventId.match(/(\d+)(?:\D*)$/u)?.[1] ?? 0);
}

function sortEvents(events: readonly TimedDiagnosticEvent[]): TimedDiagnosticEvent[] {
  return events.slice().sort((left, right) => eventOrder(left) - eventOrder(right));
}

function buildStartupRun(events: readonly TimedDiagnosticEvent[]): TimedDiagnosticRun | undefined {
  const sortedEvents = sortEvents(events);
  const last = sortedEvents.at(-1);
  if (!last) return undefined;
  const failed = sortedEvents.some((event) => !event.ok);
  const completed = last.stage === "splash-hidden" || last.stage === "startup-surface-ready";
  const bottleneck = sortedEvents.slice().sort((left, right) => right.stepMs - left.stepMs)[0];
  return {
    requestId: "startup",
    sequence: 1,
    group: "startup",
    events: sortedEvents,
    totalMs: Math.max(0, last.totalMs),
    timeout: false,
    status: failed ? "failed" : completed ? "completed" : "running",
    ...(bottleneck ? { bottleneck } : {})
  } satisfies TimedDiagnosticRun;
}

function Metric({
  label,
  value,
  tone
}: {
  label: string;
  value: string;
  tone?: "normal" | "warning" | "danger";
}): JSX.Element {
  return (
    <div className={["timedDiagnosticsMetric", tone ? "tone-" + tone : ""].filter(Boolean).join(" ")}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusBadge({ status }: { status: TimedDiagnosticRun["status"] }): JSX.Element {
  const meta = statusMeta[status];
  return (
    <span className={["timedDiagnosticsStatus", meta.className].join(" ")}>
      {status === "completed" ? <CheckCircle2 size={14} /> : null}
      {status === "timeout" ? <AlertTriangle size={14} /> : null}
      {status === "failed" ? <XCircle size={14} /> : null}
      {status === "running" ? <RefreshCw className="timedDiagnosticsSpin" size={14} /> : null}
      {meta.label}
    </span>
  );
}

function EmptyChart({ message, hint }: { message: string; hint: string }): JSX.Element {
  return (
    <div className="timedDiagnosticsEmptyChart">
      <BarChart3 size={30} strokeWidth={1.5} />
      <strong>{message}</strong>
      <span>{hint}</span>
    </div>
  );
}

function ChartCard({
  title,
  description,
  icon: Icon,
  children,
  className = ""
}: {
  title: string;
  description: string;
  icon: typeof BarChart3;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <section className={["timedDiagnosticsChartCard", className].filter(Boolean).join(" ")}>
      <header className="timedDiagnosticsChartHeader">
        <div className="timedDiagnosticsChartTitle">
          <span className="timedDiagnosticsChartIcon"><Icon size={17} /></span>
          <div>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
        </div>
      </header>
      {children}
    </section>
  );
}

function DurationTrendChart({
  group,
  runs
}: {
  group: TimedDiagnosticGroup;
  runs: TimedDiagnosticRun[];
}): JSX.Element {
  const chronologicalRuns = runs.slice().reverse();
  const values = chronologicalRuns.map((run) => run.totalMs);
  const width = 720;
  const height = 250;
  const chartLeft = 58;
  const chartRight = 20;
  const chartTop = 18;
  const chartBottom = 45;
  const chartWidth = width - chartLeft - chartRight;
  const chartHeight = height - chartTop - chartBottom;
  const maximum = Math.max(1, ...values);
  const points = chronologicalRuns.map((run, index) => {
    const x = chronologicalRuns.length === 1
      ? chartLeft + chartWidth / 2
      : chartLeft + index * chartWidth / (chronologicalRuns.length - 1);
    const y = chartTop + chartHeight - run.totalMs / maximum * chartHeight;
    return { x, y, run };
  });
  const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");
  const area = points.length
    ? `M ${points[0].x} ${chartTop + chartHeight} L ${points.map((point) => `${point.x} ${point.y}`).join(" L ")} L ${points.at(-1)?.x ?? chartLeft} ${chartTop + chartHeight} Z`
    : "";
  const ticks = [0, 0.5, 1];
  const groupLabel = groupMeta[group].tabLabel;

  return (
    <ChartCard
      title="总耗时趋势"
      description={group === "startup" ? "启动阶段使用单次启动的累计耗时，右侧阶段图会展开每一步。" : "按最近 10 次请求从旧到新排列，快速判断耗时是否在变长。"}
      icon={BarChart3}
      className="timedDiagnosticsChartCard-trend"
    >
      {points.length ? (
        <div className="timedDiagnosticsSvgChartWrap">
          <svg
            className="timedDiagnosticsSvgChart"
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`${groupLabel}总耗时趋势图，共 ${chronologicalRuns.length} 次`}
          >
            <title>{groupLabel}总耗时趋势</title>
            {ticks.map((tick) => {
              const y = chartTop + chartHeight - tick * chartHeight;
              return (
                <g key={tick}>
                  <line className="timedDiagnosticsChartGridline" x1={chartLeft} x2={width - chartRight} y1={y} y2={y} />
                  <text className="timedDiagnosticsChartAxisLabel" x={chartLeft - 10} y={y + 4} textAnchor="end">
                    {formatCompactMilliseconds(maximum * tick)}
                  </text>
                </g>
              );
            })}
            <line className="timedDiagnosticsChartAxis" x1={chartLeft} x2={width - chartRight} y1={chartTop + chartHeight} y2={chartTop + chartHeight} />
            {area ? <path className="timedDiagnosticsChartArea" d={area} /> : null}
            <polyline className={`timedDiagnosticsChartLine timedDiagnosticsChartLine-${group}`} points={polyline} />
            {points.map(({ x, y, run }) => (
              <g key={run.requestId + "-" + run.sequence}>
                <circle className={`timedDiagnosticsChartPoint timedDiagnosticsChartPoint-${run.status}`} cx={x} cy={y} r="5">
                  <title>{`第 ${run.sequence} 次：${formatMilliseconds(run.totalMs)}，${statusMeta[run.status].label}`}</title>
                </circle>
                <text className="timedDiagnosticsChartValue" x={x} y={Math.max(13, y - 12)} textAnchor="middle">
                  {formatCompactMilliseconds(run.totalMs)}
                </text>
                <text className="timedDiagnosticsChartXLabel" x={x} y={height - 18} textAnchor="middle">
                  #{run.sequence}
                </text>
              </g>
            ))}
          </svg>
          <div className="timedDiagnosticsChartLegend" aria-label="趋势图说明">
            <span><i className={`timedDiagnosticsLegendSwatch timedDiagnosticsLegendSwatch-${group}`} />总耗时</span>
            <span>← 较早</span>
            <span>较新 →</span>
          </div>
        </div>
      ) : (
        <EmptyChart message="还没有趋势数据" hint="执行一次本类检测后，这里会出现折线和准确耗时。" />
      )}
    </ChartCard>
  );
}

function StageBreakdownChart({
  group,
  run,
  selected
}: {
  group: TimedDiagnosticGroup;
  run?: TimedDiagnosticRun;
  selected?: boolean;
}): JSX.Element {
  const events = run?.events ?? [];
  const positiveEvents = events.filter((event) => event.stepMs > 0);
  const maximum = Math.max(1, ...positiveEvents.map((event) => event.stepMs));
  const total = run?.totalMs ?? 0;

  return (
    <ChartCard
      title={run && group !== "startup" && selected ? `第 ${run.sequence} 次阶段分布` : "最近一次阶段分布"}
      description={run
        ? `总耗时 ${formatMilliseconds(total)}，按每个阶段的真实间隔排序。${group === "monitor" ? "请求、响应头、首包和模型输出已拆开；响应头前仍是客户端可观测的合并段。" : group === "startup" ? "" : "点击下方最近记录可切换查看。"}`
        : "执行一次检测后，会显示每个阶段占用的时间。"}
      icon={ListChecks}
      className="timedDiagnosticsChartCard-stages"
    >
      {run && positiveEvents.length ? (
        <div className="timedDiagnosticsStageChart" role="list" aria-label="最近一次阶段耗时条形图">
          {positiveEvents.map((event) => (
            <div className="timedDiagnosticsStageRow" role="listitem" key={event.eventId}>
              <div className="timedDiagnosticsStageLabel">
                <span title={event.label}>{event.label}</span>
                <small>{phaseLabels[event.phase]}</small>
              </div>
              <div className="timedDiagnosticsStageTrack" aria-hidden="true">
                <span
                  className={`timedDiagnosticsStageBar timedDiagnosticsStageBar-${group} ${event.ok ? "" : "is-bad"}`}
                  style={{ width: `${Math.max(2, event.stepMs / maximum * 100)}%` }}
                />
              </div>
              <strong>{formatMilliseconds(event.stepMs)}</strong>
            </div>
          ))}
          <div className="timedDiagnosticsStageAxis">
            <span>0 ms</span>
            <span>单阶段最长 {formatMilliseconds(maximum)}</span>
          </div>
        </div>
      ) : (
        <EmptyChart message="还没有阶段分布" hint="等待这类检测产生第一个阶段事件。" />
      )}
    </ChartCard>
  );
}

function RunTimeline({ run }: { run: TimedDiagnosticRun }): JSX.Element {
  const total = Math.max(1, run.totalMs);
  return (
    <div className="timedDiagnosticsRunTimeline" aria-label="阶段耗时比例">
      {run.events.map((event) => (
        <span
          className={event.ok ? "ok" : "bad"}
          key={event.eventId}
          style={{ width: `${Math.max(2, Math.min(100, event.stepMs / total * 100))}%` }}
          title={`${event.label}：${formatMilliseconds(event.stepMs)}`}
        />
      ))}
    </div>
  );
}

function RunHistory({
  group,
  runs,
  selectedRunRequestId,
  onSelectRun
}: {
  group: TimedDiagnosticGroup;
  runs: TimedDiagnosticRun[];
  selectedRunRequestId?: string;
  onSelectRun?: (run: TimedDiagnosticRun) => void;
}): JSX.Element {
  if (group === "startup") {
    return (
      <section className="timedDiagnosticsInfoCard">
        <header className="timedDiagnosticsInfoHeader">
          <div>
            <h2>启动阶段说明</h2>
            <p>启动只有一条链路，阶段分布图和下方清单会随着启动事件逐步补齐。</p>
          </div>
          <Gauge size={18} />
        </header>
        <div className="timedDiagnosticsInfoList">
          <span><i className="timedDiagnosticsInfoDot is-blue" />本步耗时：当前阶段相对上一个阶段的间隔</span>
          <span><i className="timedDiagnosticsInfoDot is-purple" />累计耗时：从启动计时起点到该阶段完成</span>
          <span><i className="timedDiagnosticsInfoDot is-green" />启动动画隐藏后，启动链路才视为完成</span>
        </div>
      </section>
    );
  }

  return (
    <section className="timedDiagnosticsInfoCard timedDiagnosticsHistoryCard">
      <header className="timedDiagnosticsInfoHeader">
        <div>
          <h2>最近 {TIMED_DIAGNOSTICS_TEST_MAX_REQUESTS} 次请求</h2>
          <p>点击下面任意一条记录，上方阶段图会切换为该次请求的详细步骤。</p>
        </div>
        <span className="timedDiagnosticsCount">保留 {runs.length} 次</span>
      </header>
      {runs.length ? (
        <div className="timedDiagnosticsHistoryList" role="list" aria-label={`${groupMeta[group].title}最近请求`}>
          {runs.map((run) => (
            <article
              className={["timedDiagnosticsHistoryRow", selectedRunRequestId === run.requestId ? "is-selected" : ""].join(" ")}
              role="button"
              tabIndex={0}
              aria-pressed={selectedRunRequestId === run.requestId}
              aria-label={`查看第 ${run.sequence} 次请求的详细步骤`}
              key={run.requestId}
              onClick={() => onSelectRun?.(run)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectRun?.(run);
                }
              }}
            >
              <div className="timedDiagnosticsHistoryTopline">
                <span className="timedDiagnosticsHistoryIndex">第 {run.sequence} 次</span>
                <StatusBadge status={run.status} />
                <strong>{formatMilliseconds(run.totalMs)}</strong>
              </div>
              <RunTimeline run={run} />
              <div className="timedDiagnosticsHistoryMeta">
                <span>最长：{run.bottleneck?.label ?? "—"}</span>
                {run.firstOutputMs !== undefined ? <span>首字节 {formatMilliseconds(run.firstOutputMs)}</span> : null}
                {run.actionMs !== undefined ? <span>action {formatMilliseconds(run.actionMs)}</span> : null}
                {run.decisionMs !== undefined ? <span>最小结果 {formatMilliseconds(run.decisionMs)}</span> : null}
                {run.modelMs !== undefined ? <span>模型 {formatMilliseconds(run.modelMs)}</span> : null}
                {run.detectorMs !== undefined ? <span>本地检测 {formatMilliseconds(run.detectorMs)}</span> : null}
                {run.transferMs !== undefined ? <span>IPC传输 {formatMilliseconds(run.transferMs)}</span> : null}
                {run.requestSerializationMs !== undefined ? <span>JSON 序列化 {formatMilliseconds(run.requestSerializationMs)}</span> : null}
                {run.requestToHeadersMs !== undefined ? <span>请求→响应头 {formatMilliseconds(run.requestToHeadersMs)}</span> : null}
                {run.headersToFirstChunkMs !== undefined ? <span>响应头→首包 {formatMilliseconds(run.headersToFirstChunkMs)}</span> : null}
                {run.firstChunkToOutputMs !== undefined ? <span>首包→首段 {formatMilliseconds(run.firstChunkToOutputMs)}</span> : null}
                {run.outputTailMs !== undefined ? <span>首段→完成 {formatMilliseconds(run.outputTailMs)}</span> : null}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyChart message="还没有请求记录" hint="完成一次送达 AI 的本类请求后，会在这里保留最近 10 次。" />
      )}
    </section>
  );
}

function StartupStageList({ events }: { events: TimedDiagnosticEvent[] }): JSX.Element {
  const sortedEvents = sortEvents(events);
  return (
    <section className="timedDiagnosticsInfoCard timedDiagnosticsStartupListCard">
      <header className="timedDiagnosticsInfoHeader">
        <div>
          <h2>启动阶段清单</h2>
          <p>按真实发生顺序排列，可直接对照启动时间线。</p>
        </div>
        <span className="timedDiagnosticsCount">{events.length} 个阶段</span>
      </header>
      {sortedEvents.length ? (
        <div className="timedDiagnosticsStartupList" role="list" aria-label="软件启动阶段清单">
          {sortedEvents.map((event) => (
            <div className="timedDiagnosticsStartupListRow" role="listitem" key={event.eventId}>
              <span className={["timedDiagnosticsStartupListDot", event.ok ? "" : "is-bad"].join(" ")} />
              <div>
                <strong>{event.label}</strong>
                <small>累计 {formatMilliseconds(event.totalMs)}</small>
              </div>
              <b>{formatMilliseconds(event.stepMs)}</b>
            </div>
          ))}
        </div>
      ) : (
        <EmptyChart message="等待启动事件" hint="从 start-timed.cmd 启动后，启动阶段会自动进入这里。" />
      )}
    </section>
  );
}

export function TimedDiagnosticsTestPage({ onBack }: { onBack: () => void }): JSX.Element | null {
  const [events, setEvents] = useState<TimedDiagnosticEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeGroup, setActiveGroup] = useState<TimedDiagnosticGroup>("startup");
  const [selectedRunRequestId, setSelectedRunRequestId] = useState<string>();

  useEffect(() => {
    if (!TIMED_DIAGNOSTICS_TEST_ENABLED) return undefined;
    const api = window.desktopPet?.timedDiagnosticsTest;
    if (!api) {
      setLoading(false);
      return undefined;
    }
    let mounted = true;
    const unsubscribe = api.onEvent((event) => {
      if (mounted) setEvents((current) => dedupeTimedDiagnosticEvents([...current, event]));
    });
    void api.getSnapshot()
      .then((snapshot) => {
        if (mounted && snapshot.module === TIMED_DIAGNOSTICS_TEST_MODULE) {
          setEvents((current) => dedupeTimedDiagnosticEvents([...current, ...snapshot.events]));
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const normalizedEvents = useMemo(() => dedupeTimedDiagnosticEvents(events), [events]);
  const startupEvents = useMemo(
    () => normalizedEvents.filter((event) => event.group === "startup"),
    [normalizedEvents]
  );
  const startupRun = useMemo(() => buildStartupRun(startupEvents), [startupEvents]);
  const runsByGroup = useMemo<Record<TimedDiagnosticGroup, TimedDiagnosticRun[]>>(() => ({
    startup: startupRun ? [startupRun] : [],
    chat: groupTimedDiagnosticRuns(normalizedEvents, "chat"),
    vision: groupTimedDiagnosticRuns(normalizedEvents, "vision"),
    monitor: groupTimedDiagnosticRuns(normalizedEvents, "monitor")
  }), [normalizedEvents, startupRun]);
  const activeRuns = runsByGroup[activeGroup];
  const activeRun = activeRuns[0];
  const selectedRun = activeRuns.find((run) => run.requestId === selectedRunRequestId) ?? activeRun;
  const hasSelectedRun = selectedRunRequestId !== undefined && activeRuns.some((run) => run.requestId === selectedRunRequestId);
  const activeEvents = activeGroup === "startup" ? startupEvents : activeRun?.events ?? [];
  const average = activeGroup === "startup"
    ? startupRun?.totalMs
    : averageTimedDiagnosticRunMs(activeRuns);
  const timeoutCount = activeRuns.filter((run) => run.timeout).length;
  const bottleneck = activeRun?.bottleneck;
  const activeMeta = groupMeta[activeGroup];
  const ActiveIcon = activeMeta.icon;

  if (!TIMED_DIAGNOSTICS_TEST_ENABLED) return null;

  return (
    <main className="timedDiagnosticsTestPage">
      <header className="timedDiagnosticsPageHeader">
        <div className="timedDiagnosticsPageHeading">
          <button className="timedDiagnosticsBackButton" type="button" onClick={onBack} title="返回主页">
            <ArrowLeft size={17} /><span>主页</span>
          </button>
          <div>
            <p className="timedDiagnosticsEyebrow"><Activity size={14} /> TIMED DIAGNOSTICS TEST MODULE</p>
            <h1>开发者监测</h1>
            <p>每一页只看一条检测链路；图表展示哪里花时间，明细保留精确阶段和数值。</p>
          </div>
        </div>
        <div className="timedDiagnosticsPageActions">
          <span className="timedDiagnosticsLiveBadge"><i />{loading ? "读取历史" : "实时接收"}</span>
          <button className="timedDiagnosticsClearButton" type="button" onClick={() => {
            setEvents([]);
            setSelectedRunRequestId(undefined);
          }}>
            <Eraser size={15} />清空显示
          </button>
        </div>
      </header>

      <nav className="timedDiagnosticsTabs" aria-label="检测分页" role="tablist">
        {diagnosticGroups.map((group) => {
          const meta = groupMeta[group];
          const Icon = meta.icon;
          const runs = runsByGroup[group];
          const count = group === "startup"
            ? (startupEvents.length ? `${startupEvents.length} 阶段` : "待启动")
            : `${runs.length} 次`;
          return (
            <button
              className={["timedDiagnosticsTab", `timedDiagnosticsTab-${group}`, activeGroup === group ? "is-active" : ""].join(" ")}
              type="button"
              role="tab"
              aria-selected={activeGroup === group}
              aria-controls={`timed-diagnostics-panel-${group}`}
              key={group}
              onClick={() => {
                setActiveGroup(group);
                setSelectedRunRequestId(undefined);
              }}
            >
              <span className="timedDiagnosticsTabIcon"><Icon size={17} /></span>
              <span className="timedDiagnosticsTabText"><strong>{meta.tabLabel}</strong><small>{count}</small></span>
              {group === "monitor" && timeoutCount > 0 && activeGroup === group ? <span className="timedDiagnosticsTabAlert">{timeoutCount}</span> : null}
            </button>
          );
        })}
      </nav>

      <section className={`timedDiagnosticsDashboard timedDiagnosticsDashboard-${activeGroup}`} id={`timed-diagnostics-panel-${activeGroup}`} role="tabpanel">
        <header className="timedDiagnosticsDashboardHeader">
          <div className="timedDiagnosticsDashboardTitle">
            <span className="timedDiagnosticsDashboardIcon"><ActiveIcon size={21} /></span>
            <div>
              <p className="timedDiagnosticsSectionKicker">当前分页 · {activeMeta.tabLabel}</p>
              <h2>{activeMeta.title}</h2>
              <p>{activeMeta.description}</p>
            </div>
          </div>
          <div className="timedDiagnosticsDashboardStatus">
            {activeRun ? <StatusBadge status={activeRun.status} /> : <span className="timedDiagnosticsNoDataBadge">等待数据</span>}
            <span>{activeGroup === "startup" ? `${activeEvents.length} 个阶段` : `最近 ${activeRuns.length} 次`}</span>
          </div>
        </header>

        <div className="timedDiagnosticsMetricGrid">
          <Metric label={activeGroup === "startup" ? "启动总耗时" : "最近总耗时"} value={formatMilliseconds(activeRun?.totalMs)} />
          <Metric label={activeGroup === "startup" ? "最长启动阶段" : "平均总耗时"} value={activeGroup === "startup" ? formatMilliseconds(bottleneck?.stepMs) : formatMilliseconds(average)} />
          <Metric label="最长阶段" value={bottleneck?.label ?? "—"} tone={bottleneck && bottleneck.stepMs > 1_000 ? "warning" : "normal"} />
          <Metric
            label={activeGroup === "monitor" ? `${Math.round(SCREEN_MONITOR_TEST_TIMEOUT_MS / 1_000)} 秒超时` : "失败/超时"}
            value={activeGroup === "monitor" ? `${timeoutCount} 次` : String(activeRuns.filter((run) => run.status === "failed" || run.timeout).length) + " 次"}
            tone={timeoutCount || activeRuns.some((run) => run.status === "failed") ? "danger" : "normal"}
          />
        </div>

        {activeGroup === "monitor" ? (
          <div className="timedDiagnosticsThresholdBanner">
            <TimerReset size={16} />
            <span>自动检测总超时阈值</span>
            <strong>{formatMilliseconds(SCREEN_MONITOR_TEST_TIMEOUT_MS)}</strong>
            <small>截图、网络、模型和 JSON 解析都计入；未送达 AI 的本地采样不计入最近 10 次。</small>
          </div>
        ) : null}

        <div className="timedDiagnosticsChartsGrid">
          <DurationTrendChart group={activeGroup} runs={activeRuns} />
          <StageBreakdownChart group={activeGroup} run={selectedRun} selected={hasSelectedRun} />
        </div>

        {activeGroup === "startup"
          ? <StartupStageList events={activeEvents} />
          : <RunHistory
              group={activeGroup}
              runs={activeRuns}
              selectedRunRequestId={selectedRunRequestId}
              onSelectRun={(run) => setSelectedRunRequestId(run.requestId)}
            />}
      </section>

      <footer className="timedDiagnosticsFooter">
        <Clock3 size={14} />
        <span>仅展示阶段、步耗时、累计耗时和状态；不会保存截图、聊天正文、路径或密钥。</span>
      </footer>
    </main>
  );
}
