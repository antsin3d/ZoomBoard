import {
  BASE_KEYFRAME_ID, DEFAULT_STATE,
  type Board, type BoardElement, type Breakpoint, type ElementState,
} from "../whiteboard/model";
import { validateRegionTimeline } from "../whiteboard/regions";

export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_ELEMENTS = 10_000;
const MAX_BREAKPOINTS = 256;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const INVITE_FORMAT = "ai.univrs.whiteboard.invite";
const encoder = new TextEncoder();

export interface Invite { documentId: string; publicKey: string; joinKey: string }
export interface HostIdentity extends Invite { privateKey: JsonWebKey }

function fail(message: string): never { throw new Error(message); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected an object.");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail("Invalid object prototype.");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key) || !allowed.includes(key)) fail(`Unexpected field: ${key}`);
  }
}
function text(value: unknown, max = 1024, min = 0): string {
  if (typeof value !== "string" || value.length < min || value.length > max) fail("Invalid string.");
  return value;
}
function id(value: unknown): string {
  const result = text(value, 128, 1);
  if (UNSAFE_KEYS.has(result) || !/^[a-zA-Z0-9_-]+$/.test(result)) fail("Invalid entity ID.");
  return result;
}
function number(value: unknown, min = -1e9, max = 1e9): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail("Invalid number.");
  return value;
}
function enumValue<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) fail("Invalid enum value.");
  return value as T;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail("Invalid or oversized array.");
  return value;
}
function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) fail("Duplicate ID.");
}

/** Reject non-JSON values, unsafe keys, cycles and excessive work before parsing schemas. */
function bounded(value: unknown): void {
  let nodes = 0;
  let estimatedBytes = 0;
  const ancestors = new Set<object>();
  function walk(item: unknown, depth: number): void {
    if (++nodes > 500_000 || depth > 32) fail("Payload is too complex.");
    if (typeof item === "string") estimatedBytes += encoder.encode(item).length;
    else if (typeof item === "number") { number(item, -Number.MAX_VALUE, Number.MAX_VALUE); estimatedBytes += 24; }
    else if (item === null || typeof item === "boolean" || item === undefined) estimatedBytes += 5;
    else if (typeof item === "object") {
      if (ancestors.has(item)) fail("Cyclic payload.");
      ancestors.add(item);
      if (Array.isArray(item)) {
        if (item.length > 50_000) fail("Oversized array.");
        for (const child of item) {
          if (child === undefined) fail("Invalid array entry.");
          walk(child, depth + 1);
        }
      } else {
        for (const [key, child] of Object.entries(record(item))) {
          if (UNSAFE_KEYS.has(key)) fail("Unsafe object key.");
          estimatedBytes += encoder.encode(key).length;
          walk(child, depth + 1);
        }
      }
      ancestors.delete(item);
    } else fail("Invalid JSON value.");
    if (estimatedBytes > MAX_MESSAGE_BYTES) fail("Payload exceeds 8 MiB.");
  }
  walk(value, 0);
  if (encoder.encode(JSON.stringify(value)).length > MAX_MESSAGE_BYTES) fail("Payload exceeds 8 MiB.");
}

function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64url(value: unknown, byteLength?: number): Uint8Array<ArrayBuffer> {
  const input = text(value, 4096, 1);
  if (!/^[A-Za-z0-9_-]+$/.test(input)) fail("Invalid base64url.");
  let binary: string;
  try { binary = atob(input.replace(/-/g, "+").replace(/_/g, "/")); }
  catch { return fail("Invalid base64url."); }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  if ((byteLength !== undefined && bytes.length !== byteLength) || toBase64url(bytes) !== input) fail("Invalid base64url length or encoding.");
  return bytes;
}

