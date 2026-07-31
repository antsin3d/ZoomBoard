import {
  BASE_KEYFRAME_ID,
  BASE_ZOOM,
  resolveState,
  resolveStateDirect,
  type Board,
  type BoardElement,
  type ElementState,
} from "./model";

export interface Point {
  x: number;
  y: number;
}

export interface Bounds extends Point {
  width: number;
  height: number;
}

export type ArrangeMode =
  | "left"
  | "center-h"
  | "right"
  | "top"
  | "center-v"
  | "bottom"
  | "distribute-h"
  | "distribute-v"
  | "grid";

export type LayerDropPlace = "above" | "below" | "inside";

export function isContainer(element: BoardElement): boolean {
  return element.type === "group" || element.type === "frame";
}

/** Any non-connector layer can become a parent via Layers drag-and-drop. */
export function canAcceptChildren(element: BoardElement): boolean {
  return element.type !== "connector";
}

/**
 * Containers that capture objects dropped onto them on the canvas.
 * Like Miro, only frames adopt (or release) children through canvas dragging;
 * group membership is changed explicitly via grouping or the Layers panel.
 */
export function isCanvasDropTarget(element: BoardElement): boolean {
  return element.type === "frame";
}

export function childElementsOf(board: Board, parentId: string): BoardElement[] {
  return board.elements.filter((element) => element.parentId === parentId);
}

export function rendersAsContainer(board: Board, element: BoardElement): boolean {
  return isContainer(element) || board.elements.some((candidate) => candidate.parentId === element.id);
}

/**
 * The outermost group an element belongs to, if any.
 *
 * Groups behave as one object on the canvas (click or drag anywhere in them and
 * the whole group responds), while frames are transparent containers whose
 * children stay individually clickable and draggable — as in Miro.
 */
export function outermostGroupAncestor(
  elements: BoardElement[],
  elementId: string,
): string | undefined {
  const byId = new Map(elements.map((element) => [element.id, element]));
  let outermost: string | undefined;
  let parentId = byId.get(elementId)?.parentId;
  while (parentId) {
    const parent = byId.get(parentId);
    if (!parent) break;
    if (parent.type === "group") outermost = parent.id;
    parentId = parent.parentId;
  }
  return outermost;
}

export function depthOf(board: Board, elementId: string): number {
  const byId = new Map(board.elements.map((element) => [element.id, element]));
  let depth = 0;
  let parentId = byId.get(elementId)?.parentId;
  while (parentId && depth < board.elements.length) {
    depth += 1;
    parentId = byId.get(parentId)?.parentId;
  }
  return depth;
}

export function isDescendantOf(board: Board, ancestorId: string, candidateId: string): boolean {
  const byId = new Map(board.elements.map((element) => [element.id, element]));
  let parentId = byId.get(candidateId)?.parentId;
  while (parentId) {
    if (parentId === ancestorId) return true;
    parentId = byId.get(parentId)?.parentId;
  }
  return false;
}

export function presentationKeys(board: Board): string[] {
  return [BASE_KEYFRAME_ID, ...board.breakpoints.map((bp) => bp.id)];
}

export function zoomForPresentation(board: Board, key: string): number {
  return key === BASE_KEYFRAME_ID
    ? BASE_ZOOM
    : board.breakpoints.find((bp) => bp.id === key)?.zoom ?? BASE_ZOOM;
}

export function stateForPresentation(board: Board, element: BoardElement, key: string): ElementState {
  return resolveStateDirect(element, zoomForPresentation(board, key), board.breakpoints);
}

export function worldPositionForPresentation(
  board: Board,
  element: BoardElement,
  key: string,
): Point {
  const state = stateForPresentation(board, element, key);
  if (!element.parentId) return { x: state.x, y: state.y };
  const parent = board.elements.find((candidate) => candidate.id === element.parentId);
  if (!parent) return { x: state.x, y: state.y };
  const parentWorld = worldPositionForPresentation(board, parent, key);
  return { x: parentWorld.x + state.x, y: parentWorld.y + state.y };
}

export function worldBasePosition(board: Board, element: BoardElement): Point {
  if (!element.parentId) return { x: element.base.x, y: element.base.y };
  const parent = board.elements.find((candidate) => candidate.id === element.parentId);
  if (!parent) return { x: element.base.x, y: element.base.y };
  const parentWorld = worldBasePosition(board, parent);
  return { x: parentWorld.x + element.base.x, y: parentWorld.y + element.base.y };
}

