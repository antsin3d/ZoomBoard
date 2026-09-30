import * as Y from "yjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STATE, type Board } from "./model";
import { createRegionTimeline } from "./regions";
import {
  captureDocument, deserializeBoard, ensureHostIdentity, getHostIdentity,
  initializeBoardDocument, restoreDocument, rotateHostInvite, serializeBoard,
  serializeBoardCopy, syncBoardDocument,
} from "./document";
import { createIdentity, signChallenge, verifyChallenge } from "../collaboration/protocol";

const emptyCheckpoint = captureDocument();
const board: Board = {
  breakpoints: [],
  elements: [{ id: "a", type: "rect", name: "A", base: { ...DEFAULT_STATE }, keyframes: {} }],
};
beforeEach(() => restoreDocument(emptyCheckpoint));

function decodedSnapshot(file: string): { snapshot: Board; doc: Y.Doc } {
  const envelope = JSON.parse(file);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Uint8Array.from(atob(envelope.yjsUpdate), (c) => c.charCodeAt(0)));
  return { snapshot: JSON.parse(doc.getMap<string>("document").get("board")!), doc };
}

function fileWithSnapshot(snapshot: unknown): string {
  const doc = new Y.Doc();
  try {
    doc.getMap<string>("document").set("board", JSON.stringify(snapshot));
    let binary = "";
    for (const byte of Y.encodeStateAsUpdate(doc)) binary += String.fromCharCode(byte);
    return JSON.stringify({ format: "ai.univrs.whiteboard", version: 1, yjsUpdate: btoa(binary) });
  } finally { doc.destroy(); }
}

describe("region document persistence", () => {
  const first = { ...createRegionTimeline()[0], id: "first" };
  const second = { ...first, id: "second", zoom: 1, tweenIn: 0, tweenOut: 0.5 };
  const regionBoard: Board = {
    ...board, breakpoints: [first, second],
    elements: [{
      ...board.elements[0],
      regionDefaults: { second: { fill: "#abcdef" } },
      keyframes: { first: { x: 10 }, second: { y: 20 } },
    }],
  };

  it("round trips region IDs, independent overrides and tween metadata unchanged", () => {
    expect(deserializeBoard(serializeBoard(regionBoard))).toEqual(regionBoard);
    const checkpoint = captureDocument();
    syncBoardDocument(board);
    restoreDocument(checkpoint);
    const { snapshot, doc } = decodedSnapshot(JSON.stringify({ yjsUpdate: captureDocument().yjsUpdate }));
    expect(snapshot).toEqual(regionBoard);
    doc.destroy();
    expect(deserializeBoard(serializeBoardCopy(regionBoard))).toEqual(regionBoard);
  });

  it("versions region files so old apps reject them instead of applying old semantics", () => {
    expect(JSON.parse(serializeBoard(regionBoard)).version).toBe(2);
    expect(JSON.parse(serializeBoardCopy(regionBoard)).version).toBe(2);
    expect(JSON.parse(serializeBoard(board)).version).toBe(1);
    expect(deserializeBoard(fileWithSnapshot(board))).toEqual(board);
    const unsupported = { ...JSON.parse(serializeBoard(regionBoard)), version: 3 };
    const before = captureDocument();
    expect(() => deserializeBoard(JSON.stringify(unsupported))).toThrow("Unsupported Whiteboard document version");
    expect(captureDocument()).toEqual(before);
  });

  it("preserves explicit texture clears in one region through save and guest copy", () => {
    const textured: Board = {
      ...regionBoard,
      elements: [{
        ...regionBoard.elements[0],
        base: {
          ...DEFAULT_STATE, fillTextureSrc: "data:image/png;base64,AAAA",
          strokeTextureSrc: "data:image/png;base64,AAAA",
        },
        keyframes: { second: { fillTextureSrc: "", strokeTextureSrc: "" } },
      }],
    };
    for (const contents of [serializeBoard(textured), serializeBoardCopy(textured)]) {
      const loaded = deserializeBoard(contents);
      expect(loaded.elements[0].keyframes.second).toEqual({ fillTextureSrc: "", strokeTextureSrc: "" });
      expect(loaded.elements[0].base.fillTextureSrc).toBe("data:image/png;base64,AAAA");
    }
  });

  it("does not migrate old files or add omitted optional region metadata", () => {
    const legacy: Board = {
      ...board, breakpoints: [{ id: "old", zoom: 0.5, name: "Overview", transition: "crossfade", transitionRange: 0.1 }],
    };
    expect(deserializeBoard(serializeBoard(legacy))).toEqual(legacy);
    const { tweenIn: _in, tweenOut: _out, ...withoutWidths } = first;
    const minimal = { ...board, breakpoints: [withoutWidths] };
    expect(deserializeBoard(serializeBoard(minimal))).toEqual(minimal);
  });

  it.each([
    [{ ...first, region: false }],
    [{ ...first, region: "true" }],
    [{ ...first, region: null }],
    [first, { ...second, region: undefined }],
    [{ ...first, zoom: 0.1 }],
    [{ ...first, zoom: 0.01 }],
    [first, { ...second, zoom: 8 }],
    [first, { ...second, zoom: 9 }],
    [first, second, { ...second, id: "third", zoom: 0.5 }],
    [first, { ...second, zoom: 0.05 }],
    [first, { ...second, id: first.id }],
    [{ ...first, id: "__base__" }],
    [{ ...first, tweenIn: -1 }],
    [{ ...first, tweenOut: 17 }],
    [{ ...first, tweenIn: Infinity }],
    [{ ...first, tweenOut: NaN }],
    [{ ...first, tweenIn: "0.12" }],
    [{ ...first, tweenOut: null }],
    [{ ...first, region: undefined }],
    [{ ...first, unexpected: "payload" }],
    [JSON.parse(JSON.stringify(first).replace('"region":true', '"region":true,"__proto__":{}'))],
  ])("rejects malformed region files atomically %#", (...breakpoints) => {
    syncBoardDocument(board);
    const original = captureDocument();
    const file = fileWithSnapshot({ ...board, breakpoints });
    expect(() => deserializeBoard(file)).toThrow();
    expect(captureDocument()).toEqual(original);
    expect(() => restoreDocument({ yjsUpdate: JSON.parse(file).yjsUpdate })).toThrow();
    expect(captureDocument()).toEqual(original);
  });

  it("keeps region file validation independent of session count and string limits", () => {
    const offline: Board = {
      ...board,
      breakpoints: Array.from({ length: 257 }, (_, index) => ({
        ...first, id: `r${index}`, zoom: index === 0 ? 0.05 : 0.05 * 2 ** (index / 40),
        name: "Region name".repeat(200),
      })),
    };
    expect(deserializeBoard(serializeBoard(offline))).toEqual(offline);
  });
});

