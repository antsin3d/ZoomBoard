import {
  BASE_KEYFRAME_ID,
  BASE_ZOOM,
  normalizeConnectorStyle,
  presentationState,
  resolveState,
  type Board,
  type BoardElement,
  type ConnectorAnchor,
  type ConnectorAnchorSide,
  type ConnectorLineDash,
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
  // A presentation ID is authoritative: 1x can now lie in any region,
  // and looking up the baseline by zoom would accidentally select that region.
  return presentationState(element, key, board.breakpoints);
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

// ─── Live drag preview (ephemeral, no history) ────────────────────────────────
// While a node is dragged, the canvas writes its in-flight position here so
// attached connectors (and the node itself) re-render live. Cleared on drop.

const livePositions = new Map<string, Point>();

export function setLivePosition(id: string, pos: Point): void {
  livePositions.set(id, pos);
}

export function clearLivePositions(): void {
  livePositions.clear();
}

/** Render-state override so the dragged node doesn't snap back mid-drag. */
export function withLiveState<T extends { x: number; y: number }>(state: T, id: string): T {
  const live = livePositions.get(id);
  return live ? { ...state, x: live.x, y: live.y } : state;
}

export function worldPositionAtZoom(board: Board, element: BoardElement, zoom: number): Point {
  const state = resolveState(element, zoom, board.breakpoints);
  // Ephemeral drag override (no history): while an element is dragged on the
  // canvas its dependents — attached connectors — track it live.
  const live = livePositions.get(element.id);
  const lx = live?.x ?? state.x;
  const ly = live?.y ?? state.y;
  if (!element.parentId) return { x: lx, y: ly };
  const parent = board.elements.find((candidate) => candidate.id === element.parentId);
  if (!parent) return { x: lx, y: ly };
  const parentWorld = worldPositionAtZoom(board, parent, zoom);
  return { x: parentWorld.x + lx, y: parentWorld.y + ly };
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

/** True for types whose connector edge follows the axis-aligned box. */
function usesBoxOutline(type: BoardElement["type"]): boolean {
  return (
    type === "rect" ||
    type === "sticky" ||
    type === "frame" ||
    type === "text" ||
    type === "image" ||
    type === "group" ||
    type === "connector"
  );
}

/**
 * Local-space polygon matching ElementNode.shapePath (closed, no duplicate end).
 * Ellipse is handled analytically — returns null.
 */
export function shapePolygonLocal(
  type: BoardElement["type"],
  width: number,
  height: number,
): Point[] | null {
  if (type === "ellipse" || usesBoxOutline(type)) return null;
  if (type === "triangle") {
    return [
      { x: width / 2, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ];
  }
  if (type === "diamond") {
    return [
      { x: width / 2, y: 0 },
      { x: width, y: height / 2 },
      { x: width / 2, y: height },
      { x: 0, y: height / 2 },
    ];
  }
  if (type === "hexagon") {
    return [
      { x: width * 0.25, y: 0 },
      { x: width * 0.75, y: 0 },
      { x: width, y: height / 2 },
      { x: width * 0.75, y: height },
      { x: width * 0.25, y: height },
      { x: 0, y: height / 2 },
    ];
  }
  if (type === "star") {
    const cx = width / 2;
    const cy = height / 2;
    const outerX = width / 2;
    const outerY = height / 2;
    const pts: Point[] = [];
    for (let point = 0; point < 10; point += 1) {
      const angle = -Math.PI / 2 + (point * Math.PI) / 5;
      const radius = point % 2 === 0 ? 1 : 0.44;
      pts.push({
        x: cx + Math.cos(angle) * outerX * radius,
        y: cy + Math.sin(angle) * outerY * radius,
      });
    }
    return pts;
  }
  return null;
}

/** World-space outline for snap highlights. Null → draw as rect/ellipse. */
export function shapeOutlineWorld(
  type: BoardElement["type"],
  bounds: Bounds,
): { kind: "rect" } | { kind: "ellipse" } | { kind: "polygon"; points: number[] } {
  if (type === "ellipse") return { kind: "ellipse" };
  const local = shapePolygonLocal(type, bounds.width, bounds.height);
  if (!local) return { kind: "rect" };
  const points: number[] = [];
  for (const p of local) {
    points.push(bounds.x + p.x, bounds.y + p.y);
  }
  return { kind: "polygon", points };
}

function edgePointBox(bounds: Bounds, toward: Point): Point {
  const origin = center(bounds);
  const dx = toward.x - origin.x;
  const dy = toward.y - origin.y;
  if (dx === 0 && dy === 0) return origin;
  const halfWidth = Math.max(bounds.width / 2, 0.5);
  const halfHeight = Math.max(bounds.height / 2, 0.5);
  const scale = 1 / Math.max(Math.abs(dx) / halfWidth, Math.abs(dy) / halfHeight);
  return { x: origin.x + dx * scale, y: origin.y + dy * scale };
}

function edgePointEllipse(bounds: Bounds, toward: Point): Point {
  const origin = center(bounds);
  const dx = toward.x - origin.x;
  const dy = toward.y - origin.y;
  if (dx === 0 && dy === 0) {
    return { x: origin.x + Math.max(bounds.width / 2, 0.5), y: origin.y };
  }
  const rx = Math.max(bounds.width / 2, 0.5);
  const ry = Math.max(bounds.height / 2, 0.5);
  const scale = 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
  return { x: origin.x + dx * scale, y: origin.y + dy * scale };
}

/** Ray from `origin` along `dir` vs segment a→b. Returns t >= 0 along the ray, or null. */
function raySegmentHit(
  origin: Point,
  dir: Point,
  a: Point,
  b: Point,
): number | null {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const denom = dir.x * ey - dir.y * ex;
  if (Math.abs(denom) < 1e-9) return null;
  const sx = a.x - origin.x;
  const sy = a.y - origin.y;
  const t = (sx * ey - sy * ex) / denom;
  const u = (sx * dir.y - sy * dir.x) / denom;
  if (t < 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return t;
}

function edgePointPolygon(bounds: Bounds, polygon: Point[], toward: Point): Point {
  const origin = center(bounds);
  const dx = toward.x - origin.x;
  const dy = toward.y - origin.y;
  if (dx === 0 && dy === 0) {
    return { x: bounds.x + polygon[0].x, y: bounds.y + polygon[0].y };
  }
  const dir = { x: dx, y: dy };
  let bestT = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = { x: bounds.x + polygon[i].x, y: bounds.y + polygon[i].y };
    const b = {
      x: bounds.x + polygon[(i + 1) % polygon.length].x,
      y: bounds.y + polygon[(i + 1) % polygon.length].y,
    };
    const t = raySegmentHit(origin, dir, a, b);
    if (t !== null && t < bestT) bestT = t;
  }
  if (!Number.isFinite(bestT)) return edgePointBox(bounds, toward);
  return { x: origin.x + dir.x * bestT, y: origin.y + dir.y * bestT };
}

/** Intersection of the ray from the shape center through `toward` with the outline. */
export function edgePoint(
  bounds: Bounds,
  toward: Point,
  type: BoardElement["type"] = "rect",
): Point {
  if (type === "ellipse") return edgePointEllipse(bounds, toward);
  const polygon = shapePolygonLocal(type, bounds.width, bounds.height);
  if (polygon) return edgePointPolygon(bounds, polygon, toward);
  return edgePointBox(bounds, toward);
}

function pointInPolygon(local: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    if (pi.y > local.y === pj.y > local.y) continue;
    const xAt = ((pj.x - pi.x) * (local.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (local.x < xAt) inside = !inside;
  }
  return inside;
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Whether `point` is inside the shape or within `pad` of its outline. */
export function pointHitsShape(
  type: BoardElement["type"],
  bounds: Bounds,
  point: Point,
  pad: number,
): boolean {
  const local = { x: point.x - bounds.x, y: point.y - bounds.y };
  if (type === "ellipse") {
    const rx = Math.max(bounds.width / 2, 0.5);
    const ry = Math.max(bounds.height / 2, 0.5);
    const nx = (local.x - rx) / rx;
    const ny = (local.y - ry) / ry;
    const r = Math.sqrt(nx * nx + ny * ny);
    if (r <= 1) return true;
    // Approximate pad in local ellipse space using the smaller radius.
    const padNorm = pad / Math.min(rx, ry);
    return r <= 1 + padNorm;
  }
  const polygon = shapePolygonLocal(type, bounds.width, bounds.height);
  if (!polygon) {
    return (
      point.x >= bounds.x - pad &&
      point.x <= bounds.x + bounds.width + pad &&
      point.y >= bounds.y - pad &&
      point.y <= bounds.y + bounds.height + pad
    );
  }
  if (pointInPolygon(local, polygon)) return true;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (distToSegment(local, a, b) <= pad) return true;
  }
  return false;
}

// ─── Connector anchors ───────────────────────────────────────────────────────

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

/** Concrete point on a shape's edge for an explicit side/offset anchor. */
export function anchorPoint(
  bounds: Bounds,
  anchor: ConnectorAnchor | undefined,
  toward: Point,
  type: BoardElement["type"] = "rect",
): Point {
  if (!anchor || anchor.side === "auto") return edgePoint(bounds, toward, type);
  const offset = clamp01(anchor.offset);
  let sidePoint: Point;
  switch (anchor.side) {
    case "top":
      sidePoint = { x: bounds.x + offset * bounds.width, y: bounds.y };
      break;
    case "bottom":
      sidePoint = { x: bounds.x + offset * bounds.width, y: bounds.y + bounds.height };
      break;
    case "left":
      sidePoint = { x: bounds.x, y: bounds.y + offset * bounds.height };
      break;
    case "right":
      sidePoint = { x: bounds.x + bounds.width, y: bounds.y + offset * bounds.height };
      break;
    default:
      return edgePoint(bounds, toward, type);
  }
  // Project the AABB side point onto the real outline (circle, diamond, …).
  return edgePoint(bounds, sidePoint, type);
}

/** Nearest edge anchor on a shape to an arbitrary world point. */
export function closestAnchorOnBounds(
  bounds: Bounds,
  point: Point,
  _type: BoardElement["type"] = "rect",
): ConnectorAnchor {
  // Encode the ray from center→point as the AABB side that same ray hits.
  // anchorPoint reconstructs via the same ray, so the round-trip is stable
  // (nearest-side encoding jumped between top/right near corners).
  const boxHit = edgePointBox(bounds, point);
  const w = Math.max(bounds.width, 1);
  const h = Math.max(bounds.height, 1);
  const cx = bounds.x + w / 2;
  const cy = bounds.y + h / 2;
  const dx = boxHit.x - cx;
  const dy = boxHit.y - cy;
  // Prefer the dominant axis so corner hits pick one side consistently.
  if (Math.abs(dx) * h >= Math.abs(dy) * w) {
    if (dx >= 0) {
      return { side: "right", offset: Math.round(clamp01((boxHit.y - bounds.y) / h) * 100) / 100 };
    }
    return { side: "left", offset: Math.round(clamp01((boxHit.y - bounds.y) / h) * 100) / 100 };
  }
  if (dy >= 0) {
    return { side: "bottom", offset: Math.round(clamp01((boxHit.x - bounds.x) / w) * 100) / 100 };
  }
  return { side: "top", offset: Math.round(clamp01((boxHit.x - bounds.x) / w) * 100) / 100 };
}

function inferSide(from: Point, to: Point): Exclude<ConnectorAnchorSide, "auto"> {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

function effectiveSide(
  anchor: ConnectorAnchor | undefined,
  from: Point,
  to: Point,
): Exclude<ConnectorAnchorSide, "auto"> {
  if (anchor && anchor.side !== "auto") return anchor.side;
  return inferSide(from, to);
}

function sideDirection(side: Exclude<ConnectorAnchorSide, "auto">): Point {
  switch (side) {
    case "right": return { x: 1, y: 0 };
    case "left": return { x: -1, y: 0 };
    case "bottom": return { x: 0, y: 1 };
    case "top": return { x: 0, y: -1 };
  }
}

// ─── Connector routing ───────────────────────────────────────────────────────

export interface RoutedConnector {
  /** Flat world-space points. Cubic bezier when `bezier` is true. */
  worldPoints: number[];
  bezier: boolean;
}

function dedupeFlat(points: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    const n = out.length;
    if (n >= 2 && Math.abs(out[n - 2] - x) < 0.01 && Math.abs(out[n - 1] - y) < 0.01) continue;
    out.push(x, y);
  }
  return out;
}

function flattenPoints(points: Point[]): number[] {
  const out: number[] = [];
  for (const p of points) out.push(p.x, p.y);
  return dedupeFlat(out);
}

/** Padding around shapes that connectors should stay outside of. */
const ROUTE_MARGIN = 18;
const ROUTE_STUB = 20;

function expandBounds(bounds: Bounds, pad: number): Bounds {
  return {
    x: bounds.x - pad,
    y: bounds.y - pad,
    width: bounds.width + pad * 2,
    height: bounds.height + pad * 2,
  };
}

/** Axis-aligned open segment vs padded obstacle (boundary grazing is allowed). */
function orthoSegmentHitsBox(a: Point, b: Point, box: Bounds): boolean {
  const left = box.x;
  const right = box.x + box.width;
  const top = box.y;
  const bottom = box.y + box.height;
  const eps = 0.5;

  if (Math.abs(a.y - b.y) <= eps) {
    const y = (a.y + b.y) / 2;
    if (y <= top + eps || y >= bottom - eps) return false;
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    return x0 < right - eps && x1 > left + eps;
  }
  if (Math.abs(a.x - b.x) <= eps) {
    const x = (a.x + b.x) / 2;
    if (x <= left + eps || x >= right - eps) return false;
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    return y0 < bottom - eps && y1 > top + eps;
  }
  // Non-orthogonal — treat as blocked so A* only uses ortho links.
  return true;
}

function pathHitsObstacles(points: Point[], obstacles: Bounds[]): boolean {
  for (let i = 0; i < points.length - 1; i += 1) {
    for (const box of obstacles) {
      if (orthoSegmentHitsBox(points[i], points[i + 1], box)) return true;
    }
  }
  return false;
}

function pathLength(points: Point[]): number {
  let len = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    len += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  return len;
}

/**
 * One- or two-segment orthogonal link from a→b that clears obstacles.
 * Returns intermediate points + b (not including a), or null.
 */
function orthoLink(
  a: Point,
  b: Point,
  obstacles: Bounds[],
  preferHorizontalFirst: boolean,
): Point[] | null {
  const eps = 0.5;
  if (Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps) return [b];
  if (Math.abs(a.x - b.x) <= eps || Math.abs(a.y - b.y) <= eps) {
    if (pathHitsObstacles([a, b], obstacles)) return null;
    return [b];
  }
  const midHV = { x: b.x, y: a.y };
  const midVH = { x: a.x, y: b.y };
  const hv = !pathHitsObstacles([a, midHV, b], obstacles);
  const vh = !pathHitsObstacles([a, midVH, b], obstacles);
  if (hv && vh) return preferHorizontalFirst ? [midHV, b] : [midVH, b];
  if (hv) return [midHV, b];
  if (vh) return [midVH, b];
  return null;
}

function obstacleCorners(box: Bounds): Point[] {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
}

function basicSteppedPoints(
  start: Point,
  end: Point,
  startSide: Exclude<ConnectorAnchorSide, "auto">,
  endSide: Exclude<ConnectorAnchorSide, "auto">,
  stub: number,
): Point[] {
  const sDir = sideDirection(startSide);
  const eDir = sideDirection(endSide);
  const s1: Point = { x: start.x + sDir.x * stub, y: start.y + sDir.y * stub };
  const e1: Point = { x: end.x + eDir.x * stub, y: end.y + eDir.y * stub };
  const startH = startSide === "left" || startSide === "right";
  const endH = endSide === "left" || endSide === "right";

  let mid: Point[];
  if (startH && endH) {
    // Same horizontal facing: if stubs cross, route around vertically.
    const sameDir = sDir.x === eDir.x;
    const gap = (e1.x - s1.x) * sDir.x;
    if (sameDir || gap < stub) {
      const aroundY =
        Math.abs(s1.y - start.y) + Math.abs(e1.y - end.y) < 1
          ? Math.min(s1.y, e1.y) - stub * 2
          : (s1.y + e1.y) / 2;
      // Prefer the side with more clearance between the two stubs' vertical span.
      const midY = s1.y <= e1.y
        ? Math.min(s1.y, e1.y) - stub
        : Math.max(s1.y, e1.y) + stub;
      const useMid = sameDir ? midY : aroundY;
      mid = [
        { x: s1.x, y: useMid },
        { x: e1.x, y: useMid },
      ];
    } else {
      const midX = (s1.x + e1.x) / 2;
      mid = [
        { x: midX, y: s1.y },
        { x: midX, y: e1.y },
      ];
    }
  } else if (!startH && !endH) {
    const sameDir = sDir.y === eDir.y;
    const gap = (e1.y - s1.y) * sDir.y;
    if (sameDir || gap < stub) {
      const midX = s1.x <= e1.x
        ? Math.min(s1.x, e1.x) - stub
        : Math.max(s1.x, e1.x) + stub;
      mid = [
        { x: midX, y: s1.y },
        { x: midX, y: e1.y },
      ];
    } else {
      const midY = (s1.y + e1.y) / 2;
      mid = [
        { x: s1.x, y: midY },
        { x: e1.x, y: midY },
      ];
    }
  } else if (startH) {
    mid = [{ x: e1.x, y: s1.y }];
  } else {
    mid = [{ x: s1.x, y: e1.y }];
  }

  return [start, s1, ...mid, e1, end];
}

/**
 * Orthogonal route from start→end that stays outside `obstacles`.
 * Uses stub exits so the line leaves attached shapes cleanly, then A*
 * over obstacle corners when the simple elbow would clip another shape.
 */
function routeOrthogonalAvoiding(
  start: Point,
  end: Point,
  startSide: Exclude<ConnectorAnchorSide, "auto">,
  endSide: Exclude<ConnectorAnchorSide, "auto">,
  obstacles: Bounds[],
): number[] {
  const stub = ROUTE_STUB;
  const preferH = startSide === "left" || startSide === "right";
  const basic = basicSteppedPoints(start, end, startSide, endSide, stub);
  if (!pathHitsObstacles(basic, obstacles)) return flattenPoints(basic);

  const sDir = sideDirection(startSide);
  const eDir = sideDirection(endSide);
  const s1: Point = { x: start.x + sDir.x * stub, y: start.y + sDir.y * stub };
  const e1: Point = { x: end.x + eDir.x * stub, y: end.y + eDir.y * stub };
  // Extra escape points help leave crowded clusters.
  const s2: Point = { x: start.x + sDir.x * stub * 2.5, y: start.y + sDir.y * stub * 2.5 };
  const e2: Point = { x: end.x + eDir.x * stub * 2.5, y: end.y + eDir.y * stub * 2.5 };

  const nodes: Point[] = [s1, s2, e1, e2];
  for (const box of obstacles) {
    for (const c of obstacleCorners(box)) nodes.push(c);
  }

  // Deduplicate nearly-identical waypoints.
  const waypoints: Point[] = [];
  for (const n of nodes) {
    if (waypoints.some((w) => Math.hypot(w.x - n.x, w.y - n.y) < 1)) continue;
    waypoints.push(n);
  }

  const startIdx = 0; // s1
  // Find e1 index (may shift after dedupe — search by proximity).
  let endIdx = waypoints.findIndex((w) => Math.hypot(w.x - e1.x, w.y - e1.y) < 1);
  if (endIdx < 0) {
    waypoints.push(e1);
    endIdx = waypoints.length - 1;
  }

  const N = waypoints.length;
  const dist = new Array<number>(N).fill(Infinity);
  const prev = new Array<number>(N).fill(-1);
  const prevVia: (Point[] | null)[] = new Array(N).fill(null);
  dist[startIdx] = 0;
  const used = new Array<boolean>(N).fill(false);

  for (let iter = 0; iter < N; iter += 1) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < N; i += 1) {
      if (!used[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
    }
    if (u < 0 || u === endIdx) break;
    used[u] = true;
    for (let v = 0; v < N; v += 1) {
      if (used[v]) continue;
      const link = orthoLink(waypoints[u], waypoints[v], obstacles, preferH);
      if (!link) continue;
      const cost = pathLength([waypoints[u], ...link]);
      const next = dist[u] + cost;
      if (next < dist[v]) {
        dist[v] = next;
        prev[v] = u;
        prevVia[v] = link;
      }
    }
  }

  if (prev[endIdx] < 0 && startIdx !== endIdx) {
    // No clear path — fall back to the basic stepped route.
    return flattenPoints(basic);
  }

  // Reconstruct waypoint chain, then expand ortho links.
  const chain: number[] = [];
  for (let cur = endIdx; cur >= 0; cur = prev[cur]) {
    chain.push(cur);
    if (cur === startIdx) break;
  }
  chain.reverse();

  const points: Point[] = [start, s1];
  for (let i = 1; i < chain.length; i += 1) {
    const link = prevVia[chain[i]];
    if (link) {
      for (const p of link) points.push(p);
    } else {
      points.push(waypoints[chain[i]]);
    }
  }
  // Ensure we end with e1 → end (link may already include e1).
  const last = points[points.length - 1];
  if (Math.hypot(last.x - e1.x, last.y - e1.y) > 1) points.push(e1);
  points.push(end);
  return flattenPoints(points);
}

/**
 * Bounds connectors should route around: solid objects on the board,
 * excluding the connector itself and its attached endpoints (stubs handle those).
 */
export function collectConnectorObstacles(
  board: Board,
  zoom: number,
  excludeIds?: Iterable<string>,
): Bounds[] {
  const excluded = new Set(excludeIds ?? []);
  const out: Bounds[] = [];
  for (const element of board.elements) {
    if (excluded.has(element.id)) continue;
    if (
      element.type === "connector" ||
      element.type === "frame" ||
      element.type === "group"
    ) {
      continue;
    }
    const state = resolveState(element, zoom, board.breakpoints);
    if (!state.visible || state.opacity <= 0) continue;
    const bounds = worldBoundsAtZoom(board, element, zoom);
    if (bounds.width < 1 && bounds.height < 1) continue;
    out.push(expandBounds(bounds, ROUTE_MARGIN));
  }
  return out;
}

/** Orthogonal / straight / curved path between two world points. */
export function routeConnectorPoints(
  start: Point,
  end: Point,
  style: "straight" | "stepped" | "curved",
  startSide: Exclude<ConnectorAnchorSide, "auto">,
  endSide: Exclude<ConnectorAnchorSide, "auto">,
  obstacles: Bounds[] = [],
): RoutedConnector {
  if (style === "stepped") {
    return {
      worldPoints: routeOrthogonalAvoiding(start, end, startSide, endSide, obstacles),
      bezier: false,
    };
  }
  if (style === "curved") {
    // Route an orthogonal spine around obstacles, then soften into a cubic
    // through the spine's interior so curves also clear shapes by default.
    const spine = routeOrthogonalAvoiding(start, end, startSide, endSide, obstacles);
    if (spine.length >= 8) {
      // Use first/last and two interior control samples along the polyline.
      const pts: Point[] = [];
      for (let i = 0; i < spine.length; i += 2) pts.push({ x: spine[i], y: spine[i + 1] });
      const total = pathLength(pts);
      const p1 = pointAlongPolyline(pts, Math.min(total * 0.33, ROUTE_STUB * 3));
      const p2 = pointAlongPolyline(pts, Math.max(total * 0.67, total - ROUTE_STUB * 3));
      return {
        worldPoints: [start.x, start.y, p1.x, p1.y, p2.x, p2.y, end.x, end.y],
        bezier: true,
      };
    }
    const dist = Math.max(1, Math.hypot(end.x - start.x, end.y - start.y));
    const d = Math.min(160, Math.max(24, dist * 0.35));
    const sDir = sideDirection(startSide);
    const eDir = sideDirection(endSide);
    return {
      worldPoints: [
        start.x, start.y,
        start.x + sDir.x * d, start.y + sDir.y * d,
        end.x + eDir.x * d, end.y + eDir.y * d,
        end.x, end.y,
      ],
      bezier: true,
    };
  }
  // Straight: if the direct line clips a shape, upgrade to an avoiding stepped route.
  if (obstacles.length > 0 && pathHitsObstacles([start, end], obstacles)) {
    return {
      worldPoints: routeOrthogonalAvoiding(start, end, startSide, endSide, obstacles),
      bezier: false,
    };
  }
  return { worldPoints: [start.x, start.y, end.x, end.y], bezier: false };
}

function pointAlongPolyline(points: Point[], dist: number): Point {
  if (!points.length) return { x: 0, y: 0 };
  let left = Math.max(0, dist);
  for (let i = 0; i < points.length - 1; i += 1) {
    const seg = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    if (left <= seg || i === points.length - 2) {
      const t = seg > 0 ? Math.min(1, left / seg) : 0;
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * t,
        y: points[i].y + (points[i + 1].y - points[i].y) * t,
      };
    }
    left -= seg;
  }
  return points[points.length - 1];
}

export function connectorDashArray(dash: ConnectorLineDash | undefined, zoom: number): number[] | undefined {
  const z = Math.max(zoom, 0.001);
  if (dash === "dashed") return [10 / z, 7 / z];
  if (dash === "dotted") return [2.5 / z, 6 / z];
  return undefined;
}

export interface ConnectorWorldEndpoints {
  start: Point;
  end: Point;
  startSide: Exclude<ConnectorAnchorSide, "auto">;
  endSide: Exclude<ConnectorAnchorSide, "auto">;
  startAttached: boolean;
  endAttached: boolean;
}

/**
 * World-space endpoints for a connector.
 *
 * Floating ends are part of the connector line itself: when exactly one end
 * is attached, the floating end keeps its stored offset vector from the
 * attached end, so moving the attached shape (or the line) carries the
 * floating end along. When neither end is attached the stored absolute
 * positions are used directly.
 */
export function connectorWorldEndpoints(
  board: Board,
  connector: BoardElement,
  zoom: number,
): ConnectorWorldEndpoints | null {
  if (connector.type !== "connector") return null;
  const state = resolveState(connector, zoom, board.breakpoints);
  const parent = connector.parentId
    ? board.elements.find((element) => element.id === connector.parentId)
    : undefined;
  const parentWorld = parent ? worldPositionAtZoom(board, parent, zoom) : { x: 0, y: 0 };
  const fallbackPoints = state.connectorPoints ?? [0, 0, state.width, state.height];
  const fallbackStart: Point = {
    x: parentWorld.x + state.x + (fallbackPoints[0] ?? 0),
    y: parentWorld.y + state.y + (fallbackPoints[1] ?? 0),
  };
  const fallbackEnd: Point = {
    x: parentWorld.x + state.x + (fallbackPoints[2] ?? state.width),
    y: parentWorld.y + state.y + (fallbackPoints[3] ?? state.height),
  };

  const startElement = connector.connectorStartId
    ? board.elements.find((element) => element.id === connector.connectorStartId)
    : undefined;
  const endElement = connector.connectorEndId
    ? board.elements.find((element) => element.id === connector.connectorEndId)
    : undefined;
  const startBounds = startElement ? worldBoundsAtZoom(board, startElement, zoom) : undefined;
  const endBounds = endElement ? worldBoundsAtZoom(board, endElement, zoom) : undefined;
  const startType = startElement?.type ?? "rect";
  const endType = endElement?.type ?? "rect";

  const delta = {
    x: fallbackEnd.x - fallbackStart.x,
    y: fallbackEnd.y - fallbackStart.y,
  };
  const hasDelta = Math.hypot(delta.x, delta.y) > 1;
  const defaultDelta = { x: 120, y: 0 };

  let start: Point;
  let end: Point;
  if (startBounds && endBounds) {
    start = anchorPoint(startBounds, connector.connectorStartAnchor, center(endBounds), startType);
    end = anchorPoint(endBounds, connector.connectorEndAnchor, center(startBounds), endType);
  } else if (startBounds) {
    start = anchorPoint(startBounds, connector.connectorStartAnchor, fallbackEnd, startType);
    const d = hasDelta ? delta : defaultDelta;
    end = { x: start.x + d.x, y: start.y + d.y };
  } else if (endBounds) {
    end = anchorPoint(endBounds, connector.connectorEndAnchor, fallbackStart, endType);
    const d = hasDelta ? delta : defaultDelta;
    start = { x: end.x - d.x, y: end.y - d.y };
  } else {
    start = fallbackStart;
    end = fallbackEnd;
  }

  // Exit side must match where the point sits on the shape, not merely the
  // direction toward the other end — otherwise stubs dive back into the body.
  const startSide = startBounds
    ? sideFromCenter(center(startBounds), start, connector.connectorStartAnchor)
    : effectiveSide(connector.connectorStartAnchor, start, end);
  const endSide = endBounds
    ? sideFromCenter(center(endBounds), end, connector.connectorEndAnchor)
    : effectiveSide(connector.connectorEndAnchor, end, start);

  return {
    start,
    end,
    startSide,
    endSide,
    startAttached: Boolean(startBounds),
    endAttached: Boolean(endBounds),
  };
}

function sideFromCenter(
  origin: Point,
  edge: Point,
  anchor: ConnectorAnchor | undefined,
): Exclude<ConnectorAnchorSide, "auto"> {
  if (anchor && anchor.side !== "auto") return anchor.side;
  return inferSide(origin, edge);
}

/** Fully routed world-space path for a connector. */
export function routeConnectorWorld(
  board: Board,
  connector: BoardElement,
  zoom: number,
): (ConnectorWorldEndpoints & RoutedConnector) | null {
  const endpoints = connectorWorldEndpoints(board, connector, zoom);
  if (!endpoints) return null;
  const state = resolveState(connector, zoom, board.breakpoints);
  const exclude = [connector.id];
  if (connector.connectorStartId) exclude.push(connector.connectorStartId);
  if (connector.connectorEndId) exclude.push(connector.connectorEndId);
  const obstacles = collectConnectorObstacles(board, zoom, exclude);
  const routed = routeConnectorPoints(
    endpoints.start,
    endpoints.end,
    normalizeConnectorStyle(state.connectorStyle),
    endpoints.startSide,
    endpoints.endSide,
    obstacles,
  );
  return { ...endpoints, ...routed };
}

export function resolveConnectorState(
  board: Board,
  connector: BoardElement,
  zoom: number,
): ElementState {
  const state = resolveState(connector, zoom, board.breakpoints);
  if (connector.type !== "connector") return state;

  const routed = routeConnectorWorld(board, connector, zoom);
  // Unattached and never positioned: fall back to the stored local frame.
  if (!routed) return state;

  const parent = connector.parentId
    ? board.elements.find((element) => element.id === connector.parentId)
    : undefined;
  const parentWorld = parent ? worldPositionAtZoom(board, parent, zoom) : { x: 0, y: 0 };

  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < routed.worldPoints.length; i += 2) {
    xs.push(routed.worldPoints[i]);
    ys.push(routed.worldPoints[i + 1]);
  }
  // For curves the control points can overshoot the endpoints, so the frame
  // must contain the whole hull — endpoints stay exact via the offset below.
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  const local = routed.worldPoints.map((v, i) => (i % 2 === 0 ? v - left : v - top));

  return {
    ...state,
    x: left - parentWorld.x,
    y: top - parentWorld.y,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
    connectorPoints: local,
  };
}

/** Topmost connectable shape under a world point (connectors never attach). */
export function findAttachTargetAt(
  board: Board,
  point: Point,
  zoom: number,
  excludeIds?: Iterable<string>,
): { element: BoardElement; bounds: Bounds; anchor: ConnectorAnchor } | null {
  const excluded = new Set(excludeIds ?? []);
  // Array order is z-order: later = on top. Walk backwards for topmost hit.
  for (let i = board.elements.length - 1; i >= 0; i -= 1) {
    const element = board.elements[i];
    if (element.type === "connector") continue;
    if (excluded.has(element.id)) continue;
    const state = resolveState(element, zoom, board.breakpoints);
    if (!state.visible || state.opacity <= 0) continue;
    const bounds = worldBoundsAtZoom(board, element, zoom);
    // Broad-phase AABB, then narrow-phase against the real silhouette.
    const pad = 6 / Math.max(zoom, 0.2);
    if (
      point.x < bounds.x - pad ||
      point.x > bounds.x + bounds.width + pad ||
      point.y < bounds.y - pad ||
      point.y > bounds.y + bounds.height + pad
    ) {
      continue;
    }
    if (!pointHitsShape(element.type, bounds, point, pad)) continue;
    return {
      element,
      bounds,
      anchor: closestAnchorOnBounds(bounds, point, element.type),
    };
  }
  return null;
}

/** Point + tangent angle (radians) along a routed connector at t in 0–1. */
export function pointAlongRoutedConnector(
  worldPoints: number[],
  bezier: boolean,
  t: number,
): { point: Point; angle: number } {
  const clampedT = Math.max(0, Math.min(1, t));
  if (worldPoints.length < 4) {
    const p = { x: worldPoints[0] ?? 0, y: worldPoints[1] ?? 0 };
    return { point: p, angle: 0 };
  }
  if (bezier && worldPoints.length >= 8) {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = worldPoints;
    const mt = 1 - clampedT;
    const x =
      mt * mt * mt * x0 + 3 * mt * mt * clampedT * x1 + 3 * mt * clampedT * clampedT * x2 + clampedT * clampedT * clampedT * x3;
    const y =
      mt * mt * mt * y0 + 3 * mt * mt * clampedT * y1 + 3 * mt * clampedT * clampedT * y2 + clampedT * clampedT * clampedT * y3;
    // Derivative for the tangent.
    const dx =
      3 * mt * mt * (x1 - x0) + 6 * mt * clampedT * (x2 - x1) + 3 * clampedT * clampedT * (x3 - x2);
    const dy =
      3 * mt * mt * (y1 - y0) + 6 * mt * clampedT * (y2 - y1) + 3 * clampedT * clampedT * (y3 - y2);
    return { point: { x, y }, angle: Math.atan2(dy, dx) };
  }
  // Polyline: walk by arc length.
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i + 3 < worldPoints.length; i += 2) {
    const seg = Math.hypot(worldPoints[i + 2] - worldPoints[i], worldPoints[i + 3] - worldPoints[i + 1]);
    lengths.push(seg);
    total += seg;
  }
  if (total <= 0) {
    return { point: { x: worldPoints[0], y: worldPoints[1] }, angle: 0 };
  }
  let target = clampedT * total;
  for (let s = 0; s < lengths.length; s += 1) {
    const segLen = lengths[s];
    const x0 = worldPoints[s * 2];
    const y0 = worldPoints[s * 2 + 1];
    const x1 = worldPoints[s * 2 + 2];
    const y1 = worldPoints[s * 2 + 3];
    if (target <= segLen || s === lengths.length - 1) {
      const f = segLen > 0 ? Math.max(0, Math.min(1, target / segLen)) : 0;
      return {
        point: { x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f },
        angle: Math.atan2(y1 - y0, x1 - x0),
      };
    }
    target -= segLen;
  }
  const n = worldPoints.length;
  return {
    point: { x: worldPoints[n - 2], y: worldPoints[n - 1] },
    angle: Math.atan2(worldPoints[n - 1] - worldPoints[n - 3], worldPoints[n - 2] - worldPoints[n - 4]),
  };
}

/** Tangent angles at both ends (pointing outward from the line). */
export function connectorEndAngles(worldPoints: number[], bezier: boolean): { start: number; end: number } {
  if (worldPoints.length < 4) return { start: Math.PI, end: 0 };
  if (bezier && worldPoints.length >= 8) {
    const [x0, y0, x1, y1] = worldPoints;
    const [x2, y2, x3, y3] = worldPoints.slice(-4);
    return {
      start: Math.atan2(y0 - y1, x0 - x1),
      end: Math.atan2(y3 - y2, x3 - x2),
    };
  }
  return {
    start: Math.atan2(worldPoints[1] - worldPoints[3], worldPoints[0] - worldPoints[2]),
    end: Math.atan2(
      worldPoints[worldPoints.length - 1] - worldPoints[worldPoints.length - 3],
      worldPoints[worldPoints.length - 2] - worldPoints[worldPoints.length - 4],
    ),
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
    const regionDefault = element.regionDefaults?.[key];
    const pinned = typeof frame?.x === "number" || typeof frame?.y === "number"
      || typeof regionDefault?.x === "number" || typeof regionDefault?.y === "number";
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
