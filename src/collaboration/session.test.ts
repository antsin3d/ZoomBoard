import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STATE, type Board } from "../whiteboard/model";

const transport = vi.hoisted(() => {
  class Events {
    handlers = new Map<string, ((...args: any[]) => void)[]>();
    on(event: string, handler: (...args: any[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }
    emit(event: string, ...args: any[]) {
      this.handlers.get(event)?.forEach((handler) => handler(...args));
    }
  }
  class Connection extends Events {
    open = true;
    serialization = "raw";
    bufferSize = 0;
    dataChannel = { bufferedAmount: 0 };
    sent: Record<string, any>[] = [];
    parts: string[] = [];
    constructor(public peer: string) { super(); }
    send(value: string) {
      const frame = JSON.parse(value);
      if (frame.i === 0) this.parts = [];
      this.parts.push(frame.s);
      if (frame.i === frame.n - 1) this.sent.push(JSON.parse(this.parts.join("")));
    }
    close() {
      if (!this.open) return;
      this.open = false;
      this.emit("close");
    }
    receive(value: unknown) {
      const data = JSON.stringify(value);
      const n = Math.ceil(data.length / 2048);
      for (let i = 0; i < n; i++) this.emit("data", JSON.stringify({ v: 1, i, n, s: data.slice(i * 2048, (i + 1) * 2048) }));
    }
  }
  const peers: FakePeer[] = [];
  class FakePeer extends Events {
    id: string;
    connections: Connection[] = [];
    destroyed = false;
    constructor(id?: unknown) {
      super();
      this.id = typeof id === "string" ? id : `visitor-${peers.length}`;
      peers.push(this);
    }
    connect(id: string) {
      const conn = new Connection(id);
      this.connections.push(conn);
      return conn;
    }
    destroy() {
      this.destroyed = true;
      this.connections.forEach((conn) => conn.close());
    }
  }
  return { peers, FakePeer, Connection };
});
vi.mock("peerjs", () => ({ default: transport.FakePeer }));

import * as session from "./session";
import { useBoardStore } from "../whiteboard/store";
import { canCopyBoard, canEditBoard } from "./access";
import { createIdentity, createPatch, inviteCode, signChallenge, type HostIdentity } from "./protocol";
import { getHostIdentity, serializeBoard } from "../whiteboard/document";

const board = (): Board => ({
  breakpoints: [],
  elements: [{ id: "shape-one", type: "rect", name: "One", base: { ...DEFAULT_STATE }, keyframes: {} }],
});
const latestPeer = () => transport.peers[transport.peers.length - 1];

async function startHost() {
  await session.hostSession("My board.board");
  latestPeer().emit("open");
  return latestPeer();
}
async function authenticate(peer: InstanceType<typeof transport.FakePeer>, id = "visitor") {
  const conn = new transport.Connection(id);
  peer.emit("connection", conn);
  conn.receive({ type: "challenge", nonce: "ab".repeat(32) });
  await vi.waitFor(() => expect(conn.sent.some((m) => m.type === "proof")).toBe(true));
  conn.receive({
    type: "hello", version: 1, joinKey: session.useSessionStore.getState().invite!.joinKey,
    name: "Visitor", probe: false,
  });
  await vi.waitFor(() => expect(conn.sent.some((m) => m.type === "welcome")).toBe(true));
  return conn;
}
async function startGuest(host: HostIdentity, remote = board()) {
  await session.joinSession(inviteCode(host));
  const peer = latestPeer();
  peer.emit("open");
  const conn = peer.connections[0];
  conn.emit("open");
  const challenge = conn.sent.find((m) => m.type === "challenge")!.nonce;
  conn.receive({ type: "proof", signature: await signChallenge(host, challenge) });
  await vi.waitFor(() => expect(conn.sent.some((m) => m.type === "hello")).toBe(true));
  conn.receive({
    type: "welcome", board: remote, revision: 0, title: "Remote",
    policy: { allowDownload: false, allowEditing: false },
  });
  await vi.waitFor(() => expect(session.useSessionStore.getState().status).toBe("online"));
  return conn;
}

beforeEach(() => {
  session.leaveSession();
  transport.peers.length = 0;
  useBoardStore.getState().replaceBoard(board());
});
afterEach(() => session.leaveSession());

describe("host authorization and lifecycle", () => {
  it("does not send a board or identity secrets before authentication", async () => {
    const peer = await startHost();
    const conn = new transport.Connection("intruder");
    peer.emit("connection", conn);
    conn.receive({ type: "challenge", nonce: "cd".repeat(32) });
    await vi.waitFor(() => expect(conn.sent).toHaveLength(1));
    expect(conn.sent[0].type).toBe("proof");
    conn.receive({ type: "hello", version: 1, joinKey: "wrong", name: "Intruder" });
    expect(conn.sent.some((m) => m.type === "welcome")).toBe(false);
    expect(JSON.stringify(conn.sent)).not.toContain(session.useSessionStore.getState().invite!.joinKey);
    expect(JSON.stringify(conn.sent)).not.toContain("privateKey");
  });
  it("denies view-only mutations at the host and accepts authorized edits", async () => {
    const peer = await startHost();
    const conn = await authenticate(peer);
    const changed = board();
    changed.elements[0].base.x = 100;
    const patch = createPatch(board(), changed);
    conn.receive({ type: "edit", request: "first", patch });
    expect(useBoardStore.getState().board.elements[0].base.x).toBe(0);
    expect(conn.sent.at(-1)?.type).toBe("rejected");
    session.setSessionPolicy({ allowEditing: true });
    conn.receive({ type: "edit", request: "second", patch });
    expect(useBoardStore.getState().board.elements[0].base.x).toBe(100);
    expect(conn.sent.at(-1)?.type).toBe("ack");
    expect(conn.sent.some((m) => m.type === "update")).toBe(true);
  });
  it("authenticates presence probes without transferring the document", async () => {
    const peer = await startHost();
    const conn = new transport.Connection("probe");
    peer.emit("connection", conn);
    conn.receive({ type: "challenge", nonce: "ef".repeat(32) });
    await vi.waitFor(() => expect(conn.sent).toHaveLength(1));
    conn.receive({ type: "hello", version: 1, joinKey: session.useSessionStore.getState().invite!.joinKey, probe: true });
    expect(conn.sent.map((m) => m.type)).toEqual(["proof", "available"]);
    expect(session.useSessionStore.getState().participants).toHaveLength(1);
  });
  it("rotates the invite and disconnects existing guests", async () => {
    const peer = await startHost();
    const conn = await authenticate(peer);
    const old = session.useSessionStore.getState().invite!;
    await session.rotateSessionInvite();
    const next = session.useSessionStore.getState().invite!;
    expect(next.documentId).toBe(old.documentId);
    expect(next.joinKey).not.toBe(old.joinKey);
    expect(conn.open).toBe(false);
  });
  it("rejects repeated host starts and keeps the first room intact", async () => {
    await startHost();
    await expect(session.hostSession("Other")).rejects.toThrow("Leave");
    expect(session.useSessionStore.getState().status).toBe("online");
  });
  it("releases failed half-open admissions even when close emits no event", async () => {
    const peer = await startHost();
    for (let index = 0; index < 20; index++) {
      const conn = new transport.Connection(`failed-${index}`);
      conn.open = false;
      peer.emit("connection", conn);
      conn.emit("error", new Error("Negotiation failed"));
    }
    const conn = await authenticate(peer);
    expect(conn.sent.some((message) => message.type === "welcome")).toBe(true);
  });
  it("rejects peer-selected binary serializers before authentication", async () => {
    const peer = await startHost();
    const conn = new transport.Connection("binary-peer");
    conn.serialization = "binary";
    peer.emit("connection", conn);
    expect(conn.open).toBe(false);
    expect(conn.sent).toHaveLength(0);
  });
});

describe("guest safety", () => {
  it("refuses unsolicited inbound connections on visitor peers", async () => {
    await startGuest(await createIdentity());
    const inbound = new transport.Connection("unsolicited");
    latestPeer().emit("connection", inbound);
    expect(inbound.open).toBe(false);
    expect(session.useSessionStore.getState().status).toBe("online");
  });
  it("verifies the host before disclosing the invite token", async () => {
    const expected = await createIdentity();
    const attacker = await createIdentity();
    await session.joinSession(inviteCode(expected));
    const peer = latestPeer();
    peer.emit("open");
    const conn = peer.connections[0];
    conn.emit("open");
    const challenge = conn.sent[0].nonce;
    conn.receive({ type: "proof", signature: await signChallenge(attacker, challenge) });
    await vi.waitFor(() => expect(session.useSessionStore.getState().status).toBe("disconnected"));
    expect(conn.sent.some((m) => m.type === "hello")).toBe(false);
  });
  it("restores the original board, viewport, history and file identity after visiting", async () => {
    await startHost();
    session.leaveSession();
    useBoardStore.getState().setPan(33, 44);
    useBoardStore.getState().updateBase("shape-one", { x: 42 });
    const before = useBoardStore.getState();
    const originalIdentity = getHostIdentity();
    const originalFile = serializeBoard(before.board);
    const remote = board();
    remote.elements[0].name = "Not the local document";
    await startGuest(await createIdentity(), remote);
    expect(useBoardStore.getState().board.elements[0].name).toBe("Not the local document");
    expect(canCopyBoard()).toBe(false);
    expect(canEditBoard()).toBe(false);
    useBoardStore.getState().updateBase("shape-one", { x: 99 });
    expect(useBoardStore.getState().board.elements[0].base.x).toBe(0);
    session.leaveSession();
    expect(useBoardStore.getState().board).toEqual(before.board);
    expect(useBoardStore.getState().panX).toBe(33);
    expect(useBoardStore.getState()._past).toEqual(before._past);
    expect(getHostIdentity()).toEqual(originalIdentity);
    expect(serializeBoard(before.board)).toBe(originalFile);
    expect(canEditBoard()).toBe(true);
  });
  it("waits for an acknowledgment, rolls back rejected edits, and respects revoked permissions", async () => {
    const conn = await startGuest(await createIdentity());
    conn.receive({ type: "policy", policy: { allowEditing: true, allowDownload: true } });
    expect(canEditBoard()).toBe(true);
    useBoardStore.getState().updateBase("shape-one", { x: 25 });
    await Promise.resolve();
    expect(session.useSessionStore.getState().pending).toBe(true);
    expect(canEditBoard()).toBe(true);
    const edit = conn.sent.find((m) => m.type === "edit")!;
    expect(edit).toBeDefined();
    conn.receive({ type: "rejected", request: edit.request, board: board(), revision: 0 });
    expect(useBoardStore.getState().board.elements[0].base.x).toBe(0);
    expect(session.useSessionStore.getState().pending).toBe(false);
    conn.receive({ type: "policy", policy: { allowEditing: false, allowDownload: false } });
    expect(canEditBoard()).toBe(false);
    expect(canCopyBoard()).toBe(false);
  });
  it("rolls back unacknowledged changes when disconnected", async () => {
    const conn = await startGuest(await createIdentity());
    conn.receive({ type: "policy", policy: { allowEditing: true, allowDownload: true } });
    useBoardStore.getState().updateBase("shape-one", { x: 80 });
    await Promise.resolve();
    conn.close();
    expect(session.useSessionStore.getState().status).toBe("disconnected");
    expect(useBoardStore.getState().board.elements[0].base.x).toBe(0);
    expect(canCopyBoard()).toBe(false);
  });
  it("batches a gesture's synchronous store actions into one edit", async () => {
    const conn = await startGuest(await createIdentity());
    conn.receive({ type: "policy", policy: { allowEditing: true, allowDownload: false } });
    useBoardStore.getState().updateBase("shape-one", { x: 70 });
    useBoardStore.getState().updateBase("shape-one", { y: 90 });
    await Promise.resolve();
    const edits = conn.sent.filter((m) => m.type === "edit");
    expect(edits).toHaveLength(1);
    expect(edits[0].patch.elements[0].after.base).toMatchObject({ x: 70, y: 90 });
  });
  it("buffers ongoing typing and rebases it after the first acknowledgment", async () => {
    const conn = await startGuest(await createIdentity());
    conn.receive({ type: "policy", policy: { allowEditing: true, allowDownload: false } });
    useBoardStore.getState().updateBase("shape-one", { content: "H" });
    await Promise.resolve();
    const first = conn.sent.find((m) => m.type === "edit")!;
    useBoardStore.getState().updateBase("shape-one", { content: "Hello" });
    await Promise.resolve();
    expect(conn.sent.filter((m) => m.type === "edit")).toHaveLength(1);
    conn.receive({ type: "update", patch: first.patch, revision: 1 });
    expect(useBoardStore.getState().board.elements[0].base.content).toBe("Hello");
    conn.receive({ type: "ack", request: first.request, revision: 1 });
    await Promise.resolve();
    const edits = conn.sent.filter((m) => m.type === "edit");
    expect(edits).toHaveLength(2);
    expect(edits[1].patch.elements[0].before.base.content).toBe("H");
    expect(edits[1].patch.elements[0].after.base.content).toBe("Hello");
    conn.receive({ type: "update", patch: edits[1].patch, revision: 2 });
    conn.receive({ type: "ack", request: edits[1].request, revision: 2 });
    await Promise.resolve();
    expect(session.useSessionStore.getState().pending).toBe(false);
    expect(useBoardStore.getState().board.elements[0].base.content).toBe("Hello");
  });
});
