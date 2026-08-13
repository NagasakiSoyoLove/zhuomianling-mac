import { Eye, LoaderCircle, Monitor, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PetUiTheme } from "../../shared/types/pet";
import type { ScreenAwarenessMode, ScreenSourceKind, ScreenSourceSummary } from "../../shared/types/screen";
import type { ScreenAwarenessPhase } from "./useScreenAwareness";

const screenMonitorPopoverEdge = 8;
const screenMonitorPopoverGap = 18;
const screenMonitorPopoverFallbackWidth = 286;
const screenMonitorPopoverFallbackHeight = 330;

export interface ScreenMonitorPopoverPositionMetrics {
  viewportWidth: number;
  viewportHeight: number;
  anchorX: number;
  anchorY: number;
  popoverWidth: number;
  popoverHeight: number;
  edgePadding?: number;
  gap?: number;
}

export interface ScreenMonitorPopoverPosition {
  left: number;
  top: number;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * Positions the popover around the radial-menu anchor without assuming a fixed
 * content height. If neither side has enough room, it is centered on the
 * anchor and then clamped to the viewport edge.
 */
export function calculateScreenMonitorPopoverPosition({
  viewportWidth,
  viewportHeight,
  anchorX,
  anchorY,
  popoverWidth,
  popoverHeight,
  edgePadding = screenMonitorPopoverEdge,
  gap = screenMonitorPopoverGap
}: ScreenMonitorPopoverPositionMetrics): ScreenMonitorPopoverPosition {
  const safeViewportWidth = Math.max(0, finiteOr(viewportWidth, 0));
  const safeViewportHeight = Math.max(0, finiteOr(viewportHeight, 0));
  const safeEdgePadding = Math.max(0, finiteOr(edgePadding, screenMonitorPopoverEdge));
  const safeGap = Math.max(0, finiteOr(gap, screenMonitorPopoverGap));
  const safeWidth = Math.max(0, finiteOr(popoverWidth, 0));
  const safeHeight = Math.max(0, finiteOr(popoverHeight, 0));
  const safeAnchorX = finiteOr(anchorX, safeViewportWidth / 2);
  const safeAnchorY = finiteOr(anchorY, safeViewportHeight / 2);
  const rightEdge = safeViewportWidth - safeEdgePadding;
  const bottomEdge = safeViewportHeight - safeEdgePadding;
  const maxLeft = Math.max(safeEdgePadding, rightEdge - safeWidth);
  const maxTop = Math.max(safeEdgePadding, bottomEdge - safeHeight);

  const rightCandidate = safeAnchorX + safeGap;
  const leftCandidate = safeAnchorX - safeGap - safeWidth;
  const belowCandidate = safeAnchorY + safeGap;
  const aboveCandidate = safeAnchorY - safeGap - safeHeight;

  const desiredLeft = rightCandidate + safeWidth <= rightEdge
    ? rightCandidate
    : leftCandidate >= safeEdgePadding
      ? leftCandidate
      : safeAnchorX - safeWidth / 2;
  const desiredTop = belowCandidate + safeHeight <= bottomEdge
    ? belowCandidate
    : aboveCandidate >= safeEdgePadding
      ? aboveCandidate
      : safeAnchorY - safeHeight / 2;

  return {
    left: clamp(desiredLeft, safeEdgePadding, maxLeft),
    top: clamp(desiredTop, safeEdgePadding, maxTop)
  };
}

interface ScreenMonitorPopoverProps {
  theme: PetUiTheme;
  position: { x: number; y: number };
  sources: ScreenSourceSummary[];
  sourcesLoading: boolean;
  selectedSource?: ScreenSourceSummary;
  mode: ScreenAwarenessMode;
  phase: ScreenAwarenessPhase;
  error?: string;
  onSelectSource: (source: ScreenSourceSummary) => void;
  onSetMode: (mode: ScreenAwarenessMode) => void;
  onRefreshSources: () => void;
  onStart: () => void;
  onClose: () => void;
}

function sourceLabel(kind: ScreenSourceKind): string {
  return kind === "screen" ? "屏幕" : "窗口";
}

export function ScreenMonitorPopover({
  theme,
  position,
  sources,
  sourcesLoading,
  selectedSource,
  mode,
  phase,
  error,
  onSelectSource,
  onSetMode,
  onRefreshSources,
  onStart,
  onClose
}: ScreenMonitorPopoverProps): JSX.Element {
  const busy = phase === "starting";
  const popoverRef = useRef<HTMLElement>(null);
  const [sourceKindFilter, setSourceKindFilter] = useState<ScreenSourceKind>(selectedSource?.kind ?? "screen");
  useEffect(() => {
    if (selectedSource?.kind) setSourceKindFilter(selectedSource.kind);
  }, [selectedSource?.kind]);
  const [popoverPosition, setPopoverPosition] = useState<ScreenMonitorPopoverPosition>(() => {
    const viewportWidth = typeof window === "undefined" ? 380 : window.innerWidth;
    const viewportHeight = typeof window === "undefined" ? 480 : window.innerHeight;
    return calculateScreenMonitorPopoverPosition({
      viewportWidth,
      viewportHeight,
      anchorX: position.x,
      anchorY: position.y,
      popoverWidth: screenMonitorPopoverFallbackWidth,
      popoverHeight: screenMonitorPopoverFallbackHeight
    });
  });
  const updatePopoverPosition = useCallback((): void => {
    const viewportWidth = typeof window === "undefined" ? 380 : window.innerWidth;
    const viewportHeight = typeof window === "undefined" ? 480 : window.innerHeight;
    const bounds = popoverRef.current?.getBoundingClientRect();
    const nextPosition = calculateScreenMonitorPopoverPosition({
      viewportWidth,
      viewportHeight,
      anchorX: position.x,
      anchorY: position.y,
      popoverWidth: bounds?.width ?? screenMonitorPopoverFallbackWidth,
      popoverHeight: bounds?.height ?? screenMonitorPopoverFallbackHeight
    });
    setPopoverPosition((current) => current.left === nextPosition.left && current.top === nextPosition.top
      ? current
      : nextPosition);
  }, [position.x, position.y]);
  useLayoutEffect(() => {
    updatePopoverPosition();
    const popover = popoverRef.current;
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(updatePopoverPosition);
    if (popover) resizeObserver?.observe(popover);
    window.addEventListener("resize", updatePopoverPosition);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updatePopoverPosition);
    };
  }, [updatePopoverPosition]);
  const visibleSources = useMemo(
    () => sources.filter((source) => source.kind === sourceKindFilter),
    [sourceKindFilter, sources]
  );
  return (
    <section
      ref={popoverRef}
      className={["screenMonitorPopover", `theme-${theme}`, busy ? "busy" : ""].filter(Boolean).join(" ")}
      style={{ left: `${popoverPosition.left}px`, top: `${popoverPosition.top}px` }}
      aria-label="屏幕观察"
      role="dialog"
    >
      <header className="screenMonitorPopoverHeader">
        <span><Eye size={16} />屏幕观察</span>
        <button type="button" title="取消" onClick={onClose}><X size={15} /></button>
      </header>
      <div className="screenMonitorPopoverBody">
        <div className="screenMonitorSourceHeading">
          <span>当前来源</span>
          <button type="button" className="screenMonitorRefreshButton" title="刷新来源" onClick={onRefreshSources} disabled={busy}>
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="screenMonitorSourceFilters" role="group" aria-label="来源类型">
          <button
            className={sourceKindFilter === "screen" ? "selected" : ""}
            type="button"
            aria-pressed={sourceKindFilter === "screen"}
            onClick={() => setSourceKindFilter("screen")}
            disabled={busy}
          >
            选择屏幕
          </button>
          <button
            className={sourceKindFilter === "window" ? "selected" : ""}
            type="button"
            aria-pressed={sourceKindFilter === "window"}
            onClick={() => setSourceKindFilter("window")}
            disabled={busy}
          >
            选择窗口
          </button>
        </div>
        <div className="screenMonitorSourceList" aria-label="屏幕来源">
          {visibleSources.length ? visibleSources.map((source) => (
            <button
              className={selectedSource?.id === source.id ? "screenMonitorSource selected" : "screenMonitorSource"}
              type="button"
              key={source.id}
              onClick={() => onSelectSource(source)}
              disabled={busy}
            >
              <Monitor size={14} />
              <span>{source.name || "未命名来源"}</span>
              <small>{sourceLabel(source.kind)}</small>
            </button>
          )) : (
            <p className="screenMonitorEmpty">
              {busy
                ? `正在抓取${sourceLabel(sourceKindFilter)}…`
                : sourcesLoading
                  ? "正在读取来源…"
                  : "尚未选择"}
            </p>
          )}
        </div>
        <div className="screenMonitorModeBlock">
          <span>监测模式</span>
          <div className="screenMonitorModeButtons" role="group" aria-label="监测模式">
            <button className={mode === "quiet" ? "selected" : ""} type="button" onClick={() => onSetMode("quiet")} disabled={busy}>
              <strong>安静</strong><small>少打扰，只回应重要变化</small>
            </button>
            <button className={mode === "companion" ? "selected" : ""} type="button" onClick={() => onSetMode("companion")} disabled={busy}>
              <strong>陪伴</strong><small>更有回应，有意义的变化更容易接话</small>
            </button>
          </div>
        </div>
        {error ? <p className="screenMonitorError" role="alert">{error}</p> : null}
        <div className="screenMonitorPopoverActions">
          <button className="screenMonitorPrimaryAction" type="button" onClick={onStart} disabled={busy || !selectedSource}>
            {busy ? <LoaderCircle size={15} className="screenMonitorSpinner" /> : <Eye size={15} />}
            {busy ? "开始中" : "开始观察"}
          </button>
        </div>
      </div>
    </section>
  );
}