export function validateInvite(value: unknown): Invite {
  const input = record(value);
  keys(input, ["documentId", "publicKey", "joinKey"]);
  const documentId = text(input.documentId, 36, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(documentId)) fail("Invalid document UUID.");
  const raw = fromBase64url(input.publicKey, 65);
  if (raw[0] !== 4) fail("Invalid P-256 public key.");
  // Validate the point synchronously, including when reading a document file.
  const integer = (bytes: Uint8Array) => BigInt(`0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`);
  const p = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
  const b = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
  const x = integer(raw.subarray(1, 33)), y = integer(raw.subarray(33));
  if (x >= p || y >= p || ((y * y - (x * x * x - 3n * x + b)) % p + p) % p !== 0n) fail("Invalid P-256 point.");
  fromBase64url(input.joinKey, 32);
  return { documentId, publicKey: input.publicKey as string, joinKey: input.joinKey as string };
}

/**
 * File-only structural validation; never pass this object to the transport.
 * Scalar/public-point consistency cannot be established by these synchronous
 * checks. document.ensureHostIdentity verifies it with WebCrypto before hosting.
 */
export function validateHostIdentity(value: unknown): HostIdentity {
  const input = record(value);
  keys(input, ["documentId", "publicKey", "joinKey", "privateKey"]);
  const invite = validateInvite({ documentId: input.documentId, publicKey: input.publicKey, joinKey: input.joinKey });
  const jwk = record(input.privateKey);
  keys(jwk, ["kty", "crv", "x", "y", "d", "ext", "key_ops", "alg"]);
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || (jwk.ext !== undefined && jwk.ext !== true)
    || (jwk.alg !== undefined && jwk.alg !== "ES256")) fail("Invalid host private key.");
  const raw = fromBase64url(invite.publicKey, 65);
  if (toBase64url(raw.subarray(1, 33)) !== jwk.x || toBase64url(raw.subarray(33)) !== jwk.y) fail("Host keypair does not match.");
  const scalar = fromBase64url(jwk.d, 32);
  const scalarHex = Array.from(scalar, (v) => v.toString(16).padStart(2, "0")).join("");
  if (BigInt(`0x${scalarHex}`) === 0n || BigInt(`0x${scalarHex}`) >= 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n) fail("Invalid private scalar.");
  if (jwk.key_ops !== undefined) {
    const operations = array(jwk.key_ops, 1);
    if (operations.length !== 1 || operations[0] !== "sign") fail("Invalid key operations.");
  }
  return { ...invite, privateKey: { kty: "EC", crv: "P-256", x: jwk.x as string, y: jwk.y as string, d: jwk.d as string, ext: true, key_ops: ["sign"] } };
}

export async function createIdentity(): Promise<HostIdentity> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    documentId: crypto.randomUUID(),
    publicKey: toBase64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    joinKey: toBase64url(crypto.getRandomValues(new Uint8Array(32))),
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
}
export function inviteCode(invite: Invite): string {
  // Pick fields explicitly: callers may supply a HostIdentity.
  const clean = validateInvite({ documentId: invite.documentId, publicKey: invite.publicKey, joinKey: invite.joinKey });
  return toBase64url(encoder.encode(JSON.stringify({ format: INVITE_FORMAT, version: 1, ...clean })));
}
export function inviteLink(invite: Invite): string { return `whiteboard://join#${inviteCode(invite)}`; }
export function parseInvite(value: string): Invite {
  let code = text(value, 8192, 1).trim();
  if (code.startsWith("whiteboard://join#")) code = code.slice("whiteboard://join#".length);
  else if (code.startsWith("#join=")) code = code.slice(6);
  else if (/^https?:\/\//.test(code)) {
    const url = new URL(code);
    if (!url.hash.startsWith("#join=")) fail("Invalid invite URL.");
    code = url.hash.slice(6);
  }
  const input = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64url(code))));
  keys(input, ["format", "version", "documentId", "publicKey", "joinKey"]);
  if (input.format !== INVITE_FORMAT || input.version !== 1) fail("Unsupported invite format.");
  return validateInvite({ documentId: input.documentId, publicKey: input.publicKey, joinKey: input.joinKey });
}
export function peerId(invite: Invite): string { return `wb-${invite.documentId}`; }
function challengeBytes(documentId: string, challenge: string): Uint8Array<ArrayBuffer> {
  // Domain separation and an unambiguous tuple. The join secret is deliberately absent.
  text(challenge, 1024, 1);
  return encoder.encode(JSON.stringify(["ai.univrs.whiteboard.challenge.v1", documentId, challenge]));
}
export async function signChallenge(identity: HostIdentity, challenge: string): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", identity.privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return toBase64url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, challengeBytes(identity.documentId, challenge))));
}
export async function verifyChallenge(invite: Invite, challenge: string, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", fromBase64url(invite.publicKey, 65), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64url(signature, 64), challengeBytes(invite.documentId, challenge));
  } catch { return false; }
}

