import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import {
  type Board,
  type BoardElement,
  type Breakpoint,
  type ElementState,
  type ElementType,
  type ToolMode,
  DEFAULT_STATE,
  BASE_KEYFRAME_ID,
  newId,
  pickVariantPatch,
  resolveState,
  resolveStateDirect,
  activeBreakpoint,
  isRegionTimeline,
  presentationState,
} from "./model";
import { createRegionTimeline, sparseState } from "./regions";
import { canCutRegion } from "./regionEditing";
import { resolveTier, rawTier, type TierId } from "./tiers";
import { initializeBoardDocument, syncBoardDocument } from "./document";
import { canEditBoard, canCopyBoard } from "../collaboration/access";
import {
  anchorPoint,
  canMoveLayers,
  computeArrangeDeltas,
  connectorWorldEndpoints,
  effectiveSelectionRoots,
  findAttachTargetAt,
  isContainer,
  presentationKeys,
  rebaseForParent,
  resolveConnectorState,
  stateForPresentation,
  worldBasePosition,
  worldBounds,
  worldBoundsAtZoom,
  worldPositionForPresentation,
  type ArrangeMode,
  type Bounds,
  type LayerDropPlace,
} from "./geometry";

const CLIPBOARD_FORMAT = "ai.univrs.whiteboard.elements";

interface ElementsClipboard {
  format: typeof CLIPBOARD_FORMAT;
  elements: BoardElement[];
  rootIds: string[];
}

let memoryClipboard: ElementsClipboard | null = null;
let pasteCount = 0;

function collectSelectedHierarchy(board: Board, selectedIds: string[]): ElementsClipboard | null {
  if (!selectedIds.length) return null;
  const selected = new Set(selectedIds);
  const byId = new Map(board.elements.map((el) => [el.id, el]));

  const hasSelectedAncestor = (el: BoardElement): boolean => {
    let parentId = el.parentId;
    while (parentId) {
      if (selected.has(parentId)) return true;
      parentId = byId.get(parentId)?.parentId;
    }
    return false;
  };

  const elements = board.elements.filter((el) => selected.has(el.id) || hasSelectedAncestor(el));
  if (!elements.length) return null;

  return {
    format: CLIPBOARD_FORMAT,
    elements,
    rootIds: selectedIds.filter((id) => {
      const el = byId.get(id);
      return el ? !hasSelectedAncestor(el) : false;
    }),
  };
}

function cloneClipboard(
  payload: ElementsClipboard,
  dx: number,
  dy: number,
  preserveExternalParents = false,
): { elements: BoardElement[]; rootIds: string[] } {
  const idMap = new Map(payload.elements.map((el) => [el.id, newId()]));
  const roots = new Set(payload.rootIds);

  const elements = payload.elements.map((el): BoardElement => {
    const isRoot = roots.has(el.id);
    const offsetKeyframes = Object.fromEntries(
      Object.entries(el.keyframes).map(([key, frame]) => [
        key,
        isRoot
          ? {
              ...frame,
              ...(typeof frame.x === "number" ? { x: frame.x + dx } : {}),
              ...(typeof frame.y === "number" ? { y: frame.y + dy } : {}),
            }
          : { ...frame },
      ]),
    );
    const offsetRegionDefaults = el.regionDefaults && Object.fromEntries(
      Object.entries(el.regionDefaults).map(([key, frame]) => [
        key,
        isRoot
          ? {
              ...frame,
              ...(typeof frame.x === "number" ? { x: frame.x + dx } : {}),
              ...(typeof frame.y === "number" ? { y: frame.y + dy } : {}),
            }
          : { ...frame },
      ]),
    );

    return {
      ...el,
      id: idMap.get(el.id)!,
      name: isRoot ? `${el.name} copy` : el.name,
      connectorStartId: el.connectorStartId
        ? (idMap.get(el.connectorStartId) ?? el.connectorStartId)
        : undefined,
      connectorEndId: el.connectorEndId
        ? (idMap.get(el.connectorEndId) ?? el.connectorEndId)
        : undefined,
      parentId: el.parentId && idMap.has(el.parentId)
        ? idMap.get(el.parentId)
        : preserveExternalParents
          ? el.parentId
          : undefined,
      base: {
        ...el.base,
        x: el.base.x + (isRoot ? dx : 0),
        y: el.base.y + (isRoot ? dy : 0),
      },
      keyframes: offsetKeyframes,
      ...(offsetRegionDefaults ? { regionDefaults: offsetRegionDefaults } : {}),
    };
  });

  return {
    elements,
    rootIds: payload.rootIds.map((id) => idMap.get(id)).filter((id): id is string => Boolean(id)),
  };
}

function parseClipboard(value: string): ElementsClipboard | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const payload = parsed as Partial<ElementsClipboard>;
    if (payload.format !== CLIPBOARD_FORMAT || !Array.isArray(payload.elements) || !Array.isArray(payload.rootIds)) {
      return null;
    }
    return payload as ElementsClipboard;
  } catch {
    return null;
  }
}

function hasAnyShapeText(el: BoardElement): boolean {
  if (el.base.content.trim().length > 0) return true;
  return Object.values(el.keyframes).some((kf) => (kf.content ?? "").trim().length > 0);
}

function hasDivergedShapeText(el: BoardElement): boolean {
  return Object.values(el.keyframes).some(
    (kf) => typeof kf.content === "string" && kf.content !== el.base.content,
  );
}

/** An element plus every descendant under it. */
function subtreeIds(elements: BoardElement[], rootId: string): Set<string> {
  const subtree = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const element of elements) {
      if (element.parentId && subtree.has(element.parentId) && !subtree.has(element.id)) {
        subtree.add(element.id);
        grew = true;
      }
    }
  }
  return subtree;
}

/**
 * Index just past an element and its whole subtree. Inserting there makes a new
 * child the frontmost one, matching the "drop lands on top" expectation.
 */
function indexAfterSubtree(elements: BoardElement[], rootId: string): number {
  const subtree = subtreeIds(elements, rootId);
  let last = -1;
  elements.forEach((element, index) => {
    if (subtree.has(element.id)) last = index;
  });
  return last + 1;
}

// ─── Store shape ──────────────────────────────────────────────────────────────

export interface BoardStore {
  // ── Board data ──
  board: Board;

  // ── Undo / redo ──
  _past: Board[];
  _future: Board[];
  undo: () => void;
  redo: () => void;
  replaceBoard: (board: Board) => void;
  copySelected: () => Promise<void>;
  pasteClipboard: () => Promise<void>;
  duplicateSelected: (dx?: number, dy?: number, selectCopies?: boolean) => void;

  // ── Viewport ──
  zoom: number;
  panX: number;
  panY: number;

  // ── Derived from zoom (kept in sync) ──
  activeTier: TierId;
  activeBreakpointId: string | undefined;

  // ── UI selection / tool ──
  selectedIds: string[];
  tool: ToolMode;
  shiftHeld: boolean;
  /** One-shot request for the Properties panel to focus an element's text. */
  textEditRequest: { id: string; nonce: number } | null;
  /** Per-object region appearances copied for pasting into another region. */
  regionSettingsClipboard: { sourceRegionId: string; states: Record<string, ElementState> } | null;
  copyRegionSettings: () => number;
  /** Returns how many objects received the copied settings. */
  pasteRegionSettings: () => number;

  // ── Actions: viewport ──
  setZoom: (zoom: number) => void;
  setPan: (x: number, y: number) => void;

  // ── Actions: tool ──
  setTool: (tool: ToolMode) => void;

  // ── Actions: keyboard modifiers ──
  setShiftHeld: (held: boolean) => void;

