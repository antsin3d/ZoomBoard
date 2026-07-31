import { useRef, useCallback, useState, type CSSProperties } from "react";
import { useBoardStore } from "../whiteboard/store";
import { BASE_ZOOM, breakpointColor, transitionHalfWidth } from "../whiteboard/model";
import type { Breakpoint } from "../whiteboard/model";

// ─── Log-scale helpers ────────────────────────────────────────────────────────

const GLOBAL_LOG_MIN = Math.log2(0.05);
const GLOBAL_LOG_MAX = Math.log2(8);

function makeConverters(viewLogMin: number, viewLogMax: number) {
  const range = viewLogMax - viewLogMin;
  const zoomToViewPct = (z: number) => {
    const logZ = Math.log2(Math.max(0.001, z));
    return ((logZ - viewLogMin) / range) * 100;
  };
  const viewPctToZoom = (pct: number) =>
    Math.pow(2, viewLogMin + (pct / 100) * range);
  return { zoomToViewPct, viewPctToZoom };
}

const SNAP_ZOOMS = [0.1, 0.25, 0.5, 1, 2, 4, 8];
const SNAP_LABELS: Record<number, string> = {
  0.1: "10%", 0.25: "25%", 0.5: "50%", 1: "100%", 2: "200%", 4: "400%", 8: "800%",
};

// ─── Breakpoint marker ────────────────────────────────────────────────────────

interface BpMarkerProps {
  bp: Breakpoint;
  isActive: boolean;
  zoomToViewPct: (z: number) => number;
  viewPctToZoom: (pct: number) => number;
}