const stateEnums: Partial<Record<keyof ElementState, readonly string[]>> = {
  fontStyle: ["normal", "bold", "italic", "bold italic"], textDecoration: ["none", "underline"],
  textAlign: ["left", "center", "right"], textVAlign: ["top", "middle", "bottom"],
  connectorStyle: ["straight", "stepped", "curved", "bezier"],
  connectorStartType: ["none", "arrow", "triangle", "diamond", "circle", "square", "bar"],
  connectorEndType: ["none", "arrow", "triangle", "diamond", "circle", "square", "bar"],
  connectorDash: ["solid", "dashed", "dotted"],
};
const imageKeys = ["imageSrc", "fillTextureSrc", "strokeTextureSrc"];
const stateKeys = [...Object.keys(DEFAULT_STATE), ...imageKeys, "connectorPoints", "textAnchorX", "textAnchorY"];
const coreStateKeys = ["x", "y", "width", "height", "rotation", "opacity", "visible", "fill", "stroke", "strokeWidth", "content", "fontSize"];
function image(value: unknown): string {
  const source = text(value, MAX_MESSAGE_BYTES);
  if (source === "") return source;
  const prefix = /^data:image\/(?:png|jpeg|gif|webp|bmp|avif);base64,/.exec(source);
  if (!prefix) fail("Images must be embedded raster data URLs.");
  const start = prefix[0].length;
  const length = source.length - start;
  if (length === 0 || length % 4 !== 0) fail("Invalid image base64 length.");
  const padding = source.endsWith("==") ? 2 : source.endsWith("=") ? 1 : 0;
  // Linear scan, constant extra memory. Repeated regex groups overflow some
  // JavaScript engines' backtracking stacks on otherwise valid multi-MiB images.
  let last = 0;
  for (let i = start; i < source.length - padding; i++) {
    const code = source.charCodeAt(i);
    last = code >= 65 && code <= 90 ? code - 65
      : code >= 97 && code <= 122 ? code - 71
      : code >= 48 && code <= 57 ? code + 4
      : code === 43 ? 62 : code === 47 ? 63 : -1;
    if (last === -1) fail("Invalid image base64 character.");
  }
  if ((padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) fail("Invalid image base64 padding.");
  return source;
}
function state(value: unknown, partial: boolean): Partial<ElementState> {
  const input = record(value);
  keys(input, stateKeys);
  if (!partial) for (const key of coreStateKeys) if (input[key] === undefined) fail(`Missing state field: ${key}`);
  const output: Record<string, unknown> = partial ? {} : { ...DEFAULT_STATE };
  for (const [key, item] of Object.entries(input)) {
    if (item === undefined) continue; // Optional fields on in-memory store objects.
    const choices = stateEnums[key as keyof ElementState];
    if (choices) output[key] = enumValue(item, choices);
    else if (imageKeys.includes(key)) output[key] = image(item);
    else if (key === "connectorPoints") {
      const points = array(item, 4096).map((point) => number(point));
      if (points.length < 4 || points.length % 2 !== 0) fail("Invalid connector points.");
      output[key] = points;
    } else if (key === "visible") {
      if (typeof item !== "boolean") fail("Invalid visibility.");
      output[key] = item;
    } else if (["opacity", "connectorLabelPosition", "textAnchorX", "textAnchorY"].includes(key)) output[key] = number(item, 0, 1);
    else if (["width", "height", "strokeWidth", "fontSize", "lineHeight", "connectorStartSize", "connectorEndSize"].includes(key)) output[key] = number(item, 0);
    else if (typeof DEFAULT_STATE[key as keyof ElementState] === "number") output[key] = number(item);
    else output[key] = text(item, key === "content" ? 100_000 : 1024);
  }
  return output as Partial<ElementState>;
}
function breakpoint(value: unknown): Breakpoint {
  const input = record(value);
  keys(input, ["id", "zoom", "name", "transition", "transitionRange", "region", "tweenIn", "tweenOut"]);
  const bpId = id(input.id);
  if (bpId === BASE_KEYFRAME_ID) fail("Reserved breakpoint ID.");
  if (input.region !== undefined && input.region !== true) fail("Invalid region flag.");
  return { id: bpId, zoom: number(input.zoom, 0.000001, 1e6), name: text(input.name),
    transition: enumValue(input.transition, ["snap", "crossfade"]),
    transitionRange: input.transitionRange === undefined ? 0 : number(input.transitionRange, 0, 100),
    ...(input.region === true ? { region: true as const } : {}),
    ...(input.tweenIn !== undefined ? { tweenIn: number(input.tweenIn, 0, 16) } : {}),
    ...(input.tweenOut !== undefined ? { tweenOut: number(input.tweenOut, 0, 16) } : {}),
  };
}
function element(value: unknown): BoardElement {
  const input = record(value);
  keys(input, ["id", "type", "name", "parentId", "connectorStartId", "connectorEndId", "connectorStartAnchor", "connectorEndAnchor", "variants", "variantAssignments", "base", "regionDefaults", "keyframes"]);
  const result: BoardElement = {
    id: id(input.id), type: enumValue(input.type, ["rect", "ellipse", "triangle", "diamond", "hexagon", "star", "text", "sticky", "frame", "connector", "image", "group"]),
    name: text(input.name), base: state(input.base, false) as ElementState, keyframes: {},
  };
  for (const key of ["parentId", "connectorStartId", "connectorEndId"] as const) {
    if (input[key] !== undefined) result[key] = id(input[key]);
  }
  for (const key of ["connectorStartAnchor", "connectorEndAnchor"] as const) {
    if (input[key] === undefined) continue;
    const anchor = record(input[key]);
    keys(anchor, ["side", "offset"]);
    result[key] = { side: enumValue(anchor.side, ["top", "bottom", "left", "right", "auto"]), offset: number(anchor.offset, 0, 1) };
  }
  const frames = record(input.keyframes);
  if (Object.keys(frames).length > MAX_BREAKPOINTS + 1) fail("Too many keyframes.");
  for (const [key, patch] of Object.entries(frames)) result.keyframes[id(key)] = state(patch, true);
  if (input.regionDefaults !== undefined) {
    const defaults = record(input.regionDefaults);
    if (Object.keys(defaults).length > MAX_BREAKPOINTS) fail("Too many region defaults.");
    result.regionDefaults = {};
    for (const [key, patch] of Object.entries(defaults)) {
      result.regionDefaults[id(key)] = state(patch, true);
    }
  }
  if (input.variants !== undefined) {
    result.variants = array(input.variants, 256).map((value) => {
      const variant = record(value);
      keys(variant, ["id", "name", "patch"]);
      return { id: id(variant.id), name: text(variant.name), patch: state(variant.patch, true) };
    });
    unique(result.variants.map((v) => v.id));
  }
  if (input.variantAssignments !== undefined) {
    const assignments = record(input.variantAssignments);
    if (Object.keys(assignments).length > MAX_BREAKPOINTS + 1) fail("Too many variant assignments.");
    result.variantAssignments = {};
    for (const [key, value] of Object.entries(assignments)) {
      const variantId = id(value);
      if (!result.variants?.some((v) => v.id === variantId)) fail("Missing assigned variant.");
      result.variantAssignments[id(key)] = variantId;
    }
  }
  return result;
}

/** Sanitized, independently owned snapshot; credentials and unknown fields are rejected. */
export function validateBoard(value: unknown): Board {
  bounded(value);
  const input = record(value);
  keys(input, ["elements", "breakpoints"]);
  const result = {
    breakpoints: array(input.breakpoints, MAX_BREAKPOINTS).map(breakpoint),
    elements: array(input.elements, MAX_ELEMENTS).map(element),
  };
  unique(result.breakpoints.map((bp) => bp.id));
  validateRegionTimeline(result.breakpoints);
  unique(result.elements.map((el) => el.id));
  const elements = new Map(result.elements.map((el) => [el.id, el]));
  for (const el of result.elements) {
    // Existing documents may retain dormant keyframes/variant assignments after
    // a breakpoint is deleted. The renderer ignores those presentation IDs.
    // Likewise, deleted connector targets deliberately use stored endpoints.
    // Preserve these harmless references so normal deletions remain shareable.
    for (const endpoint of [el.connectorStartId, el.connectorEndId]) {
      if (endpoint === el.id) fail("Invalid connector reference.");
    }
    let current = el;
    const seen = new Set([el.id]);
    while (current.parentId !== undefined) {
      if (seen.has(current.parentId)) fail("Parent cycle.");
      seen.add(current.parentId);
      if (seen.size > 64) fail("Parent nesting is too deep.");
      const parent = elements.get(current.parentId);
      if (!parent || parent.type === "connector") fail("Invalid parent reference.");
      current = parent;
    }
  }
  return result;
}

export interface EntityChange<T> { id: string; before: T | null; after: T | null }
export interface OrderChange { before: string[]; after: string[] }
export interface BoardPatch {
  elements: EntityChange<BoardElement>[];
  breakpoints: EntityChange<Breakpoint>[];
  elementOrder?: OrderChange;
  breakpointOrder?: OrderChange;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function equal(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
function diff<T extends { id: string }>(before: T[], after: T[]): EntityChange<T>[] {
  const left = new Map(before.map((entity) => [entity.id, entity]));
  const right = new Map(after.map((entity) => [entity.id, entity]));
  return [...new Set([...left.keys(), ...right.keys()])].flatMap((id) => {
    const before = left.get(id) ?? null, after = right.get(id) ?? null;
    return equal(before, after) ? [] : [{ id, before, after }];
  });
}
function orderDiff(before: { id: string }[], after: { id: string }[]): OrderChange | undefined {
  const left = before.map((v) => v.id), right = after.map((v) => v.id);
  return equal(left, right) ? undefined : { before: left, after: right };
}
export function createPatch(before: Board, after: Board): BoardPatch | null {
  const left = validateBoard(before), right = validateBoard(after);
  const patch: BoardPatch = { elements: diff(left.elements, right.elements), breakpoints: diff(left.breakpoints, right.breakpoints) };
  const elementOrder = orderDiff(left.elements, right.elements), breakpointOrder = orderDiff(left.breakpoints, right.breakpoints);
  if (elementOrder) patch.elementOrder = elementOrder;
  if (breakpointOrder) patch.breakpointOrder = breakpointOrder;
  if (!patch.elements.length && !patch.breakpoints.length && !elementOrder && !breakpointOrder) return null;
  bounded(patch);
  return patch;
}

function applyEntities<T extends { id: string }>(
  current: T[], value: unknown, orderValue: unknown, parse: (value: unknown) => T, max: number,
): T[] {
  const changes = array(value, max * 2).map((value): EntityChange<T> => {
    const input = record(value);
    keys(input, ["id", "before", "after"]);
    const change = { id: id(input.id), before: input.before === null ? null : parse(input.before), after: input.after === null ? null : parse(input.after) };
    if ((!change.before && !change.after) || (change.before && change.before.id !== change.id) || (change.after && change.after.id !== change.id)) fail("Invalid entity change.");
    return change;
  });
  unique(changes.map((change) => change.id));
  const entities = new Map(current.map((v) => [v.id, v]));
  for (const change of changes) {
    if (!equal(entities.get(change.id) ?? null, change.before)) fail(`Conflict on entity ${change.id}.`);
  }
  let order: OrderChange | undefined;
  if (orderValue !== undefined) {
    const input = record(orderValue);
    keys(input, ["before", "after"]);
    order = { before: array(input.before, max).map(id), after: array(input.after, max).map(id) };
    unique(order.before); unique(order.after);
    const left = new Set(order.before), right = new Set(order.after);
    for (const key of left) if (!right.has(key) && !changes.some((change) => change.id === key && change.before !== null && change.after === null)) fail("Order deletes without an entity change.");
    for (const key of right) if (!left.has(key) && !changes.some((change) => change.id === key && change.before === null && change.after !== null)) fail("Order inserts without an entity change.");
    for (const change of changes) {
      if ((change.before === null && (left.has(change.id) || !right.has(change.id)))
        || (change.after === null && (!left.has(change.id) || right.has(change.id)))) fail("Order and membership changes disagree.");
    }
    const beforeCommon = order.before.filter((key) => right.has(key));
    const afterCommon = order.after.filter((key) => left.has(key));
    if (!equal(beforeCommon, afterCommon)) {
      // Explicit reorder is optimistic; unrelated additions do not participate.
      const projected = current.map((v) => v.id).filter((key) => left.has(key));
      if (!equal(projected, order.before)) fail("Conflict on entity order.");
    }
  } else if (changes.some((change) => change.before === null || change.after === null)) fail("Membership changes require order information.");
  for (const change of changes) {
    if (change.after === null) entities.delete(change.id);
    else entities.set(change.id, change.after);
  }
  let ids = current.map((v) => v.id).filter((key) => entities.has(key));
  if (order) {
    const left = new Set(order.before), right = new Set(order.after);
    const desired = order.after.filter((key) => left.has(key) && entities.has(key));
    const beforeCommon = order.before.filter((key) => right.has(key));
    if (!equal(beforeCommon, order.after.filter((key) => left.has(key)))) {
      let index = 0;
      ids = ids.map((key) => left.has(key) ? desired[index++] : key);
    }
    // Insert next to surviving anchors without replacing unrelated concurrent additions.
    for (let i = 0; i < order.after.length; i++) {
      const key = order.after[i];
      if (left.has(key) || !entities.has(key)) continue;
      let insertion = -1;
      for (let j = i - 1; j >= 0; j--) {
        const anchor = ids.indexOf(order.after[j]);
        if (anchor !== -1) { insertion = anchor + 1; break; }
      }
      if (insertion === -1) {
        for (let j = i + 1; j < order.after.length; j++) {
          const anchor = ids.indexOf(order.after[j]);
          if (anchor !== -1) { insertion = anchor; break; }
        }
      }
      ids.splice(insertion === -1 ? ids.length : insertion, 0, key);
    }
  }
  if (ids.length !== entities.size || ids.length > max) fail("Invalid final entity order.");
  return ids.map((key) => entities.get(key)!);
}
export function applyPatch(current: Board, patch: unknown): Board {
  const board = validateBoard(current);
  bounded(patch);
  const input = record(patch);
  keys(input, ["elements", "breakpoints", "elementOrder", "breakpointOrder"]);
  return validateBoard({
    elements: applyEntities(board.elements, input.elements, input.elementOrder, element, MAX_ELEMENTS),
    breakpoints: applyEntities(board.breakpoints, input.breakpoints, input.breakpointOrder, breakpoint, MAX_BREAKPOINTS),
  });
}
