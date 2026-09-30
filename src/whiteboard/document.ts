import * as Y from "yjs";
import { DEFAULT_STATE, type Board } from "./model";
import { createIdentity, signChallenge, verifyChallenge, validateBoard, validateHostIdentity, type HostIdentity } from "../collaboration/protocol";

const DOCUMENT_FORMAT = "ai.univrs.whiteboard";
const DOCUMENT_VERSION = 1;
const BOARD_KEY = "board";
const DOCUMENT_MAP = "document";
const LOCAL_ORIGIN = Symbol("whiteboard-local");

let liveDoc = new Y.Doc();
let liveMap = liveDoc.getMap<string>(DOCUMENT_MAP);
let hostIdentity: HostIdentity | undefined;
let pendingIdentity: Promise<HostIdentity> | undefined;
let documentGeneration = 0;
let verifiedIdentity: HostIdentity | undefined;

interface BoardFileEnvelope {
  format: typeof DOCUMENT_FORMAT;
  version: typeof DOCUMENT_VERSION;
  yjsUpdate: string;
  collaboration?: HostIdentity;
}

export interface DocumentCheckpoint {
  yjsUpdate: string;
  hostIdentity?: HostIdentity;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function readBoardFromMap(map: Y.Map<string>): Board {
  const boardJson = map.get(BOARD_KEY);
  if (typeof boardJson !== "string") throw new Error("The board snapshot is missing.");

  // File compatibility is independent of the stricter, bounded network schema.
  // In particular, a local image-heavy board must still open/save offline.
  const board: unknown = JSON.parse(boardJson);
  if (!board || typeof board !== "object" ||
    !Array.isArray((board as Board).elements) || !Array.isArray((board as Board).breakpoints)) {
    throw new Error("The board snapshot has an invalid structure.");
  }
  const candidate = board as Board;
  validateFileStructure(candidate);
  return candidate;
}

/** Essential file invariants, without session size/count/depth or image policies. */
function validateFileStructure(board: Board): void {
  const invalid = (): never => { throw new Error("The board snapshot has invalid structure or parent references."); };
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const unsafe = new Set(["__proto__", "prototype", "constructor"]);
  const isId = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && !unsafe.has(value);
  // JSON has no object cycles. Walk iteratively to avoid imposing network depth
  // limits or overflowing the stack on malformed nested optional data.
  const pending: unknown[] = [board];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "number" && !Number.isFinite(value)) invalid();
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (unsafe.has(key)) invalid();
        if (child && typeof child === "object") pending.push(child);
        else if (typeof child === "number" && !Number.isFinite(child)) invalid();
      }
    }
  }
  const checkState = (value: unknown, partial: boolean): void => {
    if (!isObject(value)) return invalid();
    if (!partial) {
      for (const key of ["x", "y", "width", "height", "rotation", "opacity", "strokeWidth", "fontSize"]) {
        if (typeof value[key] !== "number") invalid();
      }
      for (const key of ["fill", "stroke", "content"]) if (typeof value[key] !== "string") invalid();
      if (typeof value.visible !== "boolean") invalid();
    }
    for (const [key, defaultValue] of Object.entries(DEFAULT_STATE)) {
      if (value[key] !== undefined && typeof value[key] !== typeof defaultValue) invalid();
    }
    for (const key of ["imageSrc", "fillTextureSrc", "strokeTextureSrc"]) {
      if (value[key] !== undefined && typeof value[key] !== "string") invalid();
    }
    for (const key of ["textAnchorX", "textAnchorY"]) {
      if (value[key] !== undefined && typeof value[key] !== "number") invalid();
    }
    if (value.connectorPoints !== undefined &&
      (!Array.isArray(value.connectorPoints) || value.connectorPoints.length < 4 ||
        value.connectorPoints.length % 2 !== 0 || value.connectorPoints.some((point) => typeof point !== "number"))) invalid();
  };
  const breakpointIds = new Set<string>();
  for (const bp of board.breakpoints) {
    if (!isObject(bp) || !isId(bp.id) || breakpointIds.has(bp.id) ||
      typeof bp.zoom !== "number" || bp.zoom <= 0 || typeof bp.name !== "string" ||
      !["snap", "crossfade"].includes(bp.transition) ||
      (bp.transitionRange !== undefined && (typeof bp.transitionRange !== "number" || bp.transitionRange < 0))) invalid();
    breakpointIds.add(bp.id);
  }
  const elements = new Map<string, Board["elements"][number]>();
  for (const el of board.elements) {
    if (!isObject(el) || !isId(el.id) || elements.has(el.id) || typeof el.name !== "string" ||
      !["rect", "ellipse", "triangle", "diamond", "hexagon", "star", "text", "sticky", "frame", "connector", "image", "group"].includes(el.type) ||
      !isObject(el.keyframes)) invalid();
    elements.set(el.id, el);
    checkState(el.base, false);
    for (const [key, frame] of Object.entries(el.keyframes)) {
      if (!isId(key)) invalid();
      checkState(frame, true); // Dormant presentation IDs are intentional.
    }
    for (const key of ["parentId", "connectorStartId", "connectorEndId"] as const) {
      if (el[key] !== undefined && (!isId(el[key]) || el[key] === el.id)) invalid();
    }
    for (const anchor of [el.connectorStartAnchor, el.connectorEndAnchor]) {
      if (anchor !== undefined && (!isObject(anchor) || !["top", "bottom", "left", "right", "auto"].includes(anchor.side) ||
        typeof anchor.offset !== "number" || anchor.offset < 0 || anchor.offset > 1)) invalid();
    }
    const variants = new Set<string>();
    if (el.variants !== undefined) {
      if (!Array.isArray(el.variants)) invalid();
      for (const variant of el.variants) {
        if (!isObject(variant) || !isId(variant.id) || variants.has(variant.id) || typeof variant.name !== "string") invalid();
        variants.add(variant.id);
        checkState(variant.patch, true);
      }
    }
    if (el.variantAssignments !== undefined) {
      if (!isObject(el.variantAssignments)) invalid();
      for (const [key, value] of Object.entries(el.variantAssignments)) {
        if (!isId(key) || !isId(value) || !variants.has(value)) invalid();
      }
    }
  }
  // Linear-time traversal; each parent chain is validated once.
  const done = new Set<string>();
  for (const element of board.elements) {
    const path = new Set<string>();
    let current = element;
    while (!done.has(current.id)) {
      if (path.has(current.id)) invalid();
      path.add(current.id);
      if (current.parentId === undefined) break;
      const parent = elements.get(current.parentId);
      if (!parent || parent.type === "connector") return invalid();
      current = parent;
    }
    for (const id of path) done.add(id);
  }
}