export function worldPositionAtZoom(board: Board, element: BoardElement, zoom: number): Point {
  const state = resolveState(element, zoom, board.breakpoints);
  if (!element.parentId) return { x: state.x, y: state.y };
  const parent = board.elements.find((candidate) => candidate.id === element.parentId);
  if (!parent) return { x: state.x, y: state.y };
  const parentWorld = worldPositionAtZoom(board, parent, zoom);
  return { x: parentWorld.x + state.x, y: parentWorld.y + state.y };
}

export function worldBoundsAtZoom(board: Board, element: BoardElement, zoom: number): Bounds {
  const state = resolveState(element, zoom, board.breakpoints);
  const world = worldPositionAtZoom(board, element, zoom);
  if (element.type !== "group") {
    return { x: world.x, y: world.y, width: state.width, height: state.height };
  }

  const children = board.elements.filter((child) => child.parentId === element.id);
  if (!children.length) return { x: world.x, y: world.y, width: state.width, height: state.height };
  const bounds = children.map((child) => worldBoundsAtZoom(board, child, zoom));
  const left = Math.min(...bounds.map((item) => item.x));
  const top = Math.min(...bounds.map((item) => item.y));
  const right = Math.max(...bounds.map((item) => item.x + item.width));
  const bottom = Math.max(...bounds.map((item) => item.y + item.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function center(bounds: Bounds): Point {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function edgePoint(bounds: Bounds, toward: Point): Point {
  const origin = center(bounds);
  const dx = toward.x - origin.x;
  const dy = toward.y - origin.y;
  if (dx === 0 && dy === 0) return origin;
  const halfWidth = Math.max(bounds.width / 2, 0.5);
  const halfHeight = Math.max(bounds.height / 2, 0.5);
  const scale = 1 / Math.max(Math.abs(dx) / halfWidth, Math.abs(dy) / halfHeight);
  return { x: origin.x + dx * scale, y: origin.y + dy * scale };
}

export function resolveConnectorState(
  board: Board,
  connector: BoardElement,
  zoom: number,
): ElementState {
  const state = resolveState(connector, zoom, board.breakpoints);
  if (connector.type !== "connector") return state;

  const startElement = connector.connectorStartId
    ? board.elements.find((element) => element.id === connector.connectorStartId)
    : undefined;
  const endElement = connector.connectorEndId
    ? board.elements.find((element) => element.id === connector.connectorEndId)
    : undefined;
  if (!startElement && !endElement) return state;

  const parent = connector.parentId
    ? board.elements.find((element) => element.id === connector.parentId)
    : undefined;
  const parentWorld = parent ? worldPositionAtZoom(board, parent, zoom) : { x: 0, y: 0 };
  const fallbackPoints = state.connectorPoints ?? [0, 0, state.width, state.height];
  const fallbackStart = {
    x: parentWorld.x + state.x + (fallbackPoints[0] ?? 0),
    y: parentWorld.y + state.y + (fallbackPoints[1] ?? 0),
  };
  const fallbackEnd = {
    x: parentWorld.x + state.x + (fallbackPoints[2] ?? state.width),
    y: parentWorld.y + state.y + (fallbackPoints[3] ?? state.height),
  };

  const startBounds = startElement ? worldBoundsAtZoom(board, startElement, zoom) : undefined;
  const endBounds = endElement ? worldBoundsAtZoom(board, endElement, zoom) : undefined;
  const startTarget = endBounds ? center(endBounds) : fallbackEnd;
  const endTarget = startBounds ? center(startBounds) : fallbackStart;
  const start = startBounds ? edgePoint(startBounds, startTarget) : fallbackStart;
  const end = endBounds ? edgePoint(endBounds, endTarget) : fallbackEnd;

  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  return {
    ...state,
    x: left - parentWorld.x,
    y: top - parentWorld.y,
    width: Math.max(1, Math.abs(end.x - start.x)),
    height: Math.max(1, Math.abs(end.y - start.y)),
    connectorPoints: [
      start.x - left,
      start.y - top,
      end.x - left,
      end.y - top,
    ],
  };
}

export function effectiveSelectionRoots(board: Board, selectedIds: string[]): BoardElement[] {
  const selected = new Set(selectedIds);
  const byId = new Map(board.elements.map((element) => [element.id, element]));
  return selectedIds
    .map((id) => byId.get(id))
    .filter((element): element is BoardElement => {
      if (!element) return false;
      let parentId = element.parentId;
      while (parentId) {
        if (selected.has(parentId)) return false;
        parentId = byId.get(parentId)?.parentId;
      }
      return true;
    });
}

export function worldBounds(
  board: Board,
  element: BoardElement,
  key: string,
  excludedChildId?: string,
): Bounds {
  const state = stateForPresentation(board, element, key);
  const world = worldPositionForPresentation(board, element, key);

  if (element.type !== "group") {
    return { x: world.x, y: world.y, width: state.width, height: state.height };
  }

  const children = board.elements.filter(
    (child) => child.parentId === element.id && child.id !== excludedChildId,
  );
  if (!children.length) return { x: world.x, y: world.y, width: state.width, height: state.height };

  const childBounds = children.map((child) => worldBounds(board, child, key));
  const left = Math.min(...childBounds.map((bounds) => bounds.x));
  const top = Math.min(...childBounds.map((bounds) => bounds.y));
  const right = Math.max(...childBounds.map((bounds) => bounds.x + bounds.width));
  const bottom = Math.max(...childBounds.map((bounds) => bounds.y + bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function boundsContains(bounds: Bounds, point: Point): boolean {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
}

/**
 * The container a canvas drag should drop into: the deepest (then smallest)
 * frame under the pointer, ignoring the dragged elements and their subtrees.
 */
export function canvasDropTargetAt(
  board: Board,
  point: Point,
  zoom: number,
  draggedIds: Iterable<string>,
): BoardElement | null {
  const excluded = new Set(draggedIds);
  let best: BoardElement | null = null;
  let bestDepth = -1;
  let bestArea = Infinity;

  for (const element of board.elements) {
    if (!isCanvasDropTarget(element)) continue;
    if (excluded.has(element.id)) continue;
    if ([...excluded].some((id) => isDescendantOf(board, id, element.id))) continue;
    const state = resolveState(element, zoom, board.breakpoints);
    if (!state.visible || state.opacity <= 0) continue;
    const bounds = worldBoundsAtZoom(board, element, zoom);
    if (!boundsContains(bounds, point)) continue;

    const depth = depthOf(board, element.id);
    const area = bounds.width * bounds.height;
    if (depth < bestDepth || (depth === bestDepth && area >= bestArea)) continue;
    best = element;
    bestDepth = depth;
    bestArea = area;
  }
  return best;
}

/** Whether a Layers-panel move is structurally legal (no cycles, valid parent). */
export function canMoveLayers(
  board: Board,
  childIds: string[],
  targetId: string | null,
  place: LayerDropPlace,
): boolean {
  const roots = effectiveSelectionRoots(board, childIds);
  if (!roots.length) return false;
  if (!targetId) return place !== "inside";

  if (roots.some((root) => root.id === targetId)) return false;
  const target = board.elements.find((element) => element.id === targetId);
  if (!target) return false;

  if (place === "inside") {
    if (!canAcceptChildren(target)) return false;
    return !roots.some((root) => isDescendantOf(board, root.id, targetId));
  }

  const nextParentId = target.parentId ?? null;
  if (!nextParentId) return true;
  return !roots.some(
    (root) => root.id === nextParentId || isDescendantOf(board, root.id, nextParentId),
  );
}

function divergesFromBase(board: Board, element: BoardElement | null, key: string): boolean {
  if (!element) return false;
  const presentation = worldPositionForPresentation(board, element, key);
  const canonical = worldBasePosition(board, element);
  return (
    Math.abs(presentation.x - canonical.x) > 1e-6 || Math.abs(presentation.y - canonical.y) > 1e-6
  );
}

/**
 * Re-express an element's stored position relative to a new parent so it does
 * not visually jump.
 *
 * Keyframes stay sparse: a per-breakpoint position is only written when that
 * breakpoint actually pins the element (it already overrides x/y) or when the
 * old/new parent sits somewhere other than its canonical spot at that
 * breakpoint. Otherwise the child simply follows its parent, which is the
 * whole point of parenting.
 */
export function rebaseForParent(
  board: Board,
  element: BoardElement,
  nextParent: BoardElement | null,
): { base: ElementState; keyframes: Record<string, Partial<ElementState>> } {
  const canonical = worldBasePosition(board, element);
  const parentCanonical = nextParent
    ? worldBasePosition(board, nextParent)
    : { x: 0, y: 0 };
  const base: ElementState = {
    ...element.base,
    x: canonical.x - parentCanonical.x,
    y: canonical.y - parentCanonical.y,
  };

  const oldParent = element.parentId
    ? board.elements.find((candidate) => candidate.id === element.parentId) ?? null
    : null;

  const keyframes: Record<string, Partial<ElementState>> = Object.fromEntries(
    Object.entries(element.keyframes).map(([key, frame]) => [key, { ...frame }]),
  );

  for (const key of presentationKeys(board)) {
    const frame = keyframes[key];
    const pinned = typeof frame?.x === "number" || typeof frame?.y === "number";
    if (
      !pinned &&
      !divergesFromBase(board, oldParent, key) &&
      !divergesFromBase(board, nextParent, key)
    ) {
      continue;
    }
    const world = worldPositionForPresentation(board, element, key);
    const parentWorld = nextParent
      ? worldPositionForPresentation(board, nextParent, key)
      : { x: 0, y: 0 };
    keyframes[key] = {
      ...(frame ?? {}),
      x: world.x - parentWorld.x,
      y: world.y - parentWorld.y,
    };
  }

  return { base, keyframes };
}

export function computeArrangeDeltas(
  mode: ArrangeMode,
  entries: Array<{ id: string; bounds: Bounds }>,
): Map<string, Point> {
  const result = new Map<string, Point>();
  if (entries.length < 2) return result;

  const left = Math.min(...entries.map((entry) => entry.bounds.x));
  const top = Math.min(...entries.map((entry) => entry.bounds.y));
  const right = Math.max(...entries.map((entry) => entry.bounds.x + entry.bounds.width));
  const bottom = Math.max(...entries.map((entry) => entry.bounds.y + entry.bounds.height));
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;

  if (mode === "grid") {
    const ordered = [...entries].sort(
      (a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x,
    );
    const columns = Math.ceil(Math.sqrt(ordered.length));
    const gap = 16;
    const cellWidth = Math.max(...ordered.map((entry) => entry.bounds.width)) + gap;
    const cellHeight = Math.max(...ordered.map((entry) => entry.bounds.height)) + gap;
    ordered.forEach((entry, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      result.set(entry.id, {
        x: left + column * cellWidth - entry.bounds.x,
        y: top + row * cellHeight - entry.bounds.y,
      });
    });
    return result;
  }

  if (mode === "distribute-h" || mode === "distribute-v") {
    if (entries.length < 3) return result;
    const horizontal = mode === "distribute-h";
    const ordered = [...entries].sort((a, b) => {
      const ac = horizontal
        ? a.bounds.x + a.bounds.width / 2
        : a.bounds.y + a.bounds.height / 2;
      const bc = horizontal
        ? b.bounds.x + b.bounds.width / 2
        : b.bounds.y + b.bounds.height / 2;
      return ac - bc;
    });
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const firstCenter = horizontal
      ? first.bounds.x + first.bounds.width / 2
      : first.bounds.y + first.bounds.height / 2;
    const lastCenter = horizontal
      ? last.bounds.x + last.bounds.width / 2
      : last.bounds.y + last.bounds.height / 2;
    const step = (lastCenter - firstCenter) / (ordered.length - 1);
    ordered.forEach((entry, index) => {
      const current = horizontal
        ? entry.bounds.x + entry.bounds.width / 2
        : entry.bounds.y + entry.bounds.height / 2;
      const delta = firstCenter + step * index - current;
      result.set(entry.id, horizontal ? { x: delta, y: 0 } : { x: 0, y: delta });
    });
    return result;
  }

  entries.forEach((entry) => {
    const bounds = entry.bounds;
    let x = 0;
    let y = 0;
    if (mode === "left") x = left - bounds.x;
    if (mode === "center-h") x = centerX - (bounds.x + bounds.width / 2);
    if (mode === "right") x = right - (bounds.x + bounds.width);
    if (mode === "top") y = top - bounds.y;
    if (mode === "center-v") y = centerY - (bounds.y + bounds.height / 2);
    if (mode === "bottom") y = bottom - (bounds.y + bounds.height);
    result.set(entry.id, { x, y });
  });
  return result;
}
