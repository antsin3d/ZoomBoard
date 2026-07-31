import * as Y from "yjs";
import type { Board } from "./model";

const DOCUMENT_FORMAT = "ai.univrs.whiteboard";
const DOCUMENT_VERSION = 1;
const BOARD_KEY = "board";
const DOCUMENT_MAP = "document";
const LOCAL_ORIGIN = Symbol("whiteboard-local");

let liveDoc = new Y.Doc();
let liveMap = liveDoc.getMap<string>(DOCUMENT_MAP);

interface BoardFileEnvelope {
  format: typeof DOCUMENT_FORMAT;
  version: typeof DOCUMENT_VERSION;
  yjsUpdate: string;
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

function isBoard(value: unknown): value is Board {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Board>;
  return Array.isArray(candidate.breakpoints) && Array.isArray(candidate.elements);
}

function readBoardFromMap(map: Y.Map<string>): Board {
  const boardJson = map.get(BOARD_KEY);
  if (typeof boardJson !== "string") throw new Error("The board snapshot is missing.");

  const board: unknown = JSON.parse(boardJson);
  if (!isBoard(board)) throw new Error("The board snapshot has an invalid structure.");
  return board;
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
  };

  return JSON.stringify(envelope);
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

  const nextDoc = new Y.Doc();
  try {
    Y.applyUpdate(nextDoc, base64ToBytes(file.yjsUpdate));
    const nextMap = nextDoc.getMap<string>(DOCUMENT_MAP);
    const board = readBoardFromMap(nextMap);

    liveDoc.destroy();
    liveDoc = nextDoc;
    liveMap = nextMap;
    return board;
  } catch (error) {
    nextDoc.destroy();
    if (error instanceof Error) throw error;
    throw new Error("The Whiteboard document could not be decoded.");
  }
}
