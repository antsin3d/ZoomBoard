// Core data model for the Zoom Breakpoints authoring system.
// "Responsive design, but the axis is zoom scale instead of viewport width."

export type ShapeType = "rect" | "ellipse" | "triangle" | "diamond" | "hexagon" | "star";
export type ElementType = ShapeType | "text" | "sticky" | "frame" | "connector" | "image" | "group";
export type TransitionMode = "snap" | "crossfade";
export type ToolMode = "select" | ShapeType | "text" | "sticky" | "frame" | "connector";
export type ConnectorStyle = "straight" | "stepped" | "curved" | "bezier";
export type ConnectorEndpointType = "none" | "arrow" | "triangle" | "diamond" | "circle" | "square" | "bar";
export type ConnectorAnchorSide = "top" | "bottom" | "left" | "right" | "auto";
export type ConnectorLineDash = "solid" | "dashed" | "dotted";

/** Where a connector endpoint sits on its attached shape's edge. */
export interface ConnectorAnchor {
  side: ConnectorAnchorSide;
  /** 0–1 along the side (x-fraction for top/bottom, y-fraction for left/right). */
  offset: number;
}

export type TextAlign = "left" | "center" | "right";
export type TextVAlign = "top" | "middle" | "bottom";
export type FontStyle = "normal" | "bold" | "italic" | "bold italic";
export type TextDecoration = "none" | "underline";

/** Curated font options. Value is the CSS font-family stack. */
export const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: "Sans (System)", value: "'Segoe UI', system-ui, sans-serif" },
  { label: "Serif", value: "Georgia, 'Times New Roman', serif" },
  { label: "Mono", value: "'Courier New', ui-monospace, monospace" },
  { label: "Rounded", value: "'Trebuchet MS', 'Segoe UI', sans-serif" },
  { label: "Handwriting", value: "'Comic Sans MS', 'Segoe Print', cursive" },
];

export const DEFAULT_FONT = FONT_OPTIONS[0].value;

// ─── Breakpoints ─────────────────────────────────────────────────────────────

export interface Breakpoint {
  id: string;
  zoom: number;
  name: string;
  transition: TransitionMode;
  /** Region timelines use zoom as a start divider, without a special 1x anchor. */
  region?: true;
  /** Log2 zoom widths before/after this region's start divider. */
  tweenIn?: number;
  tweenOut?: number;
  /**
   * Relative transition duration as a fraction of this breakpoint's zoom
   * (e.g. 0.05 = ±2.5% of the marker zoom). Relative sizing keeps bands
   * visually consistent on the log-scaled timeline.
   */
  transitionRange: number;
}

export const MIN_REGION_ZOOM = 0.05;
export const MAX_REGION_ZOOM = 8;
export const DEFAULT_REGION_TWEEN = 0.12;

export function isRegionTimeline(breakpoints: readonly Breakpoint[]): boolean {
  return breakpoints.length > 0 && breakpoints.every((bp) => bp.region === true);
}

/** Tween windows meet at most at geometric midpoints, never overlap. */
export function regionTweenBounds(
  breakpoints: readonly Breakpoint[],
  id: string,
): { start: number; end: number } {
  const sorted = [...breakpoints].sort((a, b) => a.zoom - b.zoom);
  const index = sorted.findIndex((bp) => bp.id === id);
  return sortedRegionTweenBounds(sorted, index);
}

