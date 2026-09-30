import { createContext, useContext, useState, useRef, useMemo, useCallback, useEffect } from "react";
import { useBoardStore } from "../whiteboard/store";
import { DEFAULT_STATE, breakpointColor, type BoardElement, type ElementState } from "../whiteboard/model";
import {
  canMoveLayers,
  isContainer,
  type LayerDropPlace,
} from "../whiteboard/geometry";

// ─── Types ────────────────────────────────────────────────────────────────────

const TYPE_ICON: Record<string, string> = {
  rect: "▭",
  ellipse: "○",
  triangle: "△",
  diamond: "◇",
  hexagon: "⬡",
  star: "☆",
  text: "T",
  sticky: "◆",
  frame: "▣",
  connector: "╱",
  image: "⬜",
  group: "⊞",
};

/** Pointer travel (px) before a press on a row turns into a drag. */
const DRAG_THRESHOLD = 4;
/** Hover time (ms) over a collapsed parent before it opens up. */
const AUTO_EXPAND_DELAY = 500;
const AUTO_SCROLL_EDGE = 28;
const AUTO_SCROLL_SPEED = 12;

type DropTarget =
  | { kind: "row"; id: string; place: LayerDropPlace }
  /** Bottom of the root list — the explicit "unparent to the back" zone. */
  | { kind: "root" }
  | null;

interface LayerRowInfo {
  el: BoardElement;
  depth: number;
  hasChildren: boolean;
  childCount: number;
  expanded: boolean;
}

interface DragState {
  ids: string[];
  label: string;
  x: number;
  y: number;
  target: DropTarget;
  valid: boolean;
}

// ─── Layers context ───────────────────────────────────────────────────────────

interface LayersCtxType {
  handleItemClick: (id: string, shiftHeld: boolean, ctrlHeld?: boolean) => void;
  onRowPointerDown: (id: string, event: React.PointerEvent) => void;
  toggleCollapsed: (id: string) => void;
  dragIds: string[];
  dropTarget: DropTarget;
  dropValid: boolean;
}

const LayersCtx = createContext<LayersCtxType>({
  handleItemClick: () => {/* noop */},
  onRowPointerDown: () => {/* noop */},
  toggleCollapsed: () => {/* noop */},
  dragIds: [],
  dropTarget: null,
  dropValid: false,
});