  // ── Actions: selection ──
  selectElement: (id: string | null, addToSelection?: boolean) => void;
  editElementText: (id: string) => void;
  clearSelection: () => void;
  setSelectedIds: (ids: string[]) => void;

  // ── Actions: groups ──
  groupSelected: () => void;
  ungroup: (groupId: string) => void;
  moveSelectedBy: (dx: number, dy: number) => void;
  createFrame: (bounds: Bounds) => string;
  /**
   * Re-parent while preserving on-screen position.
   * `recordHistory: false` folds the change into the previous undo entry, which
   * lets a canvas drag (move + adopt) undo as a single step.
   */
  reparentElements: (
    childIds: string[],
    newParentId: string | null,
    recordHistory?: boolean,
  ) => void;
  /**
   * Move layers in the panel.
   * `above`/`below` reorder next to the target (or, with a null target, move to
   * the top/bottom of the root list); `inside` nests under the target.
   */
  moveLayers: (
    childIds: string[],
    targetId: string | null,
    place: LayerDropPlace,
    recordHistory?: boolean,
  ) => void;
  alignSelected: (mode: ArrangeMode) => void;
  connectSelected: () => string | null;
  attachConnectorEnd: (
    connectorId: string,
    end: "start" | "end",
    targetId: string | null,
    anchor?: import("./model").ConnectorAnchor | null,
  ) => void;
  moveConnectorEndpointTo: (
    connectorId: string,
    end: "start" | "end",
    world: { x: number; y: number },
  ) => void;
  moveConnectorFloatingBy: (connectorId: string, dx: number, dy: number) => void;
  setConnectorLabelPosition: (
    connectorId: string,
    position: number,
    offsetX?: number,
    offsetY?: number,
  ) => void;
  createConnector: (
    start: { elementId?: string; anchor?: import("./model").ConnectorAnchor; world: { x: number; y: number } },
    end: { elementId?: string; anchor?: import("./model").ConnectorAnchor; world: { x: number; y: number } },
  ) => string;
  flipConnector: (connectorId: string) => void;

  // ── Actions: breakpoints ──
  addBreakpoint: (zoom: number, name?: string) => string;
  removeBreakpoint: (id: string) => void;
  /** Merge adjacent regions into the leftmost one, keeping its styling. */
  mergeRegions: (ids: string[]) => string | null;
  updateBreakpoint: (
    id: string,
    patch: Partial<Pick<Breakpoint, "zoom" | "name" | "transition" | "transitionRange" | "tweenIn" | "tweenOut">>,
    recordHistory?: boolean,
  ) => void;

  // ── Actions: elements ──
  addElement: (type: ElementType, state?: Partial<ElementState>) => string;
  removeElement: (id: string) => void;
  removeElements: (ids: string[]) => void;
  updateBase: (elementId: string, patch: Partial<ElementState>) => void;
  setKeyframe: (elementId: string, breakpointId: string, patch: Partial<ElementState>) => void;
  clearKeyframeKey: (elementId: string, breakpointId: string, key: keyof ElementState) => void;
  toggleVisibility: (elementId: string) => void;
  renameElement: (elementId: string, name: string) => void;

  // ── Actions: variants ──
  addVariant: (elementId: string, name?: string) => string | null;
  removeVariant: (elementId: string, variantId: string) => void;
  renameVariant: (elementId: string, variantId: string, name: string) => void;
  updateVariantPatch: (elementId: string, variantId: string, patch: Partial<ElementState>) => void;
  setVariantAssignment: (
    elementId: string,
    presentationKey: string,
    variantId: string | null,
  ) => void;
  captureVariantFromPresentation: (
    elementId: string,
    presentationKey: string,
    name?: string,
  ) => string | null;

  // ── Derived helper ──
  resolve: (elementId: string) => ElementState | null;
}

// ─── Seed board ───────────────────────────────────────────────────────────────

function seedBoard(): Board {
  return {
    breakpoints: createRegionTimeline(),
    elements: [],
  };
}

// ─── Store ────────────────────────────────────────────────────────────────────

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const MAX_HISTORY = 100;

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function sortedBreakpoints(bps: Breakpoint[]): Breakpoint[] {
  return [...bps].sort((a, b) => a.zoom - b.zoom);
}