function replaceDocument(nextDoc: Y.Doc, identity?: HostIdentity): void {
  liveDoc.destroy();
  liveDoc = nextDoc;
  liveMap = liveDoc.getMap<string>(DOCUMENT_MAP);
  hostIdentity = identity;
  verifiedIdentity = undefined;
  pendingIdentity = undefined;
  documentGeneration++;
}

/** Return an independent copy so callers cannot mutate the stored credentials. */
export function getHostIdentity(): HostIdentity | undefined {
  return hostIdentity ? validateHostIdentity(hostIdentity) : undefined;
}

/** Generate once, including concurrent requests. Never attach keys to a different document. */
export async function ensureHostIdentity(): Promise<HostIdentity> {
  if (hostIdentity && verifiedIdentity === hostIdentity) return getHostIdentity()!;
  if (!pendingIdentity) {
    const generation = documentGeneration;
    const existing = hostIdentity;
    pendingIdentity = (async () => {
      if (!existing) return createIdentity();
      // Structural synchronous loading cannot establish d/public-point agreement.
      // Prove possession locally before hosting; do not modify the file or board.
      try {
        const challenge = `host-identity-check:${crypto.randomUUID()}`;
        const signature = await signChallenge(existing, challenge);
        if (!await verifyChallenge(existing, challenge, signature)) throw new Error("Keypair mismatch.");
      } catch {
        throw new Error("Corrupt host identity: the private key does not match its public key. Hosting is unavailable.");
      }
      return existing;
    })().then((identity) => {
      if (generation !== documentGeneration) throw new Error("The active document changed while generating its identity.");
      hostIdentity = identity;
      verifiedIdentity = identity;
      return identity;
    }).finally(() => {
      if (generation === documentGeneration) pendingIdentity = undefined;
    });
  }
  return validateHostIdentity(await pendingIdentity);
}

export async function rotateHostInvite(): Promise<HostIdentity> {
  const generation = documentGeneration;
  const identity = await ensureHostIdentity();
  if (generation !== documentGeneration) throw new Error("The active document changed while rotating its invite.");
  hostIdentity = {
    ...identity,
    joinKey: bytesToBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  };
  verifiedIdentity = hostIdentity; // Rotating the join secret does not change the proven keypair.
  return getHostIdentity()!;
}