/** Flatten the hierarchy into the visible row order (topmost layer first). */
function buildRows(elements: BoardElement[], collapsed: Set<string>): LayerRowInfo[] {
  const childrenOf = new Map<string | null, BoardElement[]>();
  for (const el of elements) {
    const key = el.parentId ?? null;
    const bucket = childrenOf.get(key);
    if (bucket) bucket.push(el);
    else childrenOf.set(key, [el]);
  }

  const rows: LayerRowInfo[] = [];
  const walk = (parentId: string | null, depth: number) => {
    // Siblings are stored back-to-front, so the list shows them reversed.
    const siblings = [...(childrenOf.get(parentId) ?? [])].reverse();
    for (const el of siblings) {
      const children = childrenOf.get(el.id) ?? [];
      const expanded = !collapsed.has(el.id);
      rows.push({
        el,
        depth,
        hasChildren: children.length > 0,
        childCount: children.length,
        expanded,
      });
      if (children.length > 0 && expanded) walk(el.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

function placeInRow(clientY: number, rect: DOMRect, nestable: boolean): LayerDropPlace {
  const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
  if (nestable) {
    if (ratio < 0.28) return "above";
    if (ratio > 0.72) return "below";
    return "inside";
  }
  return ratio < 0.5 ? "above" : "below";
}

// ─── Layer row ────────────────────────────────────────────────────────────────

function LayerRow({ row }: { row: LayerRowInfo }) {
  const { el, depth, hasChildren, childCount, expanded } = row;
  const {
    board, selectedIds, toggleVisibility,
    renameElement, removeElement, resolve, activeBreakpointId,
    ungroup,
  } = useBoardStore();
  const {
    handleItemClick, onRowPointerDown, toggleCollapsed,
    dragIds, dropTarget, dropValid,
  } = useContext(LayersCtx);

  const isSelected = selectedIds.includes(el.id);
  const resolved = resolve(el.id);
  const isVisibleHere = resolved?.visible ?? el.base.visible;
  const activeBp = board.breakpoints.find((bp) => bp.id === activeBreakpointId);
  const hasKeyframes = Object.keys(el.keyframes).length > 0;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(el.name);
  const inputRef = useRef<HTMLInputElement>(null);

  // Only frames and groups offer a nest band, so the rest of a row stays
  // reserved for reordering.
  const nestable = isContainer(el);
  const isDragging = dragIds.includes(el.id);
  const rowDrop =
    dropValid && dropTarget?.kind === "row" && dropTarget.id === el.id ? dropTarget.place : null;

  const commit = () => {
    renameElement(el.id, draft.trim() || el.name);
    setEditing(false);
  };

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(el.name);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  return (
    <div
      className={[
        "layer-row",
        isSelected ? "layer-selected" : "",
        isDragging ? "layer-dragging" : "",
        rowDrop === "inside" ? "layer-drop-inside" : "",
        rowDrop === "above" ? "layer-drop-above" : "",
        rowDrop === "below" ? "layer-drop-below" : "",
      ].filter(Boolean).join(" ")}
      style={{ paddingLeft: 8 + depth * 14 }}
      data-layer-row={el.id}
      data-nestable={nestable ? "1" : "0"}
      onPointerDown={(e) => { if (!editing) onRowPointerDown(el.id, e); }}
      onClick={(e) => handleItemClick(el.id, e.shiftKey, e.ctrlKey || e.metaKey)}
    >
      {hasChildren ? (
        <button
          className="layer-expand"
          onClick={(e) => { e.stopPropagation(); toggleCollapsed(el.id); }}
          onPointerDown={(e) => e.stopPropagation()}
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "▾" : "▸"}
        </button>
      ) : (
        <span className="layer-expand-placeholder" />
      )}

      <button
        className="layer-eye"
        title={`${isVisibleHere ? "Hide" : "Show"} ${activeBp ? `in ${activeBp.name}` : "in Base"}`}
        onClick={(e) => { e.stopPropagation(); toggleVisibility(el.id); }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {isVisibleHere ? "●" : "·"}
      </button>

      <span className="layer-icon">{TYPE_ICON[el.type] ?? "?"}</span>

      {editing ? (
        <input
          ref={inputRef}
          className="layer-name-input"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="layer-name" onDoubleClick={startEdit} title={el.name}>
          {el.name}
          {childCount > 0 && <span className="layer-group-count">{childCount}</span>}
        </span>
      )}

      {hasKeyframes && (
        <div className="layer-dots">
          {board.breakpoints.map((bp) => {
            const patch = el.keyframes[bp.id];
            if (!patch || !Object.entries(patch).some(([key, value]) =>
              JSON.stringify(value) !== JSON.stringify(el.base[key as keyof ElementState] ?? DEFAULT_STATE[key as keyof ElementState]),
            )) return null;
            return (
              <span
                key={bp.id}
                className="layer-dot"
                style={{ background: breakpointColor(board.breakpoints, bp.id) }}
                title={`Customized in ${bp.name}`}
              />
            );
          })}
        </div>
      )}

      {isContainer(el) ? (
        <button
          className="layer-delete"
          title="Ungroup"
          onClick={(e) => { e.stopPropagation(); ungroup(el.id); }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          ⊡
        </button>
      ) : (
        <button
          className="layer-delete"
          title="Delete element"
          onClick={(e) => { e.stopPropagation(); removeElement(el.id); }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          ×
        </button>
      )}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export default function LayersPanel() {
  const { board, selectedIds, selectElement, setSelectedIds, moveLayers } = useBoardStore();
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [drag, setDrag] = useState<DragState | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const pendingRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const autoExpandRef = useRef<{ id: string; timer: number } | null>(null);
  const autoScrollDirRef = useRef(0);
  const autoScrollRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (selectedIds.length === 1) setAnchorId(selectedIds[0]);
    else if (selectedIds.length === 0) setAnchorId(null);
  }, [selectedIds]);

  const rows = useMemo(() => buildRows(board.elements, collapsed), [board.elements, collapsed]);
  const orderedIds = useMemo(() => rows.map((row) => row.el.id), [rows]);

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleItemClick = useCallback(
    (id: string, shiftHeld: boolean, ctrlHeld = false) => {
      if (suppressClickRef.current) return;
      if (shiftHeld && anchorId !== null && orderedIds.includes(anchorId) && orderedIds.includes(id)) {
        const a = orderedIds.indexOf(anchorId);
        const b = orderedIds.indexOf(id);
        setSelectedIds(orderedIds.slice(Math.min(a, b), Math.max(a, b) + 1));
      } else if (ctrlHeld) {
        selectElement(id, true);
        setAnchorId(id);
      } else {
        selectElement(id);
        setAnchorId(id);
      }
    },
    [anchorId, orderedIds, selectElement, setSelectedIds],
  );

  const applyDrag = useCallback((next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  const clearAutoExpand = useCallback(() => {
    if (autoExpandRef.current) {
      window.clearTimeout(autoExpandRef.current.timer);
      autoExpandRef.current = null;
    }
  }, []);

  const stopAutoScroll = useCallback(() => {
    autoScrollDirRef.current = 0;
    if (autoScrollRafRef.current !== null) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
  }, []);

  const tickAutoScroll = useCallback(() => {
    const list = listRef.current;
    if (!list || !dragRef.current || autoScrollDirRef.current === 0) {
      autoScrollRafRef.current = null;
      return;
    }
    list.scrollTop += autoScrollDirRef.current * AUTO_SCROLL_SPEED;
    autoScrollRafRef.current = requestAnimationFrame(tickAutoScroll);
  }, []);

  const setAutoScroll = useCallback((dir: number) => {
    if (autoScrollDirRef.current === dir) return;
    autoScrollDirRef.current = dir;
    if (dir === 0) {
      stopAutoScroll();
      return;
    }
    if (autoScrollRafRef.current === null) {
      autoScrollRafRef.current = requestAnimationFrame(tickAutoScroll);
    }
  }, [stopAutoScroll, tickAutoScroll]);

  const resolveTarget = useCallback((clientX: number, clientY: number): DropTarget => {
    const hit = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const rowEl = hit?.closest<HTMLElement>("[data-layer-row]");
    if (rowEl?.dataset.layerRow) {
      return {
        kind: "row",
        id: rowEl.dataset.layerRow,
        place: placeInRow(clientY, rowEl.getBoundingClientRect(), rowEl.dataset.nestable === "1"),
      };
    }
    if (hit?.closest("[data-root-zone]")) return { kind: "root" };
    const list = listRef.current;
    if (list && hit && (list === hit || list.contains(hit))) {
      // Empty space under the last row drops at the bottom of the root list.
      return { kind: "root" };
    }
    return null;
  }, []);

  const scheduleAutoExpand = useCallback((target: DropTarget) => {
    const id = target?.kind === "row" && target.place === "inside" ? target.id : null;
    if (autoExpandRef.current?.id === id) return;
    clearAutoExpand();
    if (!id) return;
    autoExpandRef.current = {
      id,
      timer: window.setTimeout(() => {
        autoExpandRef.current = null;
        setCollapsed((current) => {
          if (!current.has(id)) return current;
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }, AUTO_EXPAND_DELAY),
    };
  }, [clearAutoExpand]);

  const onRowPointerDown = useCallback((id: string, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    suppressClickRef.current = false;
    pendingRef.current = { id, x: event.clientX, y: event.clientY };
  }, []);

  // Pointer-driven drag: HTML5 drag-and-drop is unreliable inside the desktop
  // webview (the shell owns OS-level drops), so the panel drives its own.
  useEffect(() => {
    const startDrag = (id: string, event: PointerEvent) => {
      const state = useBoardStore.getState();
      const ids = state.selectedIds.includes(id) ? [...state.selectedIds] : [id];
      if (!state.selectedIds.includes(id)) state.selectElement(id);
      const name = state.board.elements.find((el) => el.id === id)?.name ?? "Layer";
      suppressClickRef.current = true;
      applyDrag({
        ids,
        label: ids.length > 1 ? `${ids.length} layers` : name,
        x: event.clientX,
        y: event.clientY,
        target: null,
        valid: false,
      });
    };

    const updateDrag = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const target = resolveTarget(event.clientX, event.clientY);
      const valid = target !== null && canMoveLayers(
        useBoardStore.getState().board,
        current.ids,
        target.kind === "row" ? target.id : null,
        target.kind === "row" ? target.place : "below",
      );
      applyDrag({ ...current, x: event.clientX, y: event.clientY, target, valid });
      scheduleAutoExpand(target);

      const list = listRef.current;
      if (list) {
        const rect = list.getBoundingClientRect();
        if (event.clientY < rect.top + AUTO_SCROLL_EDGE) setAutoScroll(-1);
        else if (event.clientY > rect.bottom - AUTO_SCROLL_EDGE) setAutoScroll(1);
        else setAutoScroll(0);
      }
    };

    const endDrag = (commit: boolean) => {
      const current = dragRef.current;
      pendingRef.current = null;
      clearAutoExpand();
      setAutoScroll(0);
      applyDrag(null);
      if (!commit || !current?.valid || !current.target) return;
      const target = current.target;
      if (target.kind === "row") moveLayers(current.ids, target.id, target.place);
      else moveLayers(current.ids, null, "below");
    };

    const onPointerMove = (event: PointerEvent) => {
      const pending = pendingRef.current;
      if (pending && !dragRef.current) {
        const travelled = Math.hypot(event.clientX - pending.x, event.clientY - pending.y);
        if (travelled < DRAG_THRESHOLD) return;
        startDrag(pending.id, event);
      }
      if (dragRef.current) {
        event.preventDefault();
        updateDrag(event);
      }
    };

    const onPointerUp = () => {
      if (dragRef.current) endDrag(true);
      else pendingRef.current = null;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dragRef.current) endDrag(false);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      stopAutoScroll();
      clearAutoExpand();
    };
  }, [
    applyDrag, clearAutoExpand, moveLayers, resolveTarget,
    scheduleAutoExpand, setAutoScroll, stopAutoScroll,
  ]);

  const ctxValue = useMemo<LayersCtxType>(
    () => ({
      handleItemClick,
      onRowPointerDown,
      toggleCollapsed,
      dragIds: drag?.ids ?? [],
      dropTarget: drag?.target ?? null,
      dropValid: drag?.valid ?? false,
    }),
    [handleItemClick, onRowPointerDown, toggleCollapsed, drag],
  );

  const rootDropActive = !!drag?.valid && drag.target?.kind === "root";

  return (
    <LayersCtx.Provider value={ctxValue}>
      <div className={`layers-panel${drag ? " layers-dragging" : ""}`}>
        <div className="panel-header">
          <span>Layers</span>
          <span className="panel-count">{board.elements.length}</span>
        </div>
        <div className="layers-body">
          <div className="layers-list" ref={listRef}>
            {rows.length === 0 ? (
              <div className="layers-empty">No elements yet.<br />Use a tool to create one.</div>
            ) : (
              <>
                {rows.map((row) => <LayerRow key={row.el.id} row={row} />)}
                {/* Appended after the rows, so showing it never shifts them. */}
                {drag && (
                  <div
                    className={`layers-root-tail${rootDropActive ? " layers-root-tail-active" : ""}`}
                    data-root-zone=""
                  >
                    Drop here to move to the back
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {drag && (
        <div
          className={`layer-drag-ghost${drag.valid ? "" : " layer-drag-ghost-invalid"}`}
          style={{ left: drag.x + 12, top: drag.y + 8 }}
        >
          {drag.label}
        </div>
      )}
    </LayersCtx.Provider>
  );
}