function sortedRegionTweenBounds(
  sorted: readonly Breakpoint[],
  index: number,
): { start: number; end: number } {
  const bp = sorted[index];
  if (!bp) return { start: MIN_REGION_ZOOM, end: MIN_REGION_ZOOM };
  if (index === 0 || bp.transition === "snap") return { start: bp.zoom, end: bp.zoom };
  const log = Math.log2(bp.zoom);
  const previous = Math.log2(sorted[index - 1].zoom);
  const next = sorted[index + 1];
  const low = Math.max(Math.log2(MIN_REGION_ZOOM), (previous + log) / 2);
  const high = Math.min(Math.log2(MAX_REGION_ZOOM), next ? (log + Math.log2(next.zoom)) / 2 : Infinity);
  const tweenIn = bp.tweenIn ?? DEFAULT_REGION_TWEEN;
  const tweenOut = bp.tweenOut ?? DEFAULT_REGION_TWEEN;
  return {
    start: tweenIn === 0 ? bp.zoom : Math.max(MIN_REGION_ZOOM, 2 ** Math.max(low, log - tweenIn)),
    end: tweenOut === 0 ? bp.zoom : Math.min(MAX_REGION_ZOOM, 2 ** Math.min(high, log + tweenOut)),
  };
}

/** Stable palette shared by the timeline, properties, and layer keyframe dots. */
export const BREAKPOINT_COLORS = [
  "#f59e0b",
  "#ec4899",
  "#3b82f6",
  "#10b981",
  "#8b5cf6",
  "#ef4444",
  "#06b6d4",
  "#f97316",
] as const;

export function breakpointColor(breakpoints: Breakpoint[], id: string): string {
  const index = [...breakpoints].sort((a, b) => a.zoom - b.zoom).findIndex((bp) => bp.id === id);
  return BREAKPOINT_COLORS[Math.max(0, index) % BREAKPOINT_COLORS.length];
}

// ─── Element state ────────────────────────────────────────────────────────────

/** All visual/spatial properties of an element at a single zoom level. */
export interface ElementState {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;    // 0–1
  visible: boolean;
  fill: string;
  stroke: string;
  strokeWidth: number;
  content: string;    // text label (ignored for non-text elements)
  fontSize: number;
  fontFamily: string;
  fontStyle: FontStyle;
  textDecoration: TextDecoration;
  lineHeight: number;
  textColor: string;
  textAlign: TextAlign;
  textVAlign: TextVAlign;
  /** Legacy embedded image data URL; loaded boards render it as a fill texture. */
  imageSrc?: string;
  /** Embedded image textures for shape fills and strokes. */
  fillTextureSrc?: string;
  strokeTextureSrc?: string;
  /** Connector routing mode. */
  connectorStyle: ConnectorStyle;
  /** Rendered connector line points in element-local coordinates. */
  connectorPoints?: number[];
  /** Endpoint arrowhead / marker kinds. */
  connectorStartType: ConnectorEndpointType;
  connectorEndType: ConnectorEndpointType;
  /** Arrowhead sizes in world units (before zoom scaling). */
  connectorStartSize: number;
  connectorEndSize: number;
  /** Line dash preset. */
  connectorDash: ConnectorLineDash;
  /** Inline label position: 0 = start, 0.5 = middle, 1 = end. */
  connectorLabelPosition: number;
  /** Inline label pixel offset from the line. */
  connectorLabelOffsetX: number;
  connectorLabelOffsetY: number;
  /** Render-only interpolated horizontal text anchor: 0 = left, 0.5 = center, 1 = right. */
  textAnchorX?: number;
  /** Render-only interpolated vertical text anchor: 0 = top, 0.5 = middle, 1 = bottom. */
  textAnchorY?: number;
}

export const DEFAULT_CONNECTOR_START_TYPE: ConnectorEndpointType = "none";
export const DEFAULT_CONNECTOR_END_TYPE: ConnectorEndpointType = "arrow";
export const DEFAULT_CONNECTOR_ARROW_SIZE = 12;

/** Back-compat: the old "bezier" route renders as the new "curved" route. */
export function normalizeConnectorStyle(style: ConnectorStyle): "straight" | "stepped" | "curved" {
  if (style === "bezier" || style === "curved") return "curved";
  if (style === "stepped") return "stepped";
  return "straight";
}

