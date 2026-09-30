import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { useBoardStore } from "../whiteboard/store";
import { canCutRegion } from "../whiteboard/regionEditing";
import { canEditBoard } from "../collaboration/access";
import { useSessionStore } from "../collaboration/session";
import {
  breakpointColor, isRegionTimeline, regionTweenBounds,
  MIN_REGION_ZOOM, MAX_REGION_ZOOM, type Breakpoint,
} from "../whiteboard/model";
import "./zoom-regions.css";

const LOG_MIN = Math.log2(MIN_REGION_ZOOM);
const LOG_MAX = Math.log2(MAX_REGION_ZOOM);
const TICKS = [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8];
type Handle = "divider" | "in" | "out";
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const formatZoom = (zoom: number) => `${Number((zoom * 100).toFixed(1))}%`;
const sorted = (breakpoints: Breakpoint[]) => [...breakpoints].sort((a, b) => a.zoom - b.zoom);

/** Pan is canvas-local, not window-local (the sidebars are not part of it). */
function scrubZoom(value: number) {
  const state = useBoardStore.getState();
  const canvas = document.querySelector<HTMLElement>(".canvas-wrapper");
  const next = clamp(value, MIN_REGION_ZOOM, MAX_REGION_ZOOM);
  if (canvas) {
    const cx = canvas.clientWidth / 2;
    const cy = canvas.clientHeight / 2;
    const worldX = (cx - state.panX) / state.zoom;
    const worldY = (cy - state.panY) / state.zoom;
    state.setZoom(next);
    state.setPan(cx - worldX * next, cy - worldY * next);
  } else {
    state.setZoom(next);
  }
}

/** Pick a pure presentation, excluding both adjacent tween windows. */
function selectRegion(id: string) {
  const bps = sorted(useBoardStore.getState().board.breakpoints);
  const index = bps.findIndex((bp) => bp.id === id);
  if (index < 0) return;
  const low = regionTweenBounds(bps, id).end;
  const next = bps[index + 1];
  const high = next ? regionTweenBounds(bps, next.id).start : MAX_REGION_ZOOM;
  scrubZoom(Math.sqrt(low * Math.max(low, high)));
}

function handleZoom(bp: Breakpoint, kind: Handle, bps: Breakpoint[]) {
  const bounds = regionTweenBounds(bps, bp.id);
  return kind === "divider" ? bp.zoom : kind === "in" ? bounds.start : bounds.end;
}

/** Read fresh dividers on every move; never retain a stale board during a drag. */
function moveHandle(id: string, kind: Handle, value: number, recordHistory: boolean) {
  if (!canEditBoard()) return false;
  const state = useBoardStore.getState();
  const bps = sorted(state.board.breakpoints);
  if (!isRegionTimeline(bps)) return false;
  const index = bps.findIndex((bp) => bp.id === id);
  if (index <= 0) return false;
  const bp = bps[index];
  let patch: Partial<Breakpoint>;
  if (kind === "divider") {
    patch = { zoom: clamp(value, MIN_REGION_ZOOM, MAX_REGION_ZOOM) };
    if (Math.abs(Math.log2(patch.zoom! / bp.zoom)) < 1e-9) return false;
  } else {
    const key = kind === "in" ? "tweenIn" : "tweenOut";
    const width = Math.max(0, Math.log2(kind === "in" ? bp.zoom / value : value / bp.zoom));
    // A snap boundary starts with two zero-width sides; opening one keeps the
    // other closed. Clamp to the same effective bounds used by the renderer.
    const candidate = {
      ...bp,
      ...(bp.transition === "snap" ? { tweenIn: 0, tweenOut: 0 } : {}),
      [key]: width,
      transition: "crossfade" as const,
    };
    const proposed = bps.map((item) => item.id === id ? candidate : item);
    const edge = handleZoom(candidate, kind, proposed);
    if (Math.abs(Math.log2(edge / handleZoom(bp, kind, bps))) < 1e-9) return false;
    patch = {
      ...(bp.transition === "snap" ? { tweenIn: 0, tweenOut: 0 } : {}),
      [key]: Math.max(0, Math.log2(kind === "in" ? bp.zoom / edge : edge / bp.zoom)),
      transition: "crossfade",
    };
  }
  state.updateBreakpoint(id, patch, recordHistory);
  return useBoardStore.getState().board !== state.board;
}