/** Checkpoint includes empty documents and keeps file-only credentials out of Yjs. */
export function captureDocument(): DocumentCheckpoint {
  return {
    yjsUpdate: bytesToBase64(Y.encodeStateAsUpdate(liveDoc)),
    ...(hostIdentity ? { hostIdentity: getHostIdentity() } : {}),
  };
}

export function restoreDocument(checkpoint: DocumentCheckpoint): void {
  const identity = checkpoint.hostIdentity === undefined ? undefined : validateHostIdentity(checkpoint.hostIdentity);
  if (typeof checkpoint.yjsUpdate !== "string") throw new Error("Invalid document checkpoint.");
  const nextDoc = new Y.Doc();
  try {
    Y.applyUpdate(nextDoc, base64ToBytes(checkpoint.yjsUpdate));
    const nextMap = nextDoc.getMap<string>(DOCUMENT_MAP);
    if (nextMap.has(BOARD_KEY)) readBoardFromMap(nextMap);
    replaceDocument(nextDoc, identity);
  } catch (error) {
    nextDoc.destroy();
    throw error;
  }
}

/** Initialize the session's live Yjs document with a board when it is empty. */
export function initializeBoardDocument(board: Board): void {
  if (liveMap.has(BOARD_KEY)) return;
  syncBoardDocument(board);
}

/** Keep the current Zustand projection synchronized into the live Yjs document. */
export function syncBoardDocument(board: Board): void {
  const boardJson = JSON.stringify(board);
  if (liveMap.get(BOARD_KEY) === boardJson) return;
  liveDoc.transact(() => liveMap.set(BOARD_KEY, boardJson), LOCAL_ORIGIN);
}

/** Serialize the live session document into a versioned single-file envelope. */
export function serializeBoard(board: Board): string {
  syncBoardDocument(board);

  const envelope: BoardFileEnvelope = {
    format: DOCUMENT_FORMAT,
    version: DOCUMENT_VERSION,
    yjsUpdate: bytesToBase64(Y.encodeStateAsUpdate(liveDoc)),
    ...(hostIdentity ? { collaboration: getHostIdentity() } : {}),
  };

  return JSON.stringify(envelope);
}

/** A guest's saved copy is a fresh local document without the host's identity/history. */
export function serializeBoardCopy(board: Board): string {
  const snapshot = validateBoard(board);
  const doc = new Y.Doc();
  try {
    doc.getMap<string>(DOCUMENT_MAP).set(BOARD_KEY, JSON.stringify(snapshot));
    const envelope: BoardFileEnvelope = {
      format: DOCUMENT_FORMAT, version: DOCUMENT_VERSION,
      yjsUpdate: bytesToBase64(Y.encodeStateAsUpdate(doc)),
    };
    return JSON.stringify(envelope);
  } finally { doc.destroy(); }
}

/** Read and validate a .board document, returning its board snapshot. */
export function deserializeBoard(contents: string): Board {
  let envelope: unknown;
  try {
    envelope = JSON.parse(contents);
  } catch {
    throw new Error("This file is not valid JSON.");
  }

  if (!envelope || typeof envelope !== "object") {
    throw new Error("This file is not a Whiteboard document.");
  }

  const file = envelope as Partial<BoardFileEnvelope>;
  if (file.format !== DOCUMENT_FORMAT) {
    throw new Error("This file is not a Whiteboard document.");
  }
  if (file.version !== DOCUMENT_VERSION) {
    throw new Error(`Unsupported Whiteboard document version: ${String(file.version)}.`);
  }
  if (typeof file.yjsUpdate !== "string") {
    throw new Error("The Whiteboard document data is missing.");
  }

  const identity = file.collaboration === undefined ? undefined : validateHostIdentity(file.collaboration);
  const nextDoc = new Y.Doc();
  try {
    Y.applyUpdate(nextDoc, base64ToBytes(file.yjsUpdate));
    const nextMap = nextDoc.getMap<string>(DOCUMENT_MAP);
    const board = readBoardFromMap(nextMap);

    replaceDocument(nextDoc, identity);
    return board;
  } catch (error) {
    nextDoc.destroy();
    if (error instanceof Error) throw error;
    throw new Error("The Whiteboard document could not be decoded.");
  }
}