export const DEFAULT_STATE: ElementState = {
  x: 0,
  y: 0,
  width: 120,
  height: 80,
  rotation: 0,
  opacity: 1,
  visible: true,
  fill: "#e8edf2",
  stroke: "#b0bec5",
  strokeWidth: 1.5,
  content: "",
  fontSize: 14,
  fontFamily: DEFAULT_FONT,
  fontStyle: "normal",
  textDecoration: "none",
  lineHeight: 1.2,
  textColor: "#1b1f24",
  textAlign: "center",
  textVAlign: "middle",
  connectorStyle: "stepped",
  connectorStartType: "none",
  connectorEndType: "none",
  connectorStartSize: DEFAULT_CONNECTOR_ARROW_SIZE,
  connectorEndSize: DEFAULT_CONNECTOR_ARROW_SIZE,
  connectorDash: "solid",
  connectorLabelPosition: 0.5,
  connectorLabelOffsetX: 0,
  connectorLabelOffsetY: 0,
};

// ─── Variants ─────────────────────────────────────────────────────────────────

/**
 * A named reusable representation for an element. Different breakpoints can
 * assign different variants without duplicating their visual property patches.
 */
export interface Variant {
  id: string;
  name: string;
  /** Sparse visual overrides that define this representation. */
  patch: Partial<ElementState>;
}

/** Property keys that belong to a reusable representation (not spatial layout). */
export const VARIANT_PATCH_KEYS: (keyof ElementState)[] = [
  "width", "height", "opacity", "visible",
  "fill", "stroke", "strokeWidth",
  "content", "fontSize", "fontFamily", "fontStyle", "textDecoration",
  "lineHeight", "textColor", "textAlign", "textVAlign",
  "imageSrc", "fillTextureSrc", "strokeTextureSrc", "connectorStyle",
  "connectorStartType", "connectorEndType", "connectorStartSize",
  "connectorEndSize", "connectorDash", "connectorLabelPosition",
  "connectorLabelOffsetX", "connectorLabelOffsetY",
];

export function pickVariantPatch(state: Partial<ElementState>): Partial<ElementState> {
  const patch: Partial<ElementState> = {};
  for (const key of VARIANT_PATCH_KEYS) {
    if (key in state) {
      (patch as Record<string, unknown>)[key] = state[key];
    }
  }
  return patch;
}

// ─── Board element ────────────────────────────────────────────────────────────

export interface BoardElement {
  id: string;
  type: ElementType;
  name: string;
  parentId?: string;
  /** Optional attached endpoints for connector elements. */
  connectorStartId?: string;
  connectorEndId?: string;
  /** Edge anchors for attached endpoints. Absent = automatic (face the other end). */
  connectorStartAnchor?: ConnectorAnchor;
  connectorEndAnchor?: ConnectorAnchor;
  /** Named reusable representations for breakpoint-based content swaps. */
  variants?: Variant[];
  /**
   * Which variant is active at each presentation key (Base / breakpoint id).
   * Absent key → no variant (keyframes alone drive the presentation).
   */
  variantAssignments?: Record<string, string>;
  /** Truth at 1x zoom / no active breakpoint. */
  base: ElementState;
  /**
   * Region-local defaults captured when a region is split. These preserve the
   * picture without counting as user-authored keyframes/customizations.
   */
  regionDefaults?: Record<string, Partial<ElementState>>;
  /**
   * Sparse overrides per breakpoint.
   * Only properties that differ from base are stored.
   * Key is Breakpoint.id.
   */
  keyframes: Record<string, Partial<ElementState>>;
}

// ─── Board ────────────────────────────────────────────────────────────────────

export interface Board {
  /** Sorted ascending by zoom value. */
  breakpoints: Breakpoint[];
  elements: BoardElement[];
}

// ─── Core algorithm: threshold-based resolution ────────────────────────────────

/**
 * The zoom at which the Base state is anchored.
 * This acts as a virtual marker between user-defined breakpoints so that
 * zooming to 1x always shows the un-overridden base state, regardless of
 * where the surrounding breakpoints are placed.
 */
export const BASE_ZOOM = 1.0;
export const BASE_KEYFRAME_ID = "__base__";

