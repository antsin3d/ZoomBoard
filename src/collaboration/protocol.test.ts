import { describe, expect, it } from "vitest";
import { DEFAULT_STATE, type Board, type BoardElement } from "../whiteboard/model";
import {
  MAX_MESSAGE_BYTES, applyPatch, createIdentity, createPatch, inviteCode, inviteLink,
  parseInvite, peerId, signChallenge, validateBoard, validateHostIdentity, verifyChallenge,
} from "./protocol";

function el(id: string, x = 0): BoardElement {
  return { id, type: "rect", name: id, base: { ...DEFAULT_STATE, x }, keyframes: {} };
}
function board(...elements: BoardElement[]): Board { return { elements, breakpoints: [] }; }

describe("entity patches", () => {
  it("merges independent edits and rejects conflicting edits without mutation", () => {
    const before = board(el("a"), el("b"));
    const changeA = createPatch(before, board(el("a", 20), el("b")))!;
    const changeB = createPatch(before, board(el("a"), el("b", 30)))!;
    const first = applyPatch(before, changeA);
    expect(applyPatch(first, changeB)).toEqual(board(el("a", 20), el("b", 30)));
    expect(() => applyPatch(first, changeA)).toThrow(/Conflict/);
    expect(before.elements[0].base.x).toBe(0);
  });

  it("uses deterministic key equality and ignores optional undefined properties", () => {
    const before = board(el("a"));
    const after = board({ ...el("a"), parentId: undefined, base: Object.fromEntries(Object.entries(DEFAULT_STATE).reverse()) as typeof DEFAULT_STATE });
    expect(createPatch(before, after)).toBeNull();
  });

  it("preserves unrelated concurrent insertions and deletions", () => {
    const before = board(el("a"), el("b"));
    const insert = createPatch(before, board(el("a"), el("c"), el("b")))!;
    expect(applyPatch(board(el("a"), el("d"), el("b")), insert).elements.map((v) => v.id)).toEqual(["a", "c", "d", "b"]);
    expect(applyPatch(board(el("b")), insert).elements.map((v) => v.id)).toEqual(["c", "b"]);
    const remove = createPatch(before, board(el("b")))!;
    expect(applyPatch(board(el("a"), el("c"), el("b")), remove).elements.map((v) => v.id)).toEqual(["c", "b"]);
  });

  it("makes order changes optimistic while retaining unrelated additions", () => {
    const before = board(el("a"), el("b"), el("c"));
    const reorder = createPatch(before, board(el("c"), el("a"), el("b")))!;
    expect(reorder.elements).toEqual([]);
    expect(applyPatch(board(el("a"), el("x"), el("b"), el("c")), reorder).elements.map((v) => v.id)).toEqual(["c", "x", "a", "b"]);
    expect(() => applyPatch(board(el("b"), el("a"), el("c")), reorder)).toThrow(/order/);
  });

  it("handles insertion, deletion and reorder together", () => {
    const before = board(el("a"), el("b"), el("c"));
    const after = board(el("c"), el("d"), el("a"));
    expect(applyPatch(before, createPatch(before, after))).toEqual(after);
  });

  it("diffs breakpoints independently and validates references after atomic removal", () => {
    const bp = { id: "bp", zoom: 2, name: "Detail", transition: "snap" as const, transitionRange: 0 };
    const before: Board = { breakpoints: [bp], elements: [{ ...el("a"), keyframes: { bp: { x: 5 } } }] };
    const remove = createPatch(before, board(el("a")))!;
    expect(applyPatch(before, remove)).toEqual(board(el("a")));
    const rename = createPatch(before, { ...before, breakpoints: [{ ...bp, name: "Renamed" }] })!;
    const independent = { ...before, elements: [{ ...before.elements[0], name: "Changed" }] };
    expect(applyPatch(independent, rename).elements[0].name).toBe("Changed");
    // The existing editor permits dormant presentation overrides after deletion.
    expect(applyPatch(before, { ...remove, elements: [] }).elements[0].keyframes).toEqual({ bp: { x: 5 } });
  });

  it("rejects dangling children and concurrent parent cycles", () => {
    const a = { ...el("a"), type: "group" as const }, b = { ...el("b"), type: "group" as const };
    const before = board(a, b);
    const first = createPatch(before, board({ ...a, parentId: "b" }, b))!;
    const second = createPatch(before, board(a, { ...b, parentId: "a" }))!;
    expect(() => applyPatch(applyPatch(before, first), second)).toThrow(/cycle/);
    const deleteA = createPatch(before, board(b))!;
    expect(() => applyPatch(board(a, { ...b, parentId: "a" }), deleteA)).toThrow(/parent/);
  });

  it("rejects forged membership, mismatched IDs and duplicate edits", () => {
    const before = board(el("a"));
    const patch = createPatch(before, board(el("a", 1)))!;
    expect(() => applyPatch(before, { ...patch, elements: [...patch.elements, ...patch.elements] })).toThrow(/Duplicate/);
    expect(() => applyPatch(before, { ...patch, elements: [{ ...patch.elements[0], id: "b" }] })).toThrow(/entity change/);
    expect(() => applyPatch(before, { elements: [], breakpoints: [], elementOrder: { before: ["a"], after: [] } })).toThrow();
    const insertion = createPatch(before, board(el("a"), el("b")))!;
    expect(() => applyPatch(before, { ...insertion, elementOrder: undefined })).toThrow();
  });
});