export const useBoardStore = create<BoardStore>()(
  subscribeWithSelector((rawSet, get) => {
    // Every editing action funnels through this guard, including keyboard,
    // properties panels, and async paste. Network updates use withRemoteBoard.
    const set: typeof rawSet = (partial, replace?) => {
      const next = typeof partial === "function" ? partial(get()) : partial;
      if (!canEditBoard() && ("board" in next || "_past" in next || "_future" in next)) return;
      if (replace) rawSet(next as BoardStore, true);
      else rawSet(next, false);
    };
    const initialBoard = seedBoard();
    const initialZoom = 1;

    // ── History helper (closure — not in store interface) ──────────────────
    const saveHistory = () => {
      const { board, _past } = get();
      set({ _past: [..._past.slice(-(MAX_HISTORY - 1)), board], _future: [] });
    };

    return {
      board: initialBoard,
      _past: [],
      _future: [],
      zoom: initialZoom,
      panX: 0,
      panY: 0,
      activeTier: rawTier(initialZoom),
      activeBreakpointId: activeBreakpoint(initialZoom, initialBoard.breakpoints)?.id,
      selectedIds: [],
      tool: "select",
      shiftHeld: false,
      textEditRequest: null,
      regionSettingsClipboard: null,

      copyRegionSettings: () => {
        const { board, selectedIds, activeBreakpointId } = get();
        const key = activeBreakpointId ?? BASE_KEYFRAME_ID;
        const states: Record<string, ElementState> = {};
        for (const el of board.elements) {
          if (selectedIds.includes(el.id)) {
            states[el.id] = structuredClone(presentationState(el, key, board.breakpoints));
          }
        }
        const count = Object.keys(states).length;
        if (count) set({ regionSettingsClipboard: { sourceRegionId: key, states } });
        return count;
      },

      pasteRegionSettings: () => {
        const { board, selectedIds, activeBreakpointId, regionSettingsClipboard } = get();
        if (!regionSettingsClipboard || !canEditBoard()) return 0;
        const key = activeBreakpointId ?? BASE_KEYFRAME_ID;
        const copied = regionSettingsClipboard.states;
        // Paste onto the selected copied objects; with no such selection,
        // paste onto every copied object that still exists.
        const selected = selectedIds.filter((id) => id in copied);
        const targets = new Set(selected.length ? selected : Object.keys(copied));
        const elements = board.elements.map((el) => {
          if (!targets.has(el.id)) return el;
          // Replace the whole region patch so the destination matches exactly,
          // including properties the source left at their original values.
          const destinationDefault = {
            ...DEFAULT_STATE,
            ...el.base,
            ...(el.keyframes[BASE_KEYFRAME_ID] ?? {}),
            ...(isRegionTimeline(board.breakpoints) ? el.regionDefaults?.[key] : {}),
          };
          const patch = sparseState(destinationDefault, copied[el.id]);
          if (JSON.stringify(patch) === JSON.stringify(el.keyframes[key] ?? {})) return el;
          return { ...el, keyframes: { ...el.keyframes, [key]: structuredClone(patch) } };
        });
        const changed = elements.filter((el, index) => el !== board.elements[index]).length;
        if (!changed) return 0;
        saveHistory();
        set({ board: { ...board, elements } });
        return changed;
      },

      // ── Undo / Redo ───────────────────────────────────────────────────────

      undo: () => {
        const { _past, board, _future, zoom } = get();
        if (!_past.length) return;
        const prev = _past[_past.length - 1];
        set({
          _past: _past.slice(0, -1),
          board: prev,
          _future: [board, ..._future.slice(0, MAX_HISTORY - 1)],
          selectedIds: [],
          activeBreakpointId: activeBreakpoint(zoom, prev.breakpoints)?.id,
        });
      },

      redo: () => {
        const { _past, board, _future, zoom } = get();
        if (!_future.length) return;
        const next = _future[0];
        set({
          _past: [..._past.slice(-(MAX_HISTORY - 1)), board],
          board: next,
          _future: _future.slice(1),
          selectedIds: [],
          activeBreakpointId: activeBreakpoint(zoom, next.breakpoints)?.id,
        });
      },

      replaceBoard: (board) => {
        const { zoom } = get();
        set({
          board,
          _past: [],
          _future: [],
          selectedIds: [],
          activeBreakpointId: activeBreakpoint(zoom, board.breakpoints)?.id,
        });
      },

      copySelected: async () => {
        if (!canCopyBoard()) return;
        const { board, selectedIds } = get();
        const payload = collectSelectedHierarchy(board, selectedIds);
        if (!payload) return;

        memoryClipboard = payload;
        pasteCount = 0;
        try {
          await navigator.clipboard?.writeText(JSON.stringify(payload));
        } catch {
          // The in-memory clipboard remains available when OS clipboard access
          // is unavailable (for example, an insecure browser dev origin).
        }
      },

      pasteClipboard: async () => {
        if (!canEditBoard()) return;
        let payload: ElementsClipboard | null = null;
        try {
          const value = await navigator.clipboard?.readText();
          if (value) payload = parseClipboard(value);
        } catch {
          // Fall through to the in-memory clipboard.
        }
        payload ??= memoryClipboard;
        if (!canEditBoard()) return;
        if (!payload) return;

        pasteCount += 1;
        const offset = 24 * pasteCount;
        const cloned = cloneClipboard(payload, offset, offset);
        saveHistory();
        set((s) => ({
          board: { ...s.board, elements: [...s.board.elements, ...cloned.elements] },
          selectedIds: cloned.rootIds,
        }));
      },

      duplicateSelected: (dx = 24, dy = 24, selectCopies = true) => {
        const { board, selectedIds } = get();
        const payload = collectSelectedHierarchy(board, selectedIds);
        if (!payload) return;
        const cloned = cloneClipboard(payload, dx, dy, true);
        saveHistory();
        set((s) => ({
          board: { ...s.board, elements: [...s.board.elements, ...cloned.elements] },
          selectedIds: selectCopies ? cloned.rootIds : s.selectedIds,
        }));
      },

      // ── Viewport ──────────────────────────────────────────────────────────

      setZoom: (zoom) => {
        const clamped = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
        const { board } = get();
        set((s) => ({
          zoom: clamped,
          activeTier: resolveTier(clamped, s.activeTier),
          activeBreakpointId: activeBreakpoint(clamped, board.breakpoints)?.id,
        }));
      },

      setPan: (x, y) => set({ panX: x, panY: y }),

      // ── Tool ──────────────────────────────────────────────────────────────

      setTool: (tool) => set({ tool }),

      // ── Keyboard modifiers ────────────────────────────────────────────────

      setShiftHeld: (held) => set({ shiftHeld: held }),

      // ── Selection ─────────────────────────────────────────────────────────

      editElementText: (id) => {
        const element = get().board.elements.find((candidate) => candidate.id === id);
        if (!element || element.type === "group" || !canEditBoard()) return;
        set((s) => ({
          selectedIds: [id],
          textEditRequest: { id, nonce: (s.textEditRequest?.nonce ?? 0) + 1 },
        }));
      },

      selectElement: (id, addToSelection = false) => {
        if (id === null) { set({ selectedIds: [] }); return; }
        if (addToSelection) {
          set((s) => ({
            selectedIds: s.selectedIds.includes(id)
              ? s.selectedIds.filter((x) => x !== id)
              : [...s.selectedIds, id],
          }));
        } else {
          set({ selectedIds: [id] });
        }
      },

      clearSelection: () => set({ selectedIds: [] }),
      setSelectedIds: (ids) => set({ selectedIds: ids }),

      // ── Groups ────────────────────────────────────────────────────────────

      groupSelected: () => {
        const { board, selectedIds } = get();
        const roots = effectiveSelectionRoots(board, selectedIds);
        if (roots.length < 2) return;
        saveHistory();
        const groupId = newId();
        set((s) => {
          const keys = presentationKeys(s.board);
          const canonicalPositions = roots.map((element) => ({
            element,
            point: worldBasePosition(s.board, element),
          }));
          const canonicalLeft = Math.min(...canonicalPositions.map(({ point }) => point.x));
          const canonicalTop = Math.min(...canonicalPositions.map(({ point }) => point.y));
          const canonicalRight = Math.max(
            ...canonicalPositions.map(({ element, point }) => point.x + element.base.width),
          );
          const canonicalBottom = Math.max(
            ...canonicalPositions.map(({ element, point }) => point.y + element.base.height),
          );

          const origins = new Map(
            keys.map((key) => {
              const bounds = roots.map((element) => worldBounds(s.board, element, key));
              return [
                key,
                {
                  x: Math.min(...bounds.map((item) => item.x)),
                  y: Math.min(...bounds.map((item) => item.y)),
                  width: Math.max(...bounds.map((item) => item.x + item.width))
                    - Math.min(...bounds.map((item) => item.x)),
                  height: Math.max(...bounds.map((item) => item.y + item.height))
                    - Math.min(...bounds.map((item) => item.y)),
                },
              ] as const;
            }),
          );

          const group: BoardElement = {
            id: groupId,
            type: "group",
            name: "Group",
            base: {
              ...DEFAULT_STATE,
              x: canonicalLeft,
              y: canonicalTop,
              width: canonicalRight - canonicalLeft,
              height: canonicalBottom - canonicalTop,
              fill: "transparent",
              stroke: "transparent",
              strokeWidth: 0,
              content: "",
            },
            keyframes: Object.fromEntries(
              keys.map((key) => {
                const origin = origins.get(key)!;
                return [key, { x: origin.x, y: origin.y, width: origin.width, height: origin.height }];
              }),
            ),
          };

          const rootIds = new Set(roots.map((element) => element.id));
          // Find the highest index among selected elements (topmost item in the layers panel).
          let maxIdx = -1;
          s.board.elements.forEach((el, i) => {
            if (rootIds.has(el.id)) maxIdx = Math.max(maxIdx, i);
          });

          const withParent = s.board.elements.map((el) => {
            if (!rootIds.has(el.id)) return el;
            const canonical = worldBasePosition(s.board, el);
            const keyframes = { ...el.keyframes };
            for (const key of keys) {
              const world = worldPositionForPresentation(s.board, el, key);
              const origin = origins.get(key)!;
              keyframes[key] = {
                ...(keyframes[key] ?? {}),
                x: world.x - origin.x,
                y: world.y - origin.y,
              };
            }
            return {
              ...el,
              parentId: groupId,
              base: {
                ...el.base,
                x: canonical.x - canonicalLeft,
                y: canonical.y - canonicalTop,
              },
              keyframes,
            };
          });

          const insertAt = maxIdx + 1;
          const newElements = [
            ...withParent.slice(0, insertAt),
            group,
            ...withParent.slice(insertAt),
          ];
          return {
            board: { ...s.board, elements: newElements },
            selectedIds: [groupId],
          };
        });
      },

      ungroup: (groupId) => {
        saveHistory();
        set((s) => {
          const children = s.board.elements.filter((el) => el.parentId === groupId);
          const childIds = children.map((el) => el.id);
          return {
            board: {
              ...s.board,
              elements: s.board.elements
                .filter((el) => el.id !== groupId)
                .map((el) => {
                  if (el.parentId !== groupId) return el;
                  const { base, keyframes } = rebaseForParent(s.board, el, null);
                  return { ...el, parentId: undefined, base, keyframes };
                }),
            },
            selectedIds: childIds,
          };
        });
      },

      createFrame: (bounds) => {
        const frameId = newId();
        saveHistory();
        set((s) => {
          const frame: BoardElement = {
            id: frameId,
            type: "frame",
            name: "Frame",
            base: {
              ...DEFAULT_STATE,
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
              fill: "#f8fafc",
              stroke: "#64748b",
              strokeWidth: 2,
              content: "",
              textAlign: "left",
              textVAlign: "top",
            },
            keyframes: {},
          };
          const activeKey = s.activeBreakpointId ?? BASE_KEYFRAME_ID;
          const frameBounds: Bounds = { ...bounds };
          const candidates = s.board.elements.filter((element) => {
            if (element.parentId || isContainer(element)) return false;
            const elementBounds = worldBounds(s.board, element, activeKey);
            return (
              elementBounds.x >= frameBounds.x &&
              elementBounds.y >= frameBounds.y &&
              elementBounds.x + elementBounds.width <= frameBounds.x + frameBounds.width &&
              elementBounds.y + elementBounds.height <= frameBounds.y + frameBounds.height
            );
          });
          const candidateIds = new Set(candidates.map((element) => element.id));
          const elements = s.board.elements.map((element) => {
            if (!candidateIds.has(element.id)) return element;
            const { base, keyframes } = rebaseForParent(s.board, element, frame);
            return { ...element, parentId: frameId, base, keyframes };
          });
          return {
            board: { ...s.board, elements: [...elements, frame] },
            selectedIds: [frameId],
          };
        });
        return frameId;
      },

      reparentElements: (childIds, newParentId, recordHistory = true) => {
        get().moveLayers(
          childIds,
          newParentId,
          newParentId ? "inside" : "above",
          recordHistory,
        );
      },

      moveLayers: (childIds, targetId, place, recordHistory = true) => {
        const { board } = get();
        if (!canMoveLayers(board, childIds, targetId, place)) return;

        const roots = effectiveSelectionRoots(board, childIds);
        const movingIds = new Set(roots.map((root) => root.id));

        let nextParentId: string | null = null;
        if (place === "inside") {
          nextParentId = targetId;
        } else if (targetId) {
          nextParentId = board.elements.find((element) => element.id === targetId)?.parentId ?? null;
        }
        const parent = nextParentId
          ? board.elements.find((element) => element.id === nextParentId) ?? null
          : null;

        const rebased = board.elements.map((element) => {
          if (!movingIds.has(element.id)) return element;
          if ((element.parentId ?? null) === (parent?.id ?? null)) return element;
          const { base, keyframes } = rebaseForParent(board, element, parent);
          return { ...element, parentId: parent?.id, base, keyframes };
        });

        const moving = rebased.filter((element) => movingIds.has(element.id));
        const rest = rebased.filter((element) => !movingIds.has(element.id));

        // The Layers panel lists siblings in reverse array order, so a higher
        // index means "further up the list" / closer to the viewer.
        let insertAt: number;
        if (!targetId) {
          insertAt = place === "below" ? 0 : rest.length;
        } else if (place === "inside") {
          insertAt = indexAfterSubtree(rest, targetId);
        } else {
          const targetIndex = rest.findIndex((element) => element.id === targetId);
          if (targetIndex < 0) insertAt = rest.length;
          else insertAt = place === "above" ? targetIndex + 1 : targetIndex;
        }

        const elements = [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
        const unchanged =
          elements.length === board.elements.length &&
          elements.every((element, index) => element === board.elements[index]);
        if (unchanged) return;

        if (recordHistory) saveHistory();
        set((s) => ({ board: { ...s.board, elements } }));
      },

      alignSelected: (mode) => {
        const { board, selectedIds, activeBreakpointId } = get();
        const roots = effectiveSelectionRoots(board, selectedIds);
        if (roots.length < 2) return;
        const key = activeBreakpointId ?? BASE_KEYFRAME_ID;
        const deltas = computeArrangeDeltas(
          mode,
          roots.map((element) => ({ id: element.id, bounds: worldBounds(board, element, key) })),
        );
        if (!deltas.size) return;

        saveHistory();
        set((s) => ({
          board: {
            ...s.board,
            elements: s.board.elements.map((element) => {
              const delta = deltas.get(element.id);
              if (!delta) return element;
              const state = stateForPresentation(s.board, element, key);
              return {
                ...element,
                keyframes: {
                  ...element.keyframes,
                  [key]: {
                    ...(element.keyframes[key] ?? {}),
                    x: state.x + delta.x,
                    y: state.y + delta.y,
                  },
                },
              };
            }),
          },
        }));
      },

      connectSelected: () => {
        const { board, selectedIds, zoom } = get();
        const endpoints = effectiveSelectionRoots(board, selectedIds).filter(
          (element) => element.type !== "connector",
        );
        if (endpoints.length === 1) {
          const source = endpoints[0];
          const bounds = worldBoundsAtZoom(board, source, zoom);
          const cx = bounds.x + bounds.width / 2;
          const cy = bounds.y + bounds.height / 2;
          const toward = { x: cx + 120, y: cy };
          const startWorld = anchorPoint(bounds, { side: "auto", offset: 0.5 }, toward, source.type);
          const endWorld = { x: startWorld.x + 120, y: startWorld.y };
          return get().createConnector(
            { elementId: source.id, world: startWorld, anchor: { side: "auto", offset: 0.5 } },
            { world: endWorld },
          );
        }
        if (endpoints.length !== 2) return null;

        const connectorId = newId();
        const connector: BoardElement = {
          id: connectorId,
          type: "connector",
          name: "Connector",
          connectorStartId: endpoints[0].id,
          connectorEndId: endpoints[1].id,
          base: {
            ...DEFAULT_STATE,
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            fill: "#ffffff",
            stroke: "#64748b",
            strokeWidth: 2,
            content: "",
            connectorEndType: "arrow",
          },
          keyframes: {},
        };
        const resolved = resolveConnectorState(
          { ...board, elements: [...board.elements, connector] },
          connector,
          zoom,
        );
        connector.base = {
          ...connector.base,
          x: resolved.x,
          y: resolved.y,
          width: resolved.width,
          height: resolved.height,
          connectorPoints: resolved.connectorPoints,
        };

        saveHistory();
        set((s) => ({
          board: { ...s.board, elements: [...s.board.elements, connector] },
          selectedIds: [connectorId],
        }));
        return connectorId;
      },

      attachConnectorEnd: (connectorId, end, targetId, anchor = null) => {
        const { board, zoom, activeBreakpointId } = get();
        const kfId = activeBreakpointId ?? BASE_KEYFRAME_ID;
        // Preserve the current world endpoint when detaching so the floating
        // end stays where the shape edge was.
        const connector = board.elements.find((el) => el.id === connectorId);
        const currentWorld = connector ? connectorWorldEndpoints(board, connector, zoom) : null;
        saveHistory();
        set((s) => ({
          board: {
            ...s.board,
            elements: s.board.elements.map((el) => {
              if (el.id !== connectorId || el.type !== "connector") return el;
              const next = { ...el };
              if (end === "start") {
                if (targetId) next.connectorStartId = targetId;
                else delete next.connectorStartId;
                if (anchor) next.connectorStartAnchor = anchor;
                else delete next.connectorStartAnchor;
              } else {
                if (targetId) next.connectorEndId = targetId;
                else delete next.connectorEndId;
                if (anchor) next.connectorEndAnchor = anchor;
                else delete next.connectorEndAnchor;
              }
              // Detaching: bake the current world endpoint into the stored
              // fallback frame so it doesn't jump.
              if (!targetId && currentWorld) {
                const parent = el.parentId
                  ? s.board.elements.find((c) => c.id === el.parentId)
                  : undefined;
                const parentWorld = parent
                  ? worldPositionForPresentation(s.board, parent, kfId)
                  : { x: 0, y: 0 };
                const keep = end === "start" ? currentWorld.start : currentWorld.end;
                const other = end === "start" ? currentWorld.end : currentWorld.start;
                const ox = other.x - parentWorld.x;
                const oy = other.y - parentWorld.y;
                const nx = keep.x - parentWorld.x;
                const ny = keep.y - parentWorld.y;
                return {
                  ...next,
                  keyframes: {
                    ...next.keyframes,
                    [kfId]: {
                      ...(next.keyframes[kfId] ?? {}),
                      x: ox,
                      y: oy,
                      width: Math.max(1, Math.abs(nx - ox)),
                      height: Math.max(1, Math.abs(ny - oy)),
                      connectorPoints: end === "start" ? [nx - ox, ny - oy, 0, 0] : [0, 0, nx - ox, ny - oy],
                    },
                  },
                };
              }
              return next;
            }),
          },
        }));
      },

      moveConnectorEndpointTo: (connectorId, end, world) => {
        const { board, zoom, activeBreakpointId } = get();
        const connector = board.elements.find((el) => el.id === connectorId);
        if (!connector || connector.type !== "connector") return;
        const kfId = activeBreakpointId ?? BASE_KEYFRAME_ID;
        const target = findAttachTargetAt(board, world, zoom, [connectorId]);
        saveHistory();
        set((s) => ({
          board: {
            ...s.board,
            elements: s.board.elements.map((el) => {
              if (el.id !== connectorId || el.type !== "connector") return el;
              // Dropped onto a shape → attach with the nearest edge anchor.
              if (target) {
                const next = { ...el };
                if (end === "start") {
                  next.connectorStartId = target.element.id;
                  next.connectorStartAnchor = target.anchor;
                } else {
                  next.connectorEndId = target.element.id;
                  next.connectorEndAnchor = target.anchor;
                }
                return next;
              }
              // Dropped into empty space → floating end. Rewrite the stored
              // fallback points so this world position survives re-resolution.
              const parent = el.parentId
                ? s.board.elements.find((c) => c.id === el.parentId)
                : undefined;
              const parentWorld = parent
                ? worldPositionForPresentation(s.board, parent, kfId)
                : { x: 0, y: 0 };
              const current = stateForPresentation(s.board, el, kfId);
              const pts = [...(current.connectorPoints ?? [0, 0, current.width, current.height])];
              while (pts.length < 4) pts.push(0);
              const otherWorld = end === "start"
                ? { x: parentWorld.x + current.x + (pts[2] ?? 0), y: parentWorld.y + current.y + (pts[3] ?? 0) }
                : { x: parentWorld.x + current.x + (pts[0] ?? 0), y: parentWorld.y + current.y + (pts[1] ?? 0) };
              // Keep the box origin at the other end; store the dragged end
              // as an offset from it. Resolution rebuilds the frame anyway.
              const ox = otherWorld.x - parentWorld.x;
              const oy = otherWorld.y - parentWorld.y;
              const nx = world.x - parentWorld.x;
              const ny = world.y - parentWorld.y;
              const nextPoints = end === "start" ? [nx - ox, ny - oy, 0, 0] : [0, 0, nx - ox, ny - oy];
              // Rebase the frame origin to the other end so local coords stay small.
              const next: BoardElement = { ...el };
              if (end === "start") delete next.connectorStartId;
              else delete next.connectorEndId;
              if (end === "start") delete next.connectorStartAnchor;
              else delete next.connectorEndAnchor;
              return {
                ...next,
                keyframes: {
                  ...next.keyframes,
                  [kfId]: {
                    ...(next.keyframes[kfId] ?? {}),
                    x: ox,
                    y: oy,
                    width: Math.max(1, Math.abs(nx - ox)),
                    height: Math.max(1, Math.abs(ny - oy)),
                    connectorPoints: nextPoints,
                  },
                },
              };
            }),
          },
        }));
      },

      moveConnectorFloatingBy: (connectorId, dx, dy) => {
        if (dx === 0 && dy === 0) return;
        const { board, activeBreakpointId } = get();
        const connector = board.elements.find((el) => el.id === connectorId);
        if (!connector || connector.type !== "connector") return;
        // Fully attached lines stay pinned; endpoint handles move those.
        if (connector.connectorStartId && connector.connectorEndId) return;
        const kfId = activeBreakpointId ?? BASE_KEYFRAME_ID;
        saveHistory();
        set((s) => ({
          board: {
            ...s.board,
            elements: s.board.elements.map((el) => {
              if (el.id !== connectorId || el.type !== "connector") return el;
              const current = stateForPresentation(s.board, el, kfId);
              const pts = [...(current.connectorPoints ?? [0, 0, current.width, current.height])];
              while (pts.length < 4) pts.push(0);
              // Attached ends are recomputed from their shapes, so only the
              // floating ends need their stored positions translated.
              if (!el.connectorStartId) {
                pts[0] = (pts[0] ?? 0) + dx;
                pts[1] = (pts[1] ?? 0) + dy;
              }
              if (!el.connectorEndId) {
                pts[2] = (pts[2] ?? 0) + dx;
                pts[3] = (pts[3] ?? 0) + dy;
              }
              return {
                ...el,
                keyframes: {
                  ...el.keyframes,
                  [kfId]: {
                    ...(el.keyframes[kfId] ?? {}),
                    x: current.x + dx,
                    y: current.y + dy,
                    connectorPoints: pts,
                  },
                },
              };
            }),
          },
        }));
      },

      setConnectorLabelPosition: (connectorId, position, offsetX, offsetY) => {
        const { activeBreakpointId } = get();
        const kfId = activeBreakpointId ?? BASE_KEYFRAME_ID;
        saveHistory();
        set((s) => ({
          board: {
            ...s.board,
            elements: s.board.elements.map((el) => {
              if (el.id !== connectorId || el.type !== "connector") return el;
              return {
                ...el,
                keyframes: {
                  ...el.keyframes,
                  [kfId]: {
                    ...(el.keyframes[kfId] ?? {}),
                    connectorLabelPosition: Math.max(0, Math.min(1, position)),
                    ...(offsetX !== undefined ? { connectorLabelOffsetX: offsetX } : {}),
                    ...(offsetY !== undefined ? { connectorLabelOffsetY: offsetY } : {}),
                  },
                },
              };
            }),
          },
        }));
      },

      createConnector: (start, end) => {
        const connectorId = newId();
        const left = Math.min(start.world.x, end.world.x);
        const top = Math.min(start.world.y, end.world.y);
        const connector: BoardElement = {
          id: connectorId,
          type: "connector",
          name: "Connector",
          ...(start.elementId ? { connectorStartId: start.elementId } : {}),
          ...(start.elementId && start.anchor ? { connectorStartAnchor: start.anchor } : {}),
          ...(end.elementId ? { connectorEndId: end.elementId } : {}),
          ...(end.elementId && end.anchor ? { connectorEndAnchor: end.anchor } : {}),
          base: {
            ...DEFAULT_STATE,
            x: left,
            y: top,
            width: Math.max(1, Math.abs(end.world.x - start.world.x)),
            height: Math.max(1, Math.abs(end.world.y - start.world.y)),
            fill: "#ffffff",
            stroke: "#64748b",
            strokeWidth: 2,
            content: "",
            connectorEndType: "arrow",
            connectorPoints: [
              start.world.x - left,
              start.world.y - top,
              end.world.x - left,
              end.world.y - top,
            ],
          },
          keyframes: {},
        };
        saveHistory();
        set((s) => ({
          board: { ...s.board, elements: [...s.board.elements, connector] },
          selectedIds: [connectorId],
          tool: "select",
        }));
        return connectorId;
      },

      flipConnector: (connectorId) => {
        const swapFrame = (frame: Partial<ElementState>): Partial<ElementState> => {
          const next = { ...frame };
          const hasST = "connectorStartType" in frame;
          const hasET = "connectorEndType" in frame;
          if (hasST || hasET) {
            const sT = frame.connectorStartType;
            const eT = frame.connectorEndType;
            if (hasET) next.connectorStartType = eT;
            else delete next.connectorStartType;
            if (hasST) next.connectorEndType = sT;
            else delete next.connectorEndType;
          }
          const hasSS = "connectorStartSize" in frame;
          const hasES = "connectorEndSize" in frame;
          if (hasSS || hasES) {
            const sS = frame.connectorStartSize;
            const eS = frame.connectorEndSize;
            if (hasES) next.connectorStartSize = eS;
            else delete next.connectorStartSize;
            if (hasSS) next.connectorEndSize = sS;
            else delete next.connectorEndSize;
          }
          return next;
        };
        saveHistory();
        set((s) => ({
          board: {
            ...s.board,
            elements: s.board.elements.map((el) => {
              if (el.id !== connectorId || el.type !== "connector") return el;
              return {
                ...el,
                connectorStartId: el.connectorEndId,
                connectorEndId: el.connectorStartId,
                connectorStartAnchor: el.connectorEndAnchor,
                connectorEndAnchor: el.connectorStartAnchor,
                base: { ...el.base, ...swapFrame(el.base) },
                keyframes: Object.fromEntries(
                  Object.entries(el.keyframes).map(([key, frame]) => [key, swapFrame(frame)]),
                ),
                regionDefaults: el.regionDefaults && Object.fromEntries(
                  Object.entries(el.regionDefaults).map(([key, frame]) => [key, swapFrame(frame)]),
                ),
              };
            }),
          },
        }));
      },

      moveSelectedBy: (dx, dy) => {
        if (dx === 0 && dy === 0) return;
        saveHistory();
        const { zoom, selectedIds, activeBreakpointId, board } = get();
        const kfId = activeBreakpointId ?? BASE_KEYFRAME_ID;
        // When a group AND one of its children are both selected, moving the group
        // already shifts the child visually — skip the child to avoid a double-move.
        const effectiveIds = selectedIds.filter((id) => {
          const el = board.elements.find((e) => e.id === id);
          return !el?.parentId || !selectedIds.includes(el.parentId);
        });
        set((s) => ({
          board: {
            ...s.board,
            elements: s.board.elements.map((el) => {
              if (!effectiveIds.includes(el.id)) return el;
              const resolved = resolveState(el, zoom, board.breakpoints);
              const existing = el.keyframes[kfId] ?? {};
              return {
                ...el,
                keyframes: {
                  ...el.keyframes,
                  [kfId]: { ...existing, x: resolved.x + dx, y: resolved.y + dy },
                },
              };
            }),
          },
        }));
      },

      // ── Breakpoints ───────────────────────────────────────────────────────

      addBreakpoint: (zoom, name) => {
        if (!canEditBoard() || !Number.isFinite(zoom)) return "";
        const { board } = get();
        if (isRegionTimeline(board.breakpoints)) {
          // Untouched properties inherit from the regions to their left.
          // Splitting therefore never manufactures object keyframes.
          const cut = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
          if (!canCutRegion(board.breakpoints, cut)) return "";
          const source = activeBreakpoint(cut, board.breakpoints)!;
          const id = newId();
          const bp: Breakpoint = {
            id, region: true, zoom: cut,
            name: name?.trim() || `Region ${board.breakpoints.length + 1}`,
            transition: "crossfade", transitionRange: 0,
            tweenIn: 0.12, tweenOut: 0.12,
          };
          saveHistory();
          const breakpoints = sortedBreakpoints([...board.breakpoints, bp]);
          set({
            board: {
              ...board,
              breakpoints,
              elements: board.elements.map((el) => {
                const base = {
                  ...DEFAULT_STATE,
                  ...el.base,
                  ...(el.keyframes[BASE_KEYFRAME_ID] ?? {}),
                };
                const snapshot = sparseState(
                  base,
                  presentationState(el, source.id, board.breakpoints),
                );
                if (Object.keys(snapshot).length === 0) return el;
                return {
                  ...el,
                  regionDefaults: {
                    ...el.regionDefaults,
                    [id]: structuredClone(snapshot),
                  },
                };
              }),
            },
            activeBreakpointId: activeBreakpoint(get().zoom, breakpoints)?.id,
          });
          return id;
        }
        saveHistory();
        const id = newId();
        const bp: Breakpoint = {
          id,
          zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM),
          name: name ?? "Tier",
          transition: "crossfade",
          transitionRange: 0.45,
        };
        set((s) => ({
          board: {
            ...s.board,
            breakpoints: sortedBreakpoints([...s.board.breakpoints, bp]),
          },
          activeBreakpointId: activeBreakpoint(
            s.zoom,
            sortedBreakpoints([...s.board.breakpoints, bp]),
          )?.id,
        }));
        return id;
      },

      removeBreakpoint: (id) => {
        const { board } = get();
        if (!board.breakpoints.some((bp) => bp.id === id)) return;
        // The first region is the full-range foundation. Removing any later
        // region extends its left neighbor, keeping that neighbor's styling.
        if (isRegionTimeline(board.breakpoints) && board.breakpoints[0].id === id) return;
        saveHistory();
        set((s) => ({
          board: {
            ...s.board,
            breakpoints: s.board.breakpoints.filter((bp) => bp.id !== id),
            elements: s.board.elements.map((el) => {
              const keyframes = { ...el.keyframes };
              const regionDefaults = { ...el.regionDefaults };
              delete keyframes[id];
              delete regionDefaults[id];
              return {
                ...el,
                keyframes,
                ...(Object.keys(regionDefaults).length ? { regionDefaults } : { regionDefaults: undefined }),
              };
            }),
          },
          activeBreakpointId: activeBreakpoint(
            s.zoom,
            s.board.breakpoints.filter((bp) => bp.id !== id),
          )?.id,
        }));
      },

      mergeRegions: (ids) => {
        const { board, zoom } = get();
        if (!canEditBoard() || !isRegionTimeline(board.breakpoints)) return null;
        const ordered = sortedBreakpoints(board.breakpoints);
        const indexes = [...new Set(ids)]
          .map((id) => ordered.findIndex((bp) => bp.id === id))
          .filter((index) => index >= 0)
          .sort((a, b) => a - b);
        if (indexes.length < 2) return null;
        if (indexes.some((index, i) => i > 0 && index !== indexes[i - 1] + 1)) return null;
        const keep = ordered[indexes[0]].id;
        const doomed = new Set(indexes.slice(1).map((index) => ordered[index].id));
        const breakpoints = board.breakpoints.filter((bp) => !doomed.has(bp.id));
        saveHistory();
        set({
          board: {
            ...board,
            breakpoints,
            elements: board.elements.map((el) => {
              if (
                !Object.keys(el.keyframes).some((key) => doomed.has(key))
                && !Object.keys(el.regionDefaults ?? {}).some((key) => doomed.has(key))
              ) return el;
              const keyframes = { ...el.keyframes };
              const regionDefaults = { ...el.regionDefaults };
              for (const id of doomed) delete keyframes[id];
              for (const id of doomed) delete regionDefaults[id];
              return {
                ...el,
                keyframes,
                ...(Object.keys(regionDefaults).length ? { regionDefaults } : { regionDefaults: undefined }),
              };
            }),
          },
          activeBreakpointId: activeBreakpoint(zoom, breakpoints)?.id,
        });
        return keep;
      },

      updateBreakpoint: (id, patch, recordHistory = true) => {
        const { board } = get();
        const current = board.breakpoints.find((bp) => bp.id === id);
        if (!current || !canEditBoard()) return;
        const nextPatch = { ...patch };
        for (const key of ["zoom", "transitionRange", "tweenIn", "tweenOut"] as const) {
          if (nextPatch[key] !== undefined && !Number.isFinite(nextPatch[key])) return;
        }
        if (nextPatch.name !== undefined) nextPatch.name = nextPatch.name.trim() || current.name;
        if (isRegionTimeline(board.breakpoints)) {
          const index = board.breakpoints.indexOf(current);
          if (nextPatch.zoom !== undefined) {
            const previousZoom = board.breakpoints[Math.max(0, index - 1)].zoom;
            const nextZoom = board.breakpoints[index + 1]?.zoom ?? MAX_ZOOM;
            const gap = Math.min(0.02, Math.log2(nextZoom / previousZoom) / 3);
            nextPatch.zoom = index === 0 ? MIN_ZOOM : clamp(nextPatch.zoom,
              previousZoom * 2 ** gap,
              nextZoom / 2 ** gap);
          }
          const center = nextPatch.zoom ?? current.zoom;
          const leftLimit = index === 0 ? MIN_ZOOM : Math.sqrt(board.breakpoints[index - 1].zoom * center);
          const rightLimit = board.breakpoints[index + 1]
            ? Math.sqrt(center * board.breakpoints[index + 1].zoom) : MAX_ZOOM;
          if (nextPatch.tweenIn !== undefined) nextPatch.tweenIn = clamp(nextPatch.tweenIn, 0, Math.log2(center / leftLimit));
          if (nextPatch.tweenOut !== undefined) nextPatch.tweenOut = clamp(nextPatch.tweenOut, 0, Math.log2(rightLimit / center));
        }
        if (Object.entries(nextPatch).every(([key, value]) => current[key as keyof Breakpoint] === value)) return;
        if (recordHistory) saveHistory();
        set((s) => {
          const breakpoints = sortedBreakpoints(
            s.board.breakpoints.map((bp) => (bp.id === id ? { ...bp, ...nextPatch } : bp)),
          );
          return {
            board: { ...s.board, breakpoints },
            activeBreakpointId: activeBreakpoint(s.zoom, breakpoints)?.id,
          };
        });
      },

      // ── Elements ──────────────────────────────────────────────────────────

      addElement: (type, state) => {
        saveHistory();
        const id = newId();
        const typeDefaults: Partial<Record<ElementType, Partial<ElementState>>> = {
          text: {
            fill: "transparent", stroke: "transparent", strokeWidth: 0,
            content: "", fontSize: 16,
          },
          sticky: {
            width: 180, height: 180, fill: "#fff3a3", stroke: "#ead66f",
            strokeWidth: 1, textAlign: "left", textVAlign: "top",
          },
          frame: {
            width: 480, height: 320, fill: "transparent", stroke: "#64748b",
            strokeWidth: 2, textAlign: "left", textVAlign: "top",
          },
          connector: {
            fill: "transparent", stroke: "#64748b", strokeWidth: 2,
          },
          image: {
            width: 320, height: 240, fill: "transparent", stroke: "#cbd5e1",
            strokeWidth: 1,
          },
        };
        const typeNames: Partial<Record<ElementType, string>> = {
          text: "Text",
          rect: "Rectangle",
          ellipse: "Ellipse",
          triangle: "Triangle",
          diamond: "Diamond",
          hexagon: "Hexagon",
          star: "Star",
          sticky: "Sticky note",
          frame: "Frame",
          connector: "Connector",
          image: "Image",
          group: "Group",
        };

        const { board, activeBreakpointId } = get();
        const key = activeBreakpointId ?? BASE_KEYFRAME_ID;
        const base = { ...DEFAULT_STATE, ...(typeDefaults[type] ?? {}), ...state };

        // Auto-parent into the smallest frame that fully contains the new shape.
        let parentId: string | undefined;
        let localBase = base;
        if (type !== "frame" && type !== "connector") {
          let bestArea = Infinity;
          for (const candidate of board.elements) {
            if (candidate.type !== "frame") continue;
            const frameBounds = worldBounds(board, candidate, key);
            const fullyInside =
              base.x >= frameBounds.x
              && base.y >= frameBounds.y
              && base.x + base.width <= frameBounds.x + frameBounds.width
              && base.y + base.height <= frameBounds.y + frameBounds.height;
            if (!fullyInside) continue;
            const area = frameBounds.width * frameBounds.height;
            if (area >= bestArea) continue;
            bestArea = area;
            parentId = candidate.id;
            const parentWorld = worldPositionForPresentation(board, candidate, key);
            localBase = {
              ...base,
              x: base.x - parentWorld.x,
              y: base.y - parentWorld.y,
            };
          }
        }

        const el: BoardElement = {
          id,
          type,
          name: typeNames[type] ?? "Element",
          parentId,
          base: localBase,
          keyframes: {},
        };
        set((s) => {
          if (!parentId) {
            return {
              board: { ...s.board, elements: [...s.board.elements, el] },
              selectedIds: [id],
            };
          }
          // Keep children visually under their frame in the layers list.
          const parentIndex = s.board.elements.findIndex((element) => element.id === parentId);
          const elements = [...s.board.elements];
          elements.splice(parentIndex + 1, 0, el);
          return {
            board: { ...s.board, elements },
            selectedIds: [id],
          };
        });
        return id;
      },

      removeElement: (id) => {
        get().removeElements([id]);
      },

      removeElements: (ids) => {
        if (ids.length === 0) return;
        saveHistory();
        set((s) => {
          // Deleting a container takes its contents with it; "Ungroup" is the
          // way to keep the children.
          const doomed = new Set<string>();
          for (const id of ids) {
            for (const member of subtreeIds(s.board.elements, id)) doomed.add(member);
          }
          return {
            board: {
              ...s.board,
              elements: s.board.elements.filter((element) => !doomed.has(element.id)),
            },
            selectedIds: s.selectedIds.filter((sid) => !doomed.has(sid)),
          };
        });
      },

      updateBase: (elementId, patch) => {
        saveHistory();
        set((s) => ({
          board: {
            ...s.board,
            elements: s.board.elements.map((el) =>
              el.id === elementId ? { ...el, base: { ...el.base, ...patch } } : el,
            ),
          },
        }));
      },

      setKeyframe: (elementId, breakpointId, patch) => {
        saveHistory();
        set((s) => ({
          board: {
            ...s.board,
            elements: s.board.elements.map((el) => {
              if (el.id !== elementId) return el;
              const existing = el.keyframes[breakpointId] ?? {};
              const nextContent = typeof patch.content === "string" ? patch.content : undefined;
              const shouldSyncShapeText =
                !isRegionTimeline(s.board.breakpoints) &&
                el.type !== "text" &&
                nextContent !== undefined &&
                nextContent.trim().length > 0 &&
                (
                  !hasAnyShapeText(el) ||
                  (
                    !hasDivergedShapeText(el) &&
                    (existing.content ?? el.base.content) === el.base.content &&
                    (nextContent.startsWith(el.base.content) || el.base.content.startsWith(nextContent))
                  )
                );

              if (shouldSyncShapeText && nextContent !== undefined) {
                const keyframes = { ...el.keyframes };
                const currentKeyframe = { ...existing, content: nextContent };
                keyframes[breakpointId] = currentKeyframe;

                for (const [kfId, kf] of Object.entries(keyframes)) {
                  if (kfId === breakpointId) continue;
                  if (typeof kf.content === "string" && kf.content === el.base.content) {
                    keyframes[kfId] = { ...kf, content: nextContent };
                  }
                }

                return {
                  ...el,
                  base: { ...el.base, content: nextContent },
                  keyframes,
                };
              }

              return {
                ...el,
                keyframes: { ...el.keyframes, [breakpointId]: { ...existing, ...patch } },
              };
            }),
          },
        }));
      },

      clearKeyframeKey: (elementId, breakpointId, key) => {
        const element = get().board.elements.find((el) => el.id === elementId);
        if (!element || !(key in (element.keyframes[breakpointId] ?? {}))) return;
        saveHistory();
        set((s) => ({
          board: {
            ...s.board,
            elements: s.board.elements.map((el) => {
              if (el.id !== elementId) return el;
              const kf = { ...el.keyframes[breakpointId] };
              delete kf[key];
              const keyframes = { ...el.keyframes };
              if (Object.keys(kf).length === 0) delete keyframes[breakpointId];
              else keyframes[breakpointId] = kf;
              return { ...el, keyframes };
            }),
          },
        }));
      },

      // Inlined to avoid double history-save (does not call setKeyframe/clearKeyframeKey).
      toggleVisibility: (elementId) => {
        saveHistory();
        const { board, zoom, activeBreakpointId } = get();
        const el = board.elements.find((e) => e.id === elementId);
        if (!el) return;
        const current = resolveState(el, zoom, board.breakpoints);
        const nextVisible = !current.visible;
        const kfId = activeBreakpointId ?? BASE_KEYFRAME_ID;
        set((s) => ({
          board: {
            ...s.board,
            elements: s.board.elements.map((e) => {
              if (e.id !== elementId) return e;
              const inheritedVisible = kfId === BASE_KEYFRAME_ID
                ? e.base.visible
                : (e.keyframes[BASE_KEYFRAME_ID]?.visible ?? e.base.visible);
              if (nextVisible === inheritedVisible) {
                // Override is redundant — clear it so the element falls back
                // to the Base presentation inherited by this breakpoint.
                const kf = { ...(e.keyframes[kfId] ?? {}) };
                delete kf.visible;
                const keyframes = { ...e.keyframes };
                if (Object.keys(kf).length === 0) delete keyframes[kfId];
                else keyframes[kfId] = kf;
                return { ...e, keyframes };
              }
              return {
                ...e,
                keyframes: {
                  ...e.keyframes,
                  [kfId]: { ...(e.keyframes[kfId] ?? {}), visible: nextVisible },
                },
              };
            }),
          },
        }));
      },

      renameElement: (elementId, name) => {
        saveHistory();
        set((s) => ({
          board: {
            ...s.board,
            elements: s.board.elements.map((el) =>
              el.id === elementId ? { ...el, name } : el,
            ),
          },
        }));
      },

      // ── Variants ──────────────────────────────────────────────────────────

      addVariant: (elementId, name) => {
        const { board } = get();
        const el = board.elements.find((element) => element.id === elementId);
        if (!el) return null;
        saveHistory();
        const variantId = newId();
        const index = (el.variants?.length ?? 0) + 1;
        const variant = {
          id: variantId,
          name: name?.trim() || `Variant ${index}`,
          patch: pickVariantPatch(el.base),
        };
        set((s) => ({
          board: {
            ...s.board,
            elements: s.board.elements.map((element) =>
              element.id === elementId
                ? { ...element, variants: [...(element.variants ?? []), variant] }
                : element,
            ),
          },
        }));
        return variantId;
      },

      removeVariant: (elementId, variantId) => {
        saveHistory();
        set((s) => ({
          board: {
            ...s.board,
            elements: s.board.elements.map((element) => {
              if (element.id !== elementId) return element;
              const variants = (element.variants ?? []).filter((variant) => variant.id !== variantId);
              const variantAssignments = Object.fromEntries(
                Object.entries(element.variantAssignments ?? {}).filter(
                  ([, assignedId]) => assignedId !== variantId,
                ),
              );
              return {
                ...element,
                variants,
                variantAssignments:
                  Object.keys(variantAssignments).length > 0 ? variantAssignments : undefined,
              };
            }),
          },
        }));
      },

      renameVariant: (elementId, variantId, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        saveHistory();
        set((s) => ({
          board: {
            ...s.board,
            elements: s.board.elements.map((element) => {
              if (element.id !== elementId) return element;
              return {
                ...element,
                variants: (element.variants ?? []).map((variant) =>
                  variant.id === variantId ? { ...variant, name: trimmed } : variant,
                ),
              };
            }),
          },
        }));
      },

      updateVariantPatch: (elementId, variantId, patch) => {
        const cleaned = pickVariantPatch(patch);
        if (Object.keys(cleaned).length === 0) return;
        saveHistory();
        set((s) => ({
          board: {
            ...s.board,
            elements: s.board.elements.map((element) => {
              if (element.id !== elementId) return element;
              return {
                ...element,
                variants: (element.variants ?? []).map((variant) =>
                  variant.id === variantId
                    ? { ...variant, patch: { ...variant.patch, ...cleaned } }
                    : variant,
                ),
              };
            }),
          },
        }));
      },

      setVariantAssignment: (elementId, presentationKey, variantId) => {
        saveHistory();
        set((s) => ({
          board: {
            ...s.board,
            elements: s.board.elements.map((element) => {
              if (element.id !== elementId) return element;
              const next = { ...(element.variantAssignments ?? {}) };
              if (!variantId) delete next[presentationKey];
              else next[presentationKey] = variantId;
              return {
                ...element,
                variantAssignments: Object.keys(next).length > 0 ? next : undefined,
              };
            }),
          },
        }));
      },

      captureVariantFromPresentation: (elementId, presentationKey, name) => {
        const { board } = get();
        const el = board.elements.find((element) => element.id === elementId);
        if (!el) return null;
        const zoom = presentationKey === BASE_KEYFRAME_ID
          ? 1
          : board.breakpoints.find((bp) => bp.id === presentationKey)?.zoom ?? 1;
        const resolved = resolveStateDirect(el, zoom, board.breakpoints);
        saveHistory();
        const variantId = newId();
        const index = (el.variants?.length ?? 0) + 1;
        const variant = {
          id: variantId,
          name: name?.trim() || `Variant ${index}`,
          patch: pickVariantPatch(resolved),
        };
        set((s) => ({
          board: {
            ...s.board,
            elements: s.board.elements.map((element) => {
              if (element.id !== elementId) return element;
              return {
                ...element,
                variants: [...(element.variants ?? []), variant],
                variantAssignments: {
                  ...(element.variantAssignments ?? {}),
                  [presentationKey]: variantId,
                },
              };
            }),
          },
        }));
        return variantId;
      },

      // ── Derived helper ────────────────────────────────────────────────────

      resolve: (elementId) => {
        const { board, zoom } = get();
        const el = board.elements.find((e) => e.id === elementId);
        if (!el) return null;
        return resolveState(el, zoom, board.breakpoints);
      },
    };
  }),
);

// The UI store is a projection of one Yjs document that remains alive for the
// whole editing session. Every board mutation is recorded into that document,
// so saved updates retain the CRDT history needed for future multi-window and
// collaboration work.
initializeBoardDocument(useBoardStore.getState().board);
useBoardStore.subscribe(
  (state) => state.board,
  (board) => syncBoardDocument(board),
);