/** Presentation key used for variant assignment at the current zoom. */
export function presentationKeyForZoom(
  zoom: number,
  breakpoints: Breakpoint[],
): string {
  return activeBreakpoint(zoom, breakpoints)?.id ?? BASE_KEYFRAME_ID;
}

/** Resolve the variant assigned for a presentation key, if any. */
export function activeVariant(
  element: BoardElement,
  presentationKey: string,
): Variant | undefined {
  const variantId = element.variantAssignments?.[presentationKey];
  if (!variantId || !element.variants?.length) return undefined;
  return element.variants.find((variant) => variant.id === variantId);
}

export function presentationState(
  element: BoardElement,
  presentationKey: string,
  breakpoints?: readonly Breakpoint[],
): ElementState {
  const basePresentation = {
    ...DEFAULT_STATE,
    ...element.base,
    ...(element.keyframes[BASE_KEYFRAME_ID] ?? {}),
  };
  const variant = activeVariant(element, presentationKey);
  const withVariant = variant
    ? { ...basePresentation, ...variant.patch }
    : basePresentation;
  if (presentationKey === BASE_KEYFRAME_ID) return withVariant;
  const regionDefault = breakpoints && isRegionTimeline(breakpoints)
    ? element.regionDefaults?.[presentationKey]
    : undefined;
  const overrides = element.keyframes[presentationKey];
  return { ...withVariant, ...regionDefault, ...overrides };
}

// ─── Interpolation helpers (used by resolveState) ─────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function lerpHex(a: string, b: string, t: number): string {
  if (!a.startsWith("#") || !b.startsWith("#") || a.length < 7 || b.length < 7)
    return t < 0.5 ? a : b;
  const r = Math.round(lerp(parseInt(a.slice(1, 3), 16), parseInt(b.slice(1, 3), 16), t));
  const g = Math.round(lerp(parseInt(a.slice(3, 5), 16), parseInt(b.slice(3, 5), 16), t));
  const bl = Math.round(lerp(parseInt(a.slice(5, 7), 16), parseInt(b.slice(5, 7), 16), t));
  return "#" + [r, g, bl].map((n) => n.toString(16).padStart(2, "0")).join("");
}

function textAlignAnchor(align: TextAlign): number {
  if (align === "left") return 0;
  if (align === "right") return 1;
  return 0.5;
}

function textVAlignAnchor(align: TextVAlign): number {
  if (align === "top") return 0;
  if (align === "bottom") return 1;
  return 0.5;
}

function rewriteText(from: string, to: string, t: number): string {
  if (from === to) return to;
  if (t <= 0) return from;
  if (t >= 1) return to;

  const SCRAMBLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789·";
  const len = Math.max(1, Math.round(lerp(from.length, to.length, t)));
  let out = "";
  for (let i = 0; i < len; i++) {
    // Characters settle left-to-right across the transition window.
    const settleAt = len === 1 ? 0.5 : 0.12 + (i / (len - 1)) * 0.76;
    const local = smoothstep((t - (settleAt - 0.1)) / 0.2);
    if (local <= 0) {
      out += from[i] ?? (to[i] ?? "");
    } else if (local >= 1) {
      out += to[i] ?? "";
    } else {
      const seed = (i * 2654435761) ^ Math.floor(t * 48) ^ from.length ^ to.length;
      out += SCRAMBLE[Math.abs(seed) % SCRAMBLE.length];
    }
  }
  return out;
}