describe("snapshot validation", () => {
  it("defaults legacy presentation fields and accepts a complete model", () => {
    const legacy = el("a");
    const base = { ...legacy.base } as Partial<typeof DEFAULT_STATE>;
    delete base.connectorStyle;
    delete base.fontFamily;
    expect(validateBoard(board({ ...legacy, base: base as typeof DEFAULT_STATE })).elements[0].base).toEqual(DEFAULT_STATE);
    const rich: BoardElement = {
      ...el("rich"), type: "connector", connectorEndId: "target", connectorEndAnchor: { side: "auto", offset: 0.5 },
      base: { ...DEFAULT_STATE, connectorPoints: [0, 0, 10, 10], imageSrc: "data:image/png;base64,iVBORw0KGgo=" },
      variants: [{ id: "v", name: "Variant", patch: { fill: "#fff" } }],
      variantAssignments: { __base__: "v" },
    };
    expect(validateBoard(board(rich, el("target")))).toEqual(board(rich, el("target")));
  });

  it.each([
    { elements: [], breakpoints: [], privateKey: {} },
    board(el("a"), el("a")),
    board({ ...el("a"), parentId: "missing" }),
    board({ ...el("a"), connectorEndId: "a" }),
    board({ ...el("a"), base: { ...DEFAULT_STATE, x: NaN } }),
    board({ ...el("a"), base: { ...DEFAULT_STATE, opacity: 2 } }),
    board({ ...el("a"), base: { ...DEFAULT_STATE, visible: "yes" } } as unknown as BoardElement),
    board({ ...el("a"), base: { ...DEFAULT_STATE, fontStyle: "invalid" } } as unknown as BoardElement),
    board({ ...el("a"), base: {} } as BoardElement),
    board({ ...el("a"), variantAssignments: { __base__: "missing" } }),
    board({ ...el("a"), base: { ...DEFAULT_STATE, imageSrc: "https://example.test/a.png" } }),
    board({ ...el("a"), base: { ...DEFAULT_STATE, fillTextureSrc: "data:image/svg+xml;base64,PHN2Zy8+" } }),
  ])("rejects malformed snapshot %#", (value) => {
    expect(() => validateBoard(value)).toThrow();
  });

  it("preserves harmless dormant references used by the existing editor", () => {
    const existing = board({ ...el("a"), connectorEndId: "deleted", keyframes: { deletedBreakpoint: { x: 5 } } });
    expect(validateBoard(existing)).toEqual(existing);
  });

  it("supports Layers nesting under any non-connector element", () => {
    const nested = board(el("parent"), { ...el("child"), parentId: "parent" });
    expect(validateBoard(nested)).toEqual(nested);
    expect(() => validateBoard(board({ ...el("parent"), type: "connector" }, { ...el("child"), parentId: "parent" }))).toThrow(/parent/);
  });

  it("validates a 7 MiB base64 image without overflowing the regex stack", () => {
    const imageSrc = `data:image/png;base64,${"A".repeat(7 * 1024 * 1024)}`;
    const snapshot = board({ ...el("a"), base: { ...DEFAULT_STATE, imageSrc } });
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).length).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(validateBoard(snapshot).elements[0].base.imageSrc).toBe(imageSrc);
  });

  it.each(["", "A", "AAA", "A===", "AA=A", "AAAA====", "AA A", "AA_A", "AB==", "AAB="])(
    "rejects invalid raster base64 %j", (payload) => {
      expect(() => validateBoard(board({ ...el("a"), base: { ...DEFAULT_STATE, imageSrc: `data:image/png;base64,${payload}` } }))).toThrow();
    },
  );

  it.each(["AAAA", "AA==", "AAA=", "////", "//8="])("accepts valid raster base64 %j", (payload) => {
    expect(() => validateBoard(board({ ...el("a"), base: { ...DEFAULT_STATE, imageSrc: `data:image/png;base64,${payload}` } }))).not.toThrow();
  });

  it("rejects prototype keys, cycles, excessive counts and oversize payloads", () => {
    expect(() => validateBoard(JSON.parse('{"elements":[],"breakpoints":[],"__proto__":{}}'))).toThrow();
    expect(() => validateBoard(board(el("constructor")))).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateBoard(cyclic)).toThrow();
    expect(() => validateBoard(board(...Array.from({ length: 10_001 }, (_, i) => el(`e${i}`))))).toThrow();
    expect(() => validateBoard({ elements: [], breakpoints: [], extra: "x".repeat(MAX_MESSAGE_BYTES) })).toThrow();
    const nested = Array.from({ length: 65 }, (_, i) => ({ ...el(`e${i}`), type: "group" as const, ...(i ? { parentId: `e${i - 1}` } : {}) }));
    expect(() => validateBoard(board(...nested))).toThrow(/deep/);
  });

  it("returns a detached snapshot", () => {
    const original = board(el("a"));
    const snapshot = validateBoard(original);
    snapshot.elements[0].base.x = 10;
    expect(original.elements[0].base.x).toBe(0);
  });
});

