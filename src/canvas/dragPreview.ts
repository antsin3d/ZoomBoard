import { resolveState, type Board, type BoardElement, type ElementState } from "../whiteboard/model";
import {
  effectiveSelectionRoots,
  resolveConnectorState,
  withLiveState,
  type Point,
} from "../whiteboard/geometry";

/** A selected descendant dragged directly moves alone, never its selected ancestor. */
export function dragSelection(board: Board, selectedIds: string[], id: string) {
  const element = board.elements.find((candidate) => candidate.id === id);
  const selectedRoots = effectiveSelectionRoots(board, selectedIds);
  const movesSelection = selectedIds.length > 1 && selectedRoots.some((root) => root.id === id);
  return {
    movesSelection,
    roots: movesSelection ? selectedRoots : element ? [element] : [],
  };
}

export function createDragPreview(board: Board, selectedIds: string[], id: string, zoom: number) {
  const selection = dragSelection(board, selectedIds, id);
  const element = board.elements.find((candidate) => candidate.id === id);
  if (!element) return null;
  // Routed connector hulls can start somewhere other than their authored frame.
  const origin = element.type === "connector"
    ? resolveConnectorState(board, element, zoom)
    : resolveState(element, zoom, board.breakpoints);
  return {
    ...selection,
    id,
    origin: { x: origin.x, y: origin.y },
    positions: new Map(selection.roots.map((root) => {
      const state = resolveState(root, zoom, board.breakpoints);
      return [root.id, { x: state.x, y: state.y }] as const;
    })),
  };
}

export type DragPreview = NonNullable<ReturnType<typeof createDragPreview>>;

export function dragPreviewPositions(drag: DragPreview, point: Point): Map<string, Point> {
  const dx = point.x - drag.origin.x;
  const dy = point.y - drag.origin.y;
  return new Map([...drag.positions].map(([id, start]) => [
    id, { x: start.x + dx, y: start.y + dy },
  ]));
}

/**
 * Resolve paths after applying live authored positions, not by translating the
 * final routed hull. Attached endpoints must remain anchored; floating paths
 * must route from their new endpoints. Ancestor offsets come from geometry's
 * live-position map, so descendants never receive the delta a second time.
 */
export function resolveLiveConnectorState(board: Board, element: BoardElement, zoom: number): ElementState {
  const state = resolveState(element, zoom, board.breakpoints);
  const live = withLiveState(state, element.id);
  if (live === state) return resolveConnectorState(board, element, zoom);
  return resolveConnectorState(board, {
    ...element,
    base: live,
    keyframes: {},
    variants: undefined,
    variantAssignments: undefined,
  }, zoom);
}