export default function ZoomTimeline() {
  const breakpoints = useBoardStore((state) => state.board.breakpoints);
  const zoom = useBoardStore((state) => state.zoom);
  const activeId = useBoardStore((state) => state.activeBreakpointId);
  const editable = useSessionStore((state) =>
    state.role !== "guest" || (state.status === "online" && state.allowEditing));
  const regions = isRegionTimeline(breakpoints);
  const canEdit = editable && regions;
  const bps = sorted(breakpoints);
  const selected = bps.find((bp) => bp.id === activeId);
  const [view, setView] = useState({ min: LOG_MIN, max: LOG_MAX });
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const mergeAnchorRef = useRef<string | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const endDragRef = useRef<(() => void) | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => () => endDragRef.current?.(), []);
  useEffect(() => {
    if (!canEdit) endDragRef.current?.();
  }, [canEdit]);

  // Native non-passive listener keeps wheel gestures within the timeline.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (endDragRef.current) return;
      const rect = track.getBoundingClientRect();
      if (!rect.width) return;
      const anchor = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      setView((previous) => {
        const range = previous.max - previous.min;
        const nextRange = clamp(range * Math.exp(clamp(event.deltaY, -200, 200) * 0.003), 0.2, LOG_MAX - LOG_MIN);
        const min = clamp(previous.min + anchor * (range - nextRange), LOG_MIN, LOG_MAX - nextRange);
        return { min, max: min + nextRange };
      });
    };
    track.addEventListener("wheel", onWheel, { passive: false });
    return () => track.removeEventListener("wheel", onWheel);
  }, []);

  const percent = (value: number) => (Math.log2(value) - view.min) / (view.max - view.min) * 100;
  const zoomAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect?.width) return useBoardStore.getState().zoom;
    const current = viewRef.current;
    return 2 ** (current.min + clamp((clientX - rect.left) / rect.width, 0, 1) * (current.max - current.min));
  };

  function startDrag(event: PointerEvent<HTMLElement>, kind: Handle | "scrub", id?: string) {
    if (event.button !== 0 || !event.isPrimary || (kind !== "scrub" && !canEdit)) return;
    event.preventDefault();
    event.stopPropagation();
    endDragRef.current?.();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const initialX = event.clientX;
    const initialPointerLog = Math.log2(zoomAt(initialX));
    const currentBps = useBoardStore.getState().board.breakpoints;
    const bp = currentBps.find((item) => item.id === id);
    const initialLog = bp && kind !== "scrub" ? Math.log2(handleZoom(bp, kind, currentBps)) : initialPointerLog;
    let recorded = false;
    let moved = false;
    target.setPointerCapture(pointerId);
    const update = (move: globalThis.PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      if (kind === "scrub") {
        scrubZoom(zoomAt(move.clientX));
      } else if (id) {
        moved ||= Math.abs(move.clientX - initialX) >= 2;
        if (!moved) return;
        const value = 2 ** (initialLog + Math.log2(zoomAt(move.clientX)) - initialPointerLog);
        if (moveHandle(id, kind, value, !recorded)) recorded = true;
      }
    };
    const finish = () => {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", finish);
      target.removeEventListener("lostpointercapture", finish);
      endDragRef.current = null;
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    };
    const onUp = (up: globalThis.PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      update(up);
      finish();
    };
    const onCancel = (cancel: globalThis.PointerEvent) => {
      if (cancel.pointerId === pointerId) finish();
    };
    endDragRef.current = finish;
    window.addEventListener("pointermove", update);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", finish);
    target.addEventListener("lostpointercapture", finish);
    if (kind === "scrub") scrubZoom(zoomAt(event.clientX));
  }

  function nudge(event: KeyboardEvent<HTMLElement>, kind: Handle | "scrub", id?: string) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const state = useBoardStore.getState();
    const bp = state.board.breakpoints.find((item) => item.id === id);
    const current = kind === "scrub" ? state.zoom : bp ? handleZoom(bp, kind, state.board.breakpoints) : state.zoom;
    const delta = (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 0.1 : 0.025);
    const value = event.key === "Home" ? MIN_REGION_ZOOM : event.key === "End" ? MAX_REGION_ZOOM : current * 2 ** delta;
    if (kind === "scrub") scrubZoom(value);
    else if (id && canEdit) moveHandle(id, kind, value, true);
  }

  function cut(value: number) {
    if (!canEdit || !canEditBoard()) return;
    const state = useBoardStore.getState();
    if (!isRegionTimeline(state.board.breakpoints)) return;
    if (state.addBreakpoint(value)) scrubZoom(value);
  }

  function clickRegion(id: string, extend: boolean) {
    const anchor = mergeAnchorRef.current ?? activeId;
    const from = bps.findIndex((bp) => bp.id === anchor);
    const to = bps.findIndex((bp) => bp.id === id);
    if (extend && canEdit && from >= 0 && to >= 0) {
      // Shift+click selects the contiguous run between the anchor and target.
      const [lo, hi] = from < to ? [from, to] : [to, from];
      setMergeIds(bps.slice(lo, hi + 1).map((bp) => bp.id));
      return;
    }
    mergeAnchorRef.current = id;
    setMergeIds([]);
    selectRegion(id);
  }

  function mergeSelected() {
    if (!canEdit || !canEditBoard()) return;
    const keep = useBoardStore.getState().mergeRegions(mergeIds);
    setMergeIds([]);
    if (keep) {
      mergeAnchorRef.current = keep;
      selectRegion(keep);
    }
  }

  function commitName(input: HTMLInputElement, id: string) {
    const bp = useBoardStore.getState().board.breakpoints.find((item) => item.id === id);
    const name = input.value.trim();
    if (canEdit && canEditBoard() && bp && name && name !== bp.name) {
      useBoardStore.getState().updateBreakpoint(id, { name });
    } else if (bp) input.value = bp.name;
  }

  const playhead = percent(zoom);
  const viewZoomed = view.min > LOG_MIN + 0.001 || view.max < LOG_MAX - 0.001;
  const canCut = canEdit && canCutRegion(bps, zoom);
  const liveMergeIds = mergeIds.filter((id) => bps.some((bp) => bp.id === id));

  return (
    <section className="zoom-regions" aria-label="Zoom region timeline" onKeyDown={(event) => {
      // Keep canvas editing shortcuts out of focused timeline controls, but
      // let the application's undo/redo shortcut complete a timeline gesture.
      if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase()) && !(event.target instanceof HTMLInputElement)) {
        endDragRef.current?.();
      } else {
        if (event.key === "Escape") {
          endDragRef.current?.();
          setMergeIds([]);
        }
        event.stopPropagation();
      }
    }}>
      <div className="zr-toolbar">
        <span className="zr-heading">Zoom regions</span>
        <output className="zr-zoom" aria-label="Canvas zoom">{formatZoom(zoom)}</output>
        <button className="zr-button zr-primary" disabled={!canCut} onClick={() => cut(zoom)} title={canCut ? "Split the current region at the playhead; both sides start with the same appearance" : "Move the playhead farther from a divider or narrow its tween to split here"}>+ New Region</button>
        {regions && selected && (
          <input
            key={`${selected.id}:${selected.name}`}
            ref={nameRef}
            className="zr-name"
            aria-label="Selected region name"
            title="Rename selected region"
            defaultValue={selected.name}
            disabled={!canEdit}
            onBlur={(event) => commitName(event.currentTarget, selected.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                event.currentTarget.value = selected.name;
                event.currentTarget.blur();
              }
            }}
          />
        )}
        {canEdit && liveMergeIds.length > 1 && (
          <button className="zr-button zr-primary" onClick={mergeSelected} title="Combine the selected regions into one, keeping the leftmost region's appearance">Merge {liveMergeIds.length} regions</button>
        )}
        {!editable && <span className="zr-readonly">View only</span>}
        <button className="zr-button zr-reset" disabled={!viewZoomed} onClick={() => setView({ min: LOG_MIN, max: LOG_MAX })} title="Show the full 5–800% zoom range">Reset view</button>
      </div>

      <div className="zr-body">
        <div className="zr-row-labels" aria-hidden="true"><span>Zoom</span><span>Regions</span><span>Tween in</span><span>Tween out</span></div>
        <div className="zr-track" ref={trackRef}>
          <div className="zr-ruler" role="slider" tabIndex={0} aria-label="Canvas zoom playhead" aria-valuemin={5} aria-valuemax={800} aria-valuenow={zoom * 100} aria-valuetext={formatZoom(zoom)} onPointerDown={(event) => startDrag(event, "scrub")} onKeyDown={(event) => nudge(event, "scrub")} title="Drag to scrub canvas zoom · scroll to zoom this timeline">
            {TICKS.map((tick) => {
              const x = percent(tick);
              return x >= 0 && x <= 100 ? <span key={tick} className={`zr-tick${x < 1 ? " zr-tick-first" : x > 99 ? " zr-tick-last" : ""}`} style={{ left: `${x}%` }}>{formatZoom(tick)}</span> : null;
            })}
          </div>
          <div className="zr-clips">
            {!regions ? (
              <div className="zr-legacy">Legacy zoom timeline — reopen locally to upgrade</div>
            ) : bps.map((bp, index) => {
              const left = clamp(percent(bp.zoom), 0, 100);
              const right = clamp(percent(bps[index + 1]?.zoom ?? MAX_REGION_ZOOM), 0, 100);
              if (right <= left) return null;
              return <button
                key={bp.id}
                className={`zr-clip${bp.id === activeId ? " zr-selected" : ""}${liveMergeIds.includes(bp.id) ? " zr-merge-selected" : ""}`}
                style={{ left: `${left}%`, width: `${right - left}%`, "--region-color": breakpointColor(bps, bp.id) } as CSSProperties}
                aria-pressed={bp.id === activeId || liveMergeIds.includes(bp.id)}
                title={`${bp.name} · ${formatZoom(bp.zoom)}–${formatZoom(bps[index + 1]?.zoom ?? MAX_REGION_ZOOM)} · Click to select, Shift+click to select adjacent regions to merge, double-click to rename`}
                onClick={(event) => clickRegion(bp.id, event.shiftKey)}
                onDoubleClick={(event) => {
                  if (canEdit && !event.shiftKey) { nameRef.current?.focus(); nameRef.current?.select(); }
                }}
              ><span>{bp.name}</span></button>;
            })}
          </div>
          <div className="zr-tween-lane zr-in-lane" />
          <div className="zr-tween-lane zr-out-lane" />
          {regions && bps.slice(1).map((bp) => {
            const { start, end } = regionTweenBounds(bps, bp.id);
            const left = clamp(percent(start), 0, 100);
            const right = clamp(percent(end), 0, 100);
            return <div className="zr-boundary" key={bp.id} style={{ "--region-color": breakpointColor(bps, bp.id) } as CSSProperties}>
              {right > left && <div className="zr-tween-band" style={{ left: `${left}%`, width: `${right - left}%` }} title={`${bp.name} tween: ${formatZoom(start)}–${formatZoom(end)}`} />}
              {(["divider", "in", "out"] as const).map((kind) => {
                const value = handleZoom(bp, kind, bps);
                const x = percent(value);
                if (x < 0 || x > 100) return null;
                const label = `${bp.name} ${kind === "divider" ? "start divider" : `tween ${kind} edge`}`;
                return <button
                  key={kind}
                  className={`zr-handle zr-handle-${kind}`}
                  style={{ left: `${x}%` }}
                  disabled={!canEdit}
                  role="slider"
                  aria-label={label}
                  aria-valuemin={5}
                  aria-valuemax={800}
                  aria-valuenow={value * 100}
                  aria-valuetext={formatZoom(value)}
                  title={`${label}: ${formatZoom(value)} · drag or use arrow keys`}
                  onPointerDown={(event) => startDrag(event, kind, bp.id)}
                  onKeyDown={(event) => nudge(event, kind, bp.id)}
                  onClick={(event) => event.stopPropagation()}
                >{kind === "in" ? "╱" : kind === "out" ? "╲" : ""}</button>;
              })}
            </div>;
          })}
          {playhead >= 0 && playhead <= 100 && <div className="zr-playhead" style={{ left: `${playhead}%` }} aria-hidden="true" />}
        </div>
      </div>
    </section>
  );
}