describe("document identities", () => {
  it("generates lazily once across concurrent calls and survives file round trips", async () => {
    initializeBoardDocument(board);
    expect(getHostIdentity()).toBeUndefined();
    const [first, second] = await Promise.all([ensureHostIdentity(), ensureHostIdentity()]);
    expect(first).toEqual(second);
    const file = serializeBoard(board);
    expect(JSON.parse(file).collaboration).toEqual(first);
    restoreDocument(emptyCheckpoint);
    expect(deserializeBoard(file)).toEqual(board);
    expect(getHostIdentity()).toEqual(first);
    const signature = await signChallenge(getHostIdentity()!, "challenge");
    expect(await verifyChallenge(first, "challenge", signature)).toBe(true);
  });

  it("supports old files and keeps credentials out of the live Yjs snapshot", async () => {
    const oldFile = serializeBoard(board);
    expect(JSON.parse(oldFile).collaboration).toBeUndefined();
    deserializeBoard(oldFile);
    expect(getHostIdentity()).toBeUndefined();
    const identity = await ensureHostIdentity();
    const { doc, snapshot } = decodedSnapshot(serializeBoard(board));
    expect(snapshot).toEqual(board);
    expect(JSON.stringify(doc.toJSON())).not.toContain(identity.joinKey);
    expect(JSON.stringify(doc.toJSON())).not.toContain(identity.privateKey.d);
    doc.destroy();
  });

  it("rotates only the join key and does not expose mutable identity state", async () => {
    const original = await ensureHostIdentity();
    const next = await rotateHostInvite();
    expect(next.joinKey).not.toBe(original.joinKey);
    expect(next.documentId).toBe(original.documentId);
    expect(next.publicKey).toBe(original.publicKey);
    expect(next.privateKey).toEqual(original.privateKey);
    const retrieved = getHostIdentity()!;
    retrieved.joinKey = "changed";
    retrieved.privateKey.d = "changed";
    expect(getHostIdentity()).toEqual(next);
  });

  it("exports guest copies with fresh history and no mutation or identity", async () => {
    syncBoardDocument(board);
    const identity = await ensureHostIdentity();
    const checkpoint = captureDocument();
    const guest: Board = { elements: [], breakpoints: [] };
    const copy = serializeBoardCopy(guest);
    expect(JSON.parse(copy).collaboration).toBeUndefined();
    expect(copy).not.toContain(identity.joinKey);
    const { doc, snapshot } = decodedSnapshot(copy);
    expect(snapshot).toEqual(guest);
    doc.destroy();
    expect(captureDocument()).toEqual(checkpoint);
    deserializeBoard(copy);
    expect(getHostIdentity()).toBeUndefined();
    expect((await ensureHostIdentity()).documentId).not.toBe(identity.documentId);
  });

  it("restores prior local board and credentials after a guest visit, including empty checkpoints", async () => {
    syncBoardDocument(board);
    const identity = await ensureHostIdentity();
    const checkpoint = captureDocument();
    deserializeBoard(serializeBoardCopy({ elements: [], breakpoints: [] }));
    restoreDocument(checkpoint);
    expect(getHostIdentity()).toEqual(identity);
    const { doc, snapshot } = decodedSnapshot(JSON.stringify({
      yjsUpdate: captureDocument().yjsUpdate,
    }));
    expect(snapshot).toEqual(board);
    doc.destroy();
    restoreDocument(emptyCheckpoint);
    expect(getHostIdentity()).toBeUndefined();
    initializeBoardDocument(board);
    expect(deserializeBoard(serializeBoard(board))).toEqual(board);
  });

  it("keeps the active document on malformed identity, update or board", async () => {
    syncBoardDocument(board);
    await ensureHostIdentity();
    const checkpoint = captureDocument();
    const valid = JSON.parse(serializeBoard(board));
    const invalidBoardDoc = new Y.Doc();
    invalidBoardDoc.getMap<string>("document").set("board", JSON.stringify({ elements: [{}], breakpoints: [] }));
    const invalidBoardUpdate = btoa(String.fromCharCode(...Y.encodeStateAsUpdate(invalidBoardDoc)));
    invalidBoardDoc.destroy();
    for (const file of [
      "{invalid", JSON.stringify({ ...valid, version: 9 }),
      JSON.stringify({ ...valid, collaboration: {} }),
      JSON.stringify({ ...valid, yjsUpdate: "garbage" }),
      JSON.stringify({ ...valid, yjsUpdate: invalidBoardUpdate }),
      JSON.stringify({ ...valid, collaboration: { ...valid.collaboration, privateKey: { ...valid.collaboration.privateKey, d: "bad" } } }),
    ]) {
      expect(() => deserializeBoard(file)).toThrow();
      expect(captureDocument()).toEqual(checkpoint);
    }
    expect(() => restoreDocument({ yjsUpdate: "bad" })).toThrow();
    expect(captureDocument()).toEqual(checkpoint);
  });

  it("does not attach an in-flight identity to a newly opened document", async () => {
    const pending = ensureHostIdentity();
    deserializeBoard(serializeBoardCopy(board));
    await expect(pending).rejects.toThrow(/changed/);
    expect(getHostIdentity()).toBeUndefined();
    await ensureHostIdentity();
    expect(getHostIdentity()).toBeDefined();
  });

  it("does not impose collaboration payload limits on offline persistence", () => {
    const large: Board = {
      ...board,
      elements: [{ ...board.elements[0], base: { ...DEFAULT_STATE, content: "x".repeat(8 * 1024 * 1024 + 1) } }],
    };
    const saved = serializeBoard(large);
    expect(deserializeBoard(saved).elements[0].base.content.length).toBe(large.elements[0].base.content.length);
    const checkpoint = captureDocument();
    syncBoardDocument(board);
    expect(() => restoreDocument(checkpoint)).not.toThrow();
  });

  it("rejects malformed file structure atomically on load and checkpoint restoration", async () => {
    syncBoardDocument(board);
    await ensureHostIdentity();
    const original = captureDocument();
    const group = { ...board.elements[0], type: "group" as const };
    const cases: unknown[] = [
      { ...board, elements: [group, { ...group }] },
      { ...board, elements: [{ ...group, parentId: "a" }] },
      { ...board, elements: [{ ...group, parentId: "b" }, { ...group, id: "b", parentId: "a" }] },
      { ...board, elements: [{ ...group, parentId: "missing" }] },
      { ...board, elements: [{ ...group, parentId: "b" }, { ...board.elements[0], id: "b", type: "connector" }] },
      { ...board, elements: [{ ...group, base: [] }] },
      { ...board, elements: [{ ...group, base: {} }] },
      { ...board, elements: [{ ...group, keyframes: [] }] },
      { ...board, elements: [{ ...group, variants: {} }] },
      { ...board, elements: [{ ...group, type: "bogus" }] },
      { ...board, elements: [{ ...group, base: { ...DEFAULT_STATE, x: "bad" } }] },
      { ...board, breakpoints: [{ id: "bp", zoom: 1 }] },
      JSON.parse('{"elements":[],"breakpoints":[],"__proto__":{}}'),
    ];
    for (const snapshot of cases) {
      const file = fileWithSnapshot(snapshot);
      expect(() => deserializeBoard(file)).toThrow();
      expect(captureDocument()).toEqual(original);
      expect(() => restoreDocument({ yjsUpdate: JSON.parse(file).yjsUpdate })).toThrow();
      expect(captureDocument()).toEqual(original);
    }
  });

  it("allows offline entity counts beyond session limits and dormant references", () => {
    const offline: Board = {
      elements: Array.from({ length: 10_001 }, (_, index) => ({
        ...board.elements[0], id: `e${index}`, connectorEndId: "deleted",
        keyframes: { removedBreakpoint: { x: 2 } },
        variants: [{ id: "v", name: "Variant", patch: {} }],
        variantAssignments: { removedBreakpoint: "v" },
      })),
      breakpoints: Array.from({ length: 257 }, (_, index) => ({
        id: `bp${index}`, zoom: index + 1, name: "Breakpoint", transition: "snap", transitionRange: 0,
      })),
    };
    expect(deserializeBoard(serializeBoard(offline))).toEqual(offline);
    expect(() => restoreDocument(captureDocument())).not.toThrow();
  });

  it("refuses a corrupt private scalar before hosting without modifying document data", async () => {
    const identity = await createIdentity();
    const other = await createIdentity();
    const file = JSON.parse(serializeBoard(board));
    file.collaboration = { ...identity, privateKey: { ...identity.privateKey, d: other.privateKey.d } };
    expect(deserializeBoard(JSON.stringify(file))).toEqual(board); // Synchronous structural validation only.
    const checkpoint = captureDocument();
    await expect(ensureHostIdentity()).rejects.toThrow(/Corrupt host identity/);
    expect(captureDocument()).toEqual(checkpoint);
    expect(JSON.parse(serializeBoard(board)).collaboration).toEqual(file.collaboration);
    restoreDocument(checkpoint);
    await expect(ensureHostIdentity()).rejects.toThrow(/Corrupt host identity/);
    expect(captureDocument()).toEqual(checkpoint);
  });

  it("verifies loaded identities once per generation, shares concurrent verification, and trusts generated keys", async () => {
    const sign = vi.spyOn(crypto.subtle, "sign");
    try {
      await ensureHostIdentity();
      expect(sign).not.toHaveBeenCalled();
      const file = serializeBoard(board);
      deserializeBoard(file);
      await Promise.all([ensureHostIdentity(), ensureHostIdentity()]);
      expect(sign).toHaveBeenCalledTimes(1);
      await ensureHostIdentity();
      await rotateHostInvite();
      await ensureHostIdentity();
      expect(sign).toHaveBeenCalledTimes(1);
      restoreDocument(captureDocument());
      await ensureHostIdentity();
      expect(sign).toHaveBeenCalledTimes(2);
      deserializeBoard(file);
      const pending = ensureHostIdentity();
      restoreDocument(emptyCheckpoint);
      await expect(pending).rejects.toThrow(/changed/);
      expect(getHostIdentity()).toBeUndefined();
    } finally { sign.mockRestore(); }
  });
});