describe("host authentication and invites", () => {
  it("round trips strict versioned invites without the private key", async () => {
    const identity = await createIdentity();
    const { privateKey, ...invite } = identity;
    expect(privateKey.kty).toBe("EC");
    expect(validateHostIdentity(identity)).toEqual(identity);
    expect(parseInvite(inviteCode(identity))).toEqual(invite);
    expect(parseInvite(inviteLink(identity))).toEqual(invite);
    expect(parseInvite(`#join=${inviteCode(identity)}`)).toEqual(invite);
    expect(parseInvite(`https://example.test/#join=${inviteCode(identity)}`)).toEqual(invite);
    expect(peerId(identity)).toBe(`wb-${identity.documentId}`);
    expect(atob(inviteCode(identity).replace(/-/g, "+").replace(/_/g, "/"))).not.toContain("privateKey");
    expect(() => validateBoard({ ...board(), collaboration: identity })).toThrow();
  });

  it("rejects bad encodings, invalid fields and unrelated keypairs", async () => {
    const identity = await createIdentity();
    const other = await createIdentity();
    const { privateKey: _, ...invite } = identity;
    for (const invalid of ["", "!", "whiteboard://other#foo", `${inviteCode(invite)}=`, btoa("{}")]) {
      expect(() => parseInvite(invalid)).toThrow();
    }
    expect(() => inviteCode({ ...invite, documentId: "not-a-uuid" })).toThrow();
    expect(() => inviteCode({ ...invite, joinKey: "short" })).toThrow();
    expect(() => inviteCode({ ...invite, publicKey: "A".repeat(87) })).toThrow();
    expect(() => validateHostIdentity({ ...identity, privateKey: other.privateKey })).toThrow();
  });

  it("signs fresh challenges bound to document identity, not the undisclosed join key", async () => {
    const identity = await createIdentity();
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const signature = await signChallenge(identity, nonce);
    expect(await verifyChallenge(identity, nonce, signature)).toBe(true);
    expect(await verifyChallenge(identity, `${nonce}changed`, signature)).toBe(false);
    expect(await verifyChallenge({ ...identity, documentId: crypto.randomUUID() }, nonce, signature)).toBe(false);
    expect(await verifyChallenge({ ...identity, joinKey: "not-disclosed" }, nonce, signature)).toBe(true);
    expect(await verifyChallenge(await createIdentity(), nonce, signature)).toBe(false);
    expect(await verifyChallenge(identity, nonce, "garbage")).toBe(false);
  });
});