function interpolateStates(a: ElementState, b: ElementState, t: number): ElementState {
  // Visibility crossfade: when visible state differs, tween opacity to fade in/out
  let opacity = lerp(a.opacity, b.opacity, t);
  if (a.visible !== b.visible) {
    opacity = a.visible ? lerp(a.opacity, 0, t) : lerp(0, b.opacity, t);
  }

  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    width: lerp(a.width, b.width, t),
    height: lerp(a.height, b.height, t),
    rotation: lerp(a.rotation, b.rotation, t),
    opacity,
    visible: (a.visible || b.visible) && opacity > 0,
    fill: lerpHex(a.fill, b.fill, t),
    stroke: lerpHex(a.stroke, b.stroke, t),
    strokeWidth: lerp(a.strokeWidth, b.strokeWidth, t),
    fontSize: lerp(a.fontSize, b.fontSize, t),
    lineHeight: lerp(a.lineHeight, b.lineHeight, t),
    // Text rewrites through a scramble settle; other discrete props snap mid-way.
    content: rewriteText(a.content, b.content, t),
    fontFamily: t < 0.5 ? a.fontFamily : b.fontFamily,
    fontStyle: t < 0.5 ? a.fontStyle : b.fontStyle,
    textDecoration: t < 0.5 ? a.textDecoration : b.textDecoration,
    textColor: lerpHex(a.textColor, b.textColor, t),
    textAlign: t < 0.5 ? a.textAlign : b.textAlign,
    textVAlign: t < 0.5 ? a.textVAlign : b.textVAlign,
    imageSrc: t < 0.5 ? a.imageSrc : b.imageSrc,
    fillTextureSrc: t < 0.5 ? a.fillTextureSrc : b.fillTextureSrc,
    strokeTextureSrc: t < 0.5 ? a.strokeTextureSrc : b.strokeTextureSrc,
    connectorStyle: t < 0.5 ? a.connectorStyle : b.connectorStyle,
    connectorPoints: t < 0.5 ? a.connectorPoints : b.connectorPoints,
    connectorStartType: t < 0.5 ? a.connectorStartType : b.connectorStartType,
    connectorEndType: t < 0.5 ? a.connectorEndType : b.connectorEndType,
    connectorStartSize: lerp(a.connectorStartSize, b.connectorStartSize, t),
    connectorEndSize: lerp(a.connectorEndSize, b.connectorEndSize, t),
    connectorDash: t < 0.5 ? a.connectorDash : b.connectorDash,
    connectorLabelPosition: lerp(a.connectorLabelPosition, b.connectorLabelPosition, t),
    connectorLabelOffsetX: lerp(a.connectorLabelOffsetX, b.connectorLabelOffsetX, t),
    connectorLabelOffsetY: lerp(a.connectorLabelOffsetY, b.connectorLabelOffsetY, t),
    textAnchorX: lerp(textAlignAnchor(a.textAlign), textAlignAnchor(b.textAlign), t),
    textAnchorY: lerp(textVAlignAnchor(a.textVAlign), textVAlignAnchor(b.textVAlign), t),
  };
}

// Resolves without transition interpolation — pure threshold lookup.
// Use this for the properties editor so the panel always shows the actual
// stored keyframe value rather than the interpolated canvas-rendering value.
export function resolveStateDirect(
  element: BoardElement,
  zoom: number,
  breakpoints: Breakpoint[],
): ElementState {
  return presentationState(element, presentationKeyForZoom(zoom, breakpoints), breakpoints);
}

/**
 * Half-width of a breakpoint's transition zone in linear zoom units.
 * Duration is stored relatively so equal percentages look equal on a log timeline.
 */
export function transitionHalfWidth(bp: Breakpoint): number {
  return (Math.max(0, bp.transitionRange) * Math.max(bp.zoom, 0.001)) / 2;
}

/**
 * Threshold-based resolution with optional crossfade transitions.
 *
 * If the current zoom falls within a breakpoint's `transitionRange` zone
 * (centred on the breakpoint), states are smoothly interpolated between the
 * two sides. Otherwise falls back to the direct threshold lookup.
 *
 * Below Base:  breakpoints apply at or below their zoom marker.
 * Above Base:  breakpoints apply at or above their zoom marker.
 */
