// Zoom Breakpoints — the core primitive.
// "Responsive design, but the axis is zoom scale instead of viewport width."

export type TierId = "overview" | "normal" | "detail";

export interface Tier {
  id: TierId;
  name: string;
  /** Inclusive lower bound of this tier's ideal zoom range. */
  minZoom: number;
  /** Exclusive upper bound of this tier's ideal zoom range. */
  maxZoom: number;
}

export const TIERS: Tier[] = [
  { id: "overview", name: "Overview", minZoom: 0, maxZoom: 0.5 },
  { id: "normal", name: "Normal", minZoom: 0.5, maxZoom: 1.5 },
  { id: "detail", name: "Detail", minZoom: 1.5, maxZoom: Infinity },
];

export const TIER_ORDER: TierId[] = TIERS.map((t) => t.id);

/**
 * Hysteresis dead-band (in zoom units) applied around each threshold so the
 * active tier doesn't flicker when the zoom hovers right on a boundary.
 */
const BAND = 0.08;

const tierByIndex = (i: number) => TIERS[i];

/** Pure mapping from scale to tier, ignoring hysteresis (used for init). */
export function rawTier(scale: number): TierId {
  const found = TIERS.find((t) => scale >= t.minZoom && scale < t.maxZoom);
  return (found ?? TIERS[TIERS.length - 1]).id;
}

/**
 * Resolve the next active tier from the current one, applying hysteresis so a
 * switch only commits once the scale is clearly past a threshold. Handles
 * multi-tier jumps (e.g. a fast scroll) by stepping until stable.
 */
export function resolveTier(scale: number, current: TierId): TierId {
  let tier = current;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const idx = TIER_ORDER.indexOf(tier);
    const t = tierByIndex(idx);
    if (idx < TIER_ORDER.length - 1 && scale >= t.maxZoom + BAND) {
      tier = TIER_ORDER[idx + 1];
      continue;
    }
    if (idx > 0 && scale <= t.minZoom - BAND) {
      tier = TIER_ORDER[idx - 1];
      continue;
    }
    return tier;
  }
}
