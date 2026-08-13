// TIMED DIAGNOSTICS TEST MODULE: legacy pet-window monitor debug trigger.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Bug, Eye, LoaderCircle, Square } from "lucide-react";
import type { PetUiTheme } from "../../shared/types/pet";
import type { ScreenAwarenessPhase } from "./useScreenAwareness";
import { ScreenMonitorDebugPanel } from "./ScreenMonitorDebugPanel";
import {
  screenMonitorDebugEnabled,
  type ScreenMonitorDebugSnapshot
} from "./screenMonitorDebug";

export interface ScreenMonitorStatusPosition {
  right: number;
  bottom: number;
}

const statusChipEdge = 8;

export function shouldShowScreenMonitorStatus(
  phase: ScreenAwarenessPhase,
  panelOpen: boolean,
  manualObservationActive: boolean
): boolean {
  return manualObservationActive && !panelOpen && (
    phase === "watching" || phase === "analyzing" || phase === "retrying"
  );
}

export function clampScreenMonitorStatusPosition(
  position: ScreenMonitorStatusPosition,
  chipWidth: number,
  chipHeight: number,
  viewportWidth: number,
  viewportHeight: number
): ScreenMonitorStatusPosition {
  const maxRight = Math.max(statusChipEdge, viewportWidth - Math.max(0, chipWidth) - statusChipEdge);
  const maxBottom = Math.max(statusChipEdge, viewportHeight - Math.max(0, chipHeight) - statusChipEdge);
  return {
    right: Math.min(Math.max(position.right, statusChipEdge), maxRight),
    bottom: Math.min(Math.max(position.bottom, statusChipEdge), maxBottom)
  };
}

interface StatusChipDrag {
  pointerId: number;
  startX: number;
  startY: number;
  position: ScreenMonitorStatusPosition;
  width: number;
  height: number;
}

export function ScreenMonitorStatusChip({
  theme,
  phase,
  manualObservationActive,
  panelOpen,
  onStop,
  debugSnapshot
}: {
  theme: PetUiTheme;
  phase: ScreenAwarenessPhase;
  manualObservationActive: boolean;
  panelOpen: boolean;
  onStop: () => void;
  debugSnapshot: ScreenMonitorDebugSnapshot;
}): JSX.Element | null {
  const chipRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<StatusChipDrag>();
  const [position, setPosition] = useState<ScreenMonitorStatusPosition>();
  const [dragging, setDragging] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);

  useEffect(() => {
    const handleResize = (): void => {
      const chip = chipRef.current;
      if (!chip) return;
      const rect = chip.getBoundingClientRect();
      setPosition((current) => current
        ? clampScreenMonitorStatusPosition(current, rect.width, rect.height, window.innerWidth, window.innerHeight)
        : current);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!screenMonitorDebugEnabled || !manualObservationActive || panelOpen) {
      setDebugOpen(false);
    }
  }, [manualObservationActive, panelOpen]);

  if (!shouldShowScreenMonitorStatus(phase, panelOpen, manualObservationActive)) return null;
  const analyzing = phase === "analyzing";
  const retrying = phase === "retrying";

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button"))) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const startPosition = clampScreenMonitorStatusPosition(
      {
        right: window.innerWidth - rect.right,
        bottom: window.innerHeight - rect.bottom
      },
      rect.width,
      rect.height,
      window.innerWidth,
      window.innerHeight
    );
    setPosition(startPosition);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      position: startPosition,
      width: rect.width,
      height: rect.height
    };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPosition(clampScreenMonitorStatusPosition(
      {
        right: drag.position.right - (event.clientX - drag.startX),
        bottom: drag.position.bottom - (event.clientY - drag.startY)
      },
      drag.width,
      drag.height,
      window.innerWidth,
      window.innerHeight
    ));
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setPosition((current) => current
      ? clampScreenMonitorStatusPosition(current, drag.width, drag.height, window.innerWidth, window.innerHeight)
      : current);
  };

  return (
    <div
      ref={chipRef}
      className={["screenMonitorStatusChip", `theme-${theme}`, analyzing ? "analyzing" : "", retrying ? "retrying" : "", dragging ? "dragging" : ""].filter(Boolean).join(" ")}
      style={position}
      role="status"
      aria-live="polite"
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
    >
      {analyzing || retrying
        ? <LoaderCircle className="screenMonitorStatusIcon spin" size={14} />
        : <Eye className="screenMonitorStatusIcon" size={14} />}
      <span>{retrying ? "重试中" : analyzing ? "分析中" : "观察中"}</span>
      <button
        type="button"
        title="停止视觉监测"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onStop();
        }}
      >
        <Square size={11} fill="currentColor" />
        <span className="srOnly">停止</span>
      </button>
      {screenMonitorDebugEnabled ? (
        <button
          className="screenMonitorDebugToggle"
          type="button"
          title={debugOpen ? "关闭监测诊断" : "打开监测诊断"}
          aria-label={debugOpen ? "关闭监测诊断" : "打开监测诊断"}
          aria-expanded={debugOpen}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            setDebugOpen((open) => !open);
          }}
        >
          <Bug size={11} />
        </button>
      ) : null}
      {debugOpen ? (
        <ScreenMonitorDebugPanel
          theme={theme}
          phase={phase}
          snapshot={debugSnapshot}
          onClose={() => setDebugOpen(false)}
        />
      ) : null}
    </div>
  );
}