function BpMarker({ bp, isActive, zoomToViewPct, viewPctToZoom }: BpMarkerProps) {
  const { board, updateBreakpoint, removeBreakpoint, setZoom, setPan, zoom: currentZoom, panX, panY } = useBoardStore();
  const dragging = useRef(false);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(bp.name);

  const pct = zoomToViewPct(bp.zoom);

  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const track = (e.currentTarget as HTMLElement).closest(".timeline-track") as HTMLDivElement;
    trackRef.current = track;

    const onMove = (me: MouseEvent) => {
      if (!dragging.current || !trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(100, ((me.clientX - rect.left) / rect.width) * 100));
      const newZoom = viewPctToZoom(pct);
      updateBreakpoint(bp.id, { zoom: newZoom });
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [bp.id, updateBreakpoint, viewPctToZoom]);

  const jumpTo = useCallback(() => {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const worldX = (cx - panX) / currentZoom;
    const worldY = (cy - panY) / currentZoom;
    const newZoom = bp.zoom;
    setZoom(newZoom);
    setPan(cx - worldX * newZoom, cy - worldY * newZoom);
  }, [bp.zoom, currentZoom, panX, panY, setZoom, setPan]);

  const commitName = () => {
    updateBreakpoint(bp.id, { name: draftName });
    setEditing(false);
  };

  // Hide if scrolled out of view
  if (pct < -5 || pct > 105) return null;

  return (
    <div
      className={`bp-marker${isActive ? " bp-active" : ""}`}
      style={{
        left: `${pct}%`,
        "--keyframe-color": breakpointColor(board.breakpoints, bp.id),
      } as CSSProperties}
      title={`${bp.name} — ${Math.round(bp.zoom * 100)}%`}
    >
      <div
        className="bp-drag-handle"
        onMouseDown={startDrag}
        onClick={jumpTo}
        onDoubleClick={() => setEditing(true)}
      />
      {editing ? (
        <input
          className="bp-name-input"
          value={draftName}
          autoFocus
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => { if (e.key === "Enter") commitName(); if (e.key === "Escape") setEditing(false); }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="bp-label" onDoubleClick={() => setEditing(true)}>
          {bp.name}
        </span>
      )}
      <button
        className="bp-remove"
        title="Remove breakpoint"
        onClick={(e) => { e.stopPropagation(); removeBreakpoint(bp.id); }}
      >
        ×
      </button>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ZoomTimeline() {
  const { board, zoom, panX, panY, setZoom, setPan, addBreakpoint, activeBreakpointId } = useBoardStore();
  const trackRef = useRef<HTMLDivElement>(null);

  // Timeline viewport — start showing the full global range.
  const [viewLogMin, setViewLogMin] = useState(GLOBAL_LOG_MIN);
  const [viewLogMax, setViewLogMax] = useState(GLOBAL_LOG_MAX);

  const { zoomToViewPct, viewPctToZoom } = makeConverters(viewLogMin, viewLogMax);

  const scrubberPct = zoomToViewPct(zoom);

  // Scroll to zoom the timeline viewport.
  const handleTrackWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pct = (e.clientX - rect.left) / rect.width;
    const logCenter = viewLogMin + pct * (viewLogMax - viewLogMin);
    const scaleFactor = e.deltaY > 0 ? 1.35 : 1 / 1.35;
    const newRange = (viewLogMax - viewLogMin) * scaleFactor;
    const newMin = logCenter - pct * newRange;
    const newMax = newMin + newRange;
    setViewLogMin(Math.max(GLOBAL_LOG_MIN, Math.min(newMin, GLOBAL_LOG_MAX - 0.2)));
    setViewLogMax(Math.min(GLOBAL_LOG_MAX, Math.max(newMax, GLOBAL_LOG_MIN + 0.2)));
  }, [viewLogMin, viewLogMax]);

  const resetTimelineView = useCallback(() => {
    setViewLogMin(GLOBAL_LOG_MIN);
    setViewLogMax(GLOBAL_LOG_MAX);
  }, []);

  // Click on the track to jump canvas zoom there.
  const handleTrackClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".bp-marker")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    const newZoom = viewPctToZoom(pct);
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const worldX = (cx - panX) / zoom;
    const worldY = (cy - panY) / zoom;
    setZoom(newZoom);
    setPan(cx - worldX * newZoom, cy - worldY * newZoom);
  }, [zoom, panX, panY, setZoom, setPan, viewPctToZoom]);

  const handleAddBreakpoint = useCallback(() => {
    const snapped = Math.round(zoom * 100) / 100;
    const existing = board.breakpoints.find((bp) => Math.abs(bp.zoom - snapped) < 0.05);
    if (existing) return;
    addBreakpoint(snapped, `Tier ${Math.round(snapped * 100)}%`);
  }, [zoom, board.breakpoints, addBreakpoint]);

  const isViewZoomed = viewLogMin > GLOBAL_LOG_MIN + 0.01 || viewLogMax < GLOBAL_LOG_MAX - 0.01;

  return (
    <div className="zoom-timeline">
      <div className="timeline-left">
        <button className="tl-btn add-bp" onClick={handleAddBreakpoint} title="Add zoom tier at current zoom">
          + Tier
        </button>
        <span className="tl-zoom-label">{Math.round(zoom * 100)}%</span>
      </div>

      <div
        className="timeline-track"
        ref={trackRef}
        onClick={handleTrackClick}
        onWheel={handleTrackWheel}
      >
        {/* Axis tick marks — only show those in view */}
        {SNAP_ZOOMS.map((z) => {
          const pct = zoomToViewPct(z);
          if (pct < -2 || pct > 102) return null;
          return (
            <div key={z} className="tl-tick" style={{ left: `${pct}%` }}>
              <span className="tl-tick-label">{SNAP_LABELS[z]}</span>
            </div>
          );
        })}

        {/* Transition range bands (behind markers) */}
        {board.breakpoints
          .filter((bp) => bp.transitionRange > 0)
          .map((bp) => {
            const half = transitionHalfWidth(bp);
            const leftPct = zoomToViewPct(bp.zoom - half);
            const rightPct = zoomToViewPct(bp.zoom + half);
            const w = rightPct - leftPct;
            if (w < 0.3) return null;
            return (
              <div
                key={`band-${bp.id}`}
                className={`bp-transition-band${bp.id === activeBreakpointId ? " bp-transition-band-active" : ""}`}
                style={{
                  left: `${Math.max(0, leftPct)}%`,
                  width: `${Math.min(100 - Math.max(0, leftPct), w)}%`,
                  "--keyframe-color": breakpointColor(board.breakpoints, bp.id),
                } as CSSProperties}
              />
            );
          })}

        {/* Fixed "Base" anchor at BASE_ZOOM (1x) — non-removable */}
        {(() => {
          const basePct = zoomToViewPct(BASE_ZOOM);
          if (basePct < -5 || basePct > 105) return null;
          return (
            <div
              className="bp-marker bp-base-anchor"
              style={{ left: `${basePct}%` }}
              title="Base state (1x zoom)"
            >
              <div className="bp-drag-handle bp-base-handle" style={{ cursor: "default" }} />
              <span className="bp-label bp-base-label">Base</span>
            </div>
          );
        })()}

        {/* User-defined breakpoint markers */}
        {board.breakpoints.map((bp) => (
          <BpMarker
            key={bp.id}
            bp={bp}
            isActive={bp.id === activeBreakpointId}
            zoomToViewPct={zoomToViewPct}
            viewPctToZoom={viewPctToZoom}
          />
        ))}

        {/* Current zoom scrubber */}
        {scrubberPct >= -2 && scrubberPct <= 102 && (
          <div className="tl-scrubber" style={{ left: `${scrubberPct}%` }} />
        )}
      </div>

      <div className="timeline-right">
        {isViewZoomed && (
          <button className="tl-btn tl-reset-view" onClick={resetTimelineView} title="Reset timeline zoom">
            ↔ Reset
          </button>
        )}
        <span className="tl-wheel-hint">Scroll to zoom timeline</span>
      </div>
    </div>
  );
}