export function resolveState(
  element: BoardElement,
  zoom: number,
  breakpoints: Breakpoint[],
): ElementState {
  if (isRegionTimeline(breakpoints)) {
    const sorted = [...breakpoints].sort((a, b) => a.zoom - b.zoom);
    // The first start only establishes the range; there is no state before it.
    for (let index = 1; index < sorted.length; index++) {
      const bp = sorted[index];
      if (bp.transition === "snap") continue;
      const { start, end } = sortedRegionTweenBounds(sorted, index);
      if (end <= start || zoom < start || zoom > end) continue;
      const from = presentationState(element, sorted[index - 1].id, sorted);
      const to = presentationState(element, bp.id, sorted);
      if (zoom <= start) return from;
      if (zoom >= end) return to;
      const t = (Math.log2(zoom) - Math.log2(start)) / (Math.log2(end) - Math.log2(start));
      return interpolateStates(from, to, smoothstep(t));
    }
    return resolveStateDirect(element, zoom, sorted);
  }
  // Check if zoom falls inside any breakpoint's transition zone.
  for (const bp of breakpoints) {
    if (!bp.transitionRange || bp.transitionRange <= 0) continue;
    const half = transitionHalfWidth(bp);
    const low = bp.zoom - half;
    const high = bp.zoom + half;
    if (zoom < low || zoom > high) continue;

    const t = (zoom - low) / (high - low); // 0 at low end, 1 at high end
    const smooth = smoothstep(t);

    // State the element would show WITHOUT this breakpoint's contribution.
    const bpsWithout = breakpoints.filter((b) => b.id !== bp.id);
    const stateWithout = resolveStateDirect(element, zoom, bpsWithout);

    // State fully inside this breakpoint (includes its assigned variant).
    const stateWith = presentationState(element, bp.id, breakpoints);

    // Below-base bp (e.g. Overview 0.25×):
    //   t=0 (low zoom end) → breakpoint active; t=1 (high zoom end) → base side
    // Above-base bp (e.g. Detail 2×):
    //   t=0 (low zoom end) → base side; t=1 (high zoom end) → breakpoint active
    const startState = bp.zoom < BASE_ZOOM ? stateWith : stateWithout;
    const endState = bp.zoom < BASE_ZOOM ? stateWithout : stateWith;

    return interpolateStates(startState, endState, smooth);
  }

  return resolveStateDirect(element, zoom, breakpoints);
}

/**
 * Returns the user-defined breakpoint active at the current zoom, or undefined
 * when the zoom falls in the Base range.
 *
 * The Base range is bounded by the nearest below-base and above-base
 * breakpoints, using the breakpoint markers themselves as exact thresholds:
 *
 *   [Overview <= 0.25] [Base from >0.25 to <2.0] [Detail >= 2.0]
 */
export function activeBreakpoint(
  zoom: number,
  breakpoints: Breakpoint[],
): Breakpoint | undefined {
  if (breakpoints.length === 0) return undefined;
  if (isRegionTimeline(breakpoints)) {
    const sorted = [...breakpoints].sort((a, b) => a.zoom - b.zoom);
    for (let index = sorted.length - 1; index >= 0; index--) {
      if (zoom >= sorted[index].zoom) return sorted[index];
    }
    return sorted[0];
  }

  const belowBase = breakpoints
    .filter((bp) => bp.zoom < BASE_ZOOM)
    .sort((a, b) => a.zoom - b.zoom);
  const aboveBase = breakpoints
    .filter((bp) => bp.zoom > BASE_ZOOM)
    .sort((a, b) => a.zoom - b.zoom);

  if (zoom < BASE_ZOOM) {
    // Below base, choose the first breakpoint whose threshold is at/above
    // the current zoom. This means a 0.25x Overview marker applies at 0.25x
    // and below, but not at 0.3x or 1x.
    return belowBase.find((bp) => zoom <= bp.zoom);
  }

  if (zoom > BASE_ZOOM) {
    // Above base, choose the last breakpoint whose threshold is at/below
    // the current zoom. This means a 2x Detail marker applies at 2x and above,
    // but not at 1.8x or 1x.
    for (let i = aboveBase.length - 1; i >= 0; i--) {
      if (zoom >= aboveBase[i].zoom) return aboveBase[i];
    }
  }

  return undefined;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}
