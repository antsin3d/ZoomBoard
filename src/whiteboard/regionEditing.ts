import {
  isRegionTimeline, regionTweenBounds, MIN_REGION_ZOOM, MAX_REGION_ZOOM,
  type Breakpoint,
} from "./model";

/**
 * A cut must leave room for a clip and preserve existing tweens. Otherwise
 * inserting a neighboring divider would silently shorten an animation.
 * Narrow that tween first, or cut farther into the region.
 */
export function canCutRegion(breakpoints: Breakpoint[], zoom: number): boolean {
  if (!isRegionTimeline(breakpoints) || !Number.isFinite(zoom) ||
    zoom <= MIN_REGION_ZOOM || zoom > MAX_REGION_ZOOM / 2 ** 0.02 ||
    breakpoints.some((bp) => Math.abs(Math.log2(zoom / bp.zoom)) < 0.02)) return false;

  let candidateId = "__cut_candidate__";
  while (breakpoints.some((bp) => bp.id === candidateId)) candidateId += "_";
  const proposed = [...breakpoints, {
    id: candidateId, name: "", region: true as const, zoom,
    transition: "crossfade" as const, transitionRange: 0,
    tweenIn: 0.12, tweenOut: 0.12,
  }].sort((a, b) => a.zoom - b.zoom);
  return breakpoints.every((bp) => {
    const before = regionTweenBounds(breakpoints, bp.id);
    const after = regionTweenBounds(proposed, bp.id);
    return Math.abs(before.start - after.start) < 1e-9 &&
      Math.abs(before.end - after.end) < 1e-9;
  });
}
