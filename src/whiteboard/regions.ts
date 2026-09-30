import {
  BASE_KEYFRAME_ID, BASE_ZOOM, DEFAULT_REGION_TWEEN, DEFAULT_STATE,
  MAX_REGION_ZOOM, MIN_REGION_ZOOM, activeBreakpoint, isRegionTimeline,
  newId, presentationState, transitionHalfWidth,
  type Board, type Breakpoint, type ElementState,
} from "./model";

export { MIN_REGION_ZOOM, MAX_REGION_ZOOM } from "./model";

export function createRegionTimeline(): Breakpoint[] {
  return [{
    id: newId(), name: "Region 1", zoom: MIN_REGION_ZOOM, region: true,
    transition: "crossfade", transitionRange: 0,
    tweenIn: DEFAULT_REGION_TWEEN, tweenOut: DEFAULT_REGION_TWEEN,
  }];
}

/** Shared semantic checks, deliberately free of network size/count limits. */
export function validateRegionTimeline(breakpoints: readonly Breakpoint[]): void {
  const invalid = (): never => { throw new Error("Invalid region timeline."); };
  for (const bp of breakpoints) {
    if (bp.region !== undefined && bp.region !== true) invalid();
    for (const width of [bp.tweenIn, bp.tweenOut]) {
      if (width !== undefined && (typeof width !== "number" || !Number.isFinite(width) || width < 0 || width > 16)) invalid();
    }
    if (bp.region === undefined && (bp.tweenIn !== undefined || bp.tweenOut !== undefined)) invalid();
  }
  if (!breakpoints.some((bp) => bp.region === true)) return;
  if (!isRegionTimeline(breakpoints) || breakpoints[0].zoom !== MIN_REGION_ZOOM) invalid();
  for (let index = 0; index < breakpoints.length; index++) {
    const bp = breakpoints[index];
    if (bp.id === BASE_KEYFRAME_ID || !Number.isFinite(bp.zoom) ||
      bp.zoom < MIN_REGION_ZOOM || bp.zoom >= MAX_REGION_ZOOM ||
      (index > 0 && bp.zoom <= breakpoints[index - 1].zoom)) invalid();
  }
}

function sparseState(base: ElementState, state: ElementState): Partial<ElementState> {
  const patch: Partial<ElementState> = {};
  for (const key of Object.keys(state) as (keyof ElementState)[]) {
    if (JSON.stringify(state[key]) !== JSON.stringify(base[key])) {
      (patch as Record<string, unknown>)[key] = state[key];
    }
  }
  return patch;
}

/**
 * Bake each legacy interval's un-interpolated appearance into an independent
 * region patch. Only the store's board replacement boundary should call this:
 * transport and file parsing must preserve IDs for optimistic patch matching.
 */
export function migrateToRegions(board: Board): Board {
  if (isRegionTimeline(board.breakpoints)) return board;

  const legacy = [...board.breakpoints].sort((a, b) => a.zoom - b.zoom);
  const boundaries = legacy.filter((bp, index) =>
    bp.zoom > MIN_REGION_ZOOM && bp.zoom < MAX_REGION_ZOOM && bp.zoom !== BASE_ZOOM &&
    (index === 0 || bp.zoom !== legacy[index - 1].zoom));
  const starts = [MIN_REGION_ZOOM, ...boundaries.map((bp) => bp.zoom)];
  const used = new Set([BASE_KEYFRAME_ID, ...legacy.map((bp) => bp.id),
    ...board.elements.flatMap((el) => Object.keys(el.keyframes))]);
  const freshId = (): string => {
    let id: string;
    do { id = newId(); } while (!id || used.has(id));
    used.add(id);
    return id;
  };
  const assigned = new Set<string>();
  const sourceKeys: string[] = [];
  const breakpoints: Breakpoint[] = starts.map((zoom, index) => {
    // A geometric midpoint avoids exact legacy threshold conventions and
    // correctly handles thresholds outside the supported range.
    const midpoint = Math.sqrt(zoom * (starts[index + 1] ?? MAX_REGION_ZOOM));
    const source = activeBreakpoint(midpoint, legacy);
    sourceKeys.push(source?.id ?? BASE_KEYFRAME_ID);
    const id = source && source.id !== BASE_KEYFRAME_ID && !assigned.has(source.id) ? source.id : freshId();
    assigned.add(id);
    // A below-1x legacy marker belongs to the preceding appearance, but its
    // transition still controls this divider into the following appearance.
    const boundary = boundaries[index - 1];
    const half = boundary ? transitionHalfWidth(boundary) || 0 : 0;
    const low = Math.max(MIN_REGION_ZOOM, zoom - half);
    const high = Math.min(MAX_REGION_ZOOM, zoom + half);
    return {
      id, zoom, name: source?.name ?? `Region ${index + 1}`, region: true,
      transition: boundary?.transition ?? "crossfade", transitionRange: 0,
      tweenIn: boundary ? Math.log2(zoom / low) : DEFAULT_REGION_TWEEN,
      tweenOut: boundary ? Math.log2(high / zoom) : DEFAULT_REGION_TWEEN,
    };
  });
  const elements = board.elements.map((element) => {
    const copy = structuredClone(element);
    const base = { ...DEFAULT_STATE, ...element.base };
    // __base__ used to be an implicit overlay for every presentation. Bake it
    // explicitly so sparse region patches cannot silently inherit it later.
    delete copy.keyframes[BASE_KEYFRAME_ID];
    for (let index = 0; index < breakpoints.length; index++) {
      copy.keyframes[breakpoints[index].id] = structuredClone(
        sparseState(base, presentationState(element, sourceKeys[index])),
      );
    }
    delete copy.variants;
    delete copy.variantAssignments;
    return copy;
  });
  return { ...board, breakpoints, elements };
}
