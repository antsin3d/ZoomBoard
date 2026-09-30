import Peer, { type DataConnection } from "peerjs";
import { create } from "zustand";
import { useBoardStore, type BoardStore } from "../whiteboard/store";
import {
  captureDocument, restoreDocument, ensureHostIdentity, rotateHostInvite,
  type DocumentCheckpoint,
} from "../whiteboard/document";
import type { Board } from "../whiteboard/model";
import {
  applyPatch, createPatch, parseInvite, inviteCode, peerId,
  signChallenge, verifyChallenge, validateBoard, MAX_MESSAGE_BYTES,
  type Invite, type HostIdentity,
} from "./protocol";
import { setBoardAccess, withRemoteBoard } from "./access";
import { encodeFrames, FrameReceiver } from "./framing";

export interface Presence {
  id: string;
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
  /** World-space center; independent of the participant's window dimensions. */
  viewport: { x: number; y: number; zoom: number } | null;
}
export interface Favorite {
  id: string;
  invite: Invite;
  title: string;
  lastSeenOnline?: number;
}
type Reachability = "checking" | "online" | "unreachable" | "access-denied";
interface SessionState {
  role: "idle" | "host" | "guest";
  status: "idle" | "connecting" | "online" | "disconnected";
  title: string;
  name: string;
  localId: string;
  invite: Invite | null;
  participants: Presence[];
  followingId: string | null;
  allowDownload: boolean;
  allowEditing: boolean;
  pending: boolean;
  error: string | null;
  favorites: Favorite[];
  favoriteStatuses: Record<string, Reachability>;
}
const FAVORITES_KEY = "whiteboard.favorites.v1";
const NAME_KEY = "whiteboard.collaborator-name.v1";
const MAX_GUESTS = 8;
const CONNECT_TIMEOUT = 15_000;
const COLORS = ["#2563eb", "#c026d3", "#059669", "#ea580c", "#7c3aed", "#0891b2"];
const encoder = new TextEncoder();
const receivers = new WeakMap<DataConnection, FrameReceiver>();

function readLocal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLocal(key: string, value: string): void {
  try { localStorage.setItem(key, value); }
  catch { useSessionStore.setState({ error: "Local preferences could not be saved on this device." }); }
}
function loadFavorites(): Favorite[] {
  try {
    const data: unknown = JSON.parse(readLocal(FAVORITES_KEY) ?? "[]");
    if (!Array.isArray(data)) return [];
    return data.slice(0, 50).flatMap((item) => {
      try {
        const invite = parseInvite(inviteCode(item.invite));
        if (typeof item.title !== "string") return [];
        return [{
          id: favoriteId(invite), invite, title: item.title.slice(0, 120),
          lastSeenOnline: typeof item.lastSeenOnline === "number" && Number.isFinite(item.lastSeenOnline)
            ? item.lastSeenOnline : undefined,
        }];
      } catch { return []; }
    });
  } catch { return []; }
}
function favoriteId(invite: Invite): string {
  return `${invite.documentId}:${invite.publicKey}`;
}
const localId = crypto.randomUUID();
export const useSessionStore = create<SessionState>(() => ({
  role: "idle", status: "idle", title: "", name: readLocal(NAME_KEY)?.slice(0, 48) || "Guest",
  localId, invite: null, participants: [], followingId: null,
  allowDownload: false, allowEditing: false, pending: false, error: null,
  favorites: loadFavorites(), favoriteStatuses: {},
}));
useSessionStore.subscribe((state) => {
  const guest = state.role === "guest";
  setBoardAccess(
    !guest || (state.status === "online" && state.allowEditing),
    !guest || (state.status === "online" && state.allowDownload),
  );
});

interface HostConnection {
  conn: DataConnection;
  phase: "new" | "challenged" | "authenticated";
  presence?: Presence;
  lastSeen: number;
  messageCount: number;
  byteCount: number;
  windowStart: number;
  timer: ReturnType<typeof setTimeout>;
}
let peer: Peer | null = null;
let hostConnection: DataConnection | null = null;
let identity: HostIdentity | null = null;
const connections = new Map<string, HostConnection>();
let generation = 0;
let revision = 0;
let authoritativeBoard: Board | null = null;
let applying = false;
let backup: { state: BoardStore; document: DocumentCheckpoint } | null = null;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let connectionTimer: ReturnType<typeof setTimeout> | undefined;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let presenceTimer: ReturnType<typeof setTimeout> | undefined;
let pendingRequest: string | null = null;
let pendingTarget: Board | null = null;
let guestFlushScheduled = false;
let guestLastSeen = 0;
let ownCursor: Presence["cursor"] = null;
let ownViewport: Presence["viewport"] = null;

function createPeer(id?: string): Peer {
  // PeerJS cloud is signaling only. Explicit STUN-only configuration: no
  // implicit relay, credentials, or billing; some networks will not connect.
  const options = { debug: 0 as const, config: {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  } };
  const current = id ? new Peer(id, options) : new Peer(options);
  current.on("connection", (conn) => {
    // Guests and reachability probes never accept inbound sessions. Also reject
    // unsupported serializers before PeerJS can start assembling their payloads.
    if (conn.serialization !== "raw" || current !== peer || useSessionStore.getState().role !== "host") conn.close();
  });
  return current;
}
function publicInvite(value: HostIdentity): Invite {
  return { documentId: value.documentId, publicKey: value.publicKey, joinKey: value.joinKey };
}
function colorFor(id: string): string {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}
function ownPresence(): Presence {
  const state = useSessionStore.getState();
  return {
    id: state.role === "host" ? "host" : peer?.id ?? localId,
    name: state.name, color: colorFor(state.role === "host" ? "host" : peer?.id ?? localId),
    cursor: ownCursor, viewport: ownViewport,
  };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid message.");
  return value as Record<string, unknown>;
}
function decode(raw: unknown, conn: DataConnection, maxBytes = MAX_MESSAGE_BYTES): Record<string, unknown> | null {
  let receiver = receivers.get(conn);
  if (!receiver) {
    receiver = new FrameReceiver();
    receivers.set(conn, receiver);
  }
  const complete = receiver.push(raw, maxBytes);
  return complete === null ? null : record(JSON.parse(complete));
}
function send(conn: DataConnection, message: unknown): boolean {
  if (!conn.open) return false;
  try {
    const raw = JSON.stringify(message);
    if (encoder.encode(raw).length > MAX_MESSAGE_BYTES) throw new Error("Board is too large for this preview (8 MiB per message).");
    // Close slow consumers instead of accumulating unbounded image/board data.
    for (const frame of encodeFrames(raw)) {
      const queued = "bufferSize" in conn && typeof conn.bufferSize === "number" ? conn.bufferSize : 0;
      if (queued > 4096 || (conn.dataChannel?.bufferedAmount ?? 0) > MAX_MESSAGE_BYTES * 2) {
        conn.close();
        return false;
      }
      conn.send(frame);
    }
    return true;
  } catch (error) {
    useSessionStore.setState({ error: error instanceof Error ? error.message : "Could not send a session update." });
    conn.close();
    return false;
  }
}
function broadcast(message: unknown): void {
  for (const entry of connections.values()) {
    if (entry.phase === "authenticated") send(entry.conn, message);
  }
}
function policy() {
  const { allowDownload, allowEditing } = useSessionStore.getState();
  return { allowDownload, allowEditing };
}
function readPolicy(value: unknown): { allowDownload: boolean; allowEditing: boolean } {
  const candidate = record(value);
  if (typeof candidate.allowDownload !== "boolean" || typeof candidate.allowEditing !== "boolean") {
    throw new Error("Invalid session policy.");
  }
  return { allowDownload: candidate.allowDownload, allowEditing: candidate.allowEditing };
}
function point(value: unknown): { x: number; y: number } | null {
  if (value === null) return null;
  const p = record(value);
  if (typeof p.x !== "number" || typeof p.y !== "number" ||
    !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 1e9 || Math.abs(p.y) > 1e9) {
    throw new Error("Invalid cursor.");
  }
  return { x: p.x, y: p.y };
}
function readPresence(value: unknown, id: string): Presence {
  const p = record(value);
  if (typeof p.name !== "string") throw new Error("Invalid participant.");
  const center = point(p.viewport);
  const zoom = center ? record(p.viewport).zoom : null;
  if (center && (typeof zoom !== "number" || !Number.isFinite(zoom) || zoom < 0.05 || zoom > 8)) {
    throw new Error("Invalid viewport.");
  }
  return {
    id, color: colorFor(id), name: p.name.trim().slice(0, 48) || "Guest",
    cursor: point(p.cursor), viewport: center ? { ...center, zoom: zoom as number } : null,
  };
}
function publishRoster(): void {
  const participants = [ownPresence(), ...Array.from(connections.values())
    .flatMap((entry) => entry.presence ? [entry.presence] : [])];
  useSessionStore.setState({ participants });
  broadcast({ type: "presence", participants });
}
function replaceProjection(board: Board): void {
  applying = true;
  try {
    withRemoteBoard(() => {
      const selectedIds = useBoardStore.getState().selectedIds.filter((id) => board.elements.some((el) => el.id === id));
      useBoardStore.getState().replaceBoard(board);
      useBoardStore.getState().setSelectedIds(selectedIds);
    });
  }
  finally { applying = false; }
}
function clearPending(): void {
  clearTimeout(pendingTimer);
  pendingRequest = null;
  pendingTarget = null;
  guestFlushScheduled = false;
  useSessionStore.setState({ pending: false });
}
function stopTransport(): void {
  clearInterval(heartbeat);
  clearTimeout(connectionTimer);
  clearTimeout(pendingTimer);
  clearTimeout(presenceTimer);
  heartbeat = undefined;
  connectionTimer = undefined;
  pendingTimer = undefined;
  presenceTimer = undefined;
  for (const entry of connections.values()) clearTimeout(entry.timer);
  for (const entry of connections.values()) receivers.delete(entry.conn);
  connections.clear();
  const current = peer;
  peer = null;
  if (hostConnection) receivers.delete(hostConnection);
  hostConnection = null;
  current?.destroy();
  pendingRequest = null;
  pendingTarget = null;
  guestFlushScheduled = false;
}
function disconnect(message: string): void {
  generation += 1;
  stopTransport();
  // Roll back an unacknowledged edit; never pretend it was saved by the host.
  if (useSessionStore.getState().role === "guest" && authoritativeBoard) replaceProjection(authoritativeBoard);
  useSessionStore.setState({
    status: "disconnected", error: message, participants: [],
    followingId: null, pending: false,
  });
}
export function leaveSession(): void {
  generation += 1;
  stopTransport();
  if (backup) {
    const saved = backup;
    backup = null;
    applying = true;
    try {
      withRemoteBoard(() => useBoardStore.setState(saved.state));
      restoreDocument(saved.document);
    } finally { applying = false; }
  }
  identity = null;
  authoritativeBoard = null;
  ownCursor = null;
  useSessionStore.setState({
    role: "idle", status: "idle", title: "", invite: null, participants: [],
    followingId: null, allowDownload: false, allowEditing: false, pending: false, error: null,
    localId,
  });
}
function begin(role: "host" | "guest"): number {
  if (useSessionStore.getState().role !== "idle") throw new Error("Leave the current session first.");
  generation += 1;
  revision = 0;
  useSessionStore.setState({
    role, status: "connecting", error: null, followingId: null, participants: [],
    allowDownload: false, allowEditing: false, pending: false,
  });
  return generation;
}
function attachPeerErrors(current: Peer, token: number): void {
  current.on("error", (error) => {
    if (token !== generation) return;
    // Individual failed guest connections must not terminate the host's room.
    if (useSessionStore.getState().role === "host" && error.type === "peer-unavailable") return;
    const text = error.type === "unavailable-id"
      ? "This document's address is already in use. Close its other sharing session and retry."
      : error.type === "peer-unavailable"
        ? "Host is unreachable. It may be offline, or this network may require a relay."
        : "Connection failed. Public signaling or your network may be unavailable. Leave and retry.";
    disconnect(text);
  });
  current.on("disconnected", () => {
    if (token === generation) disconnect("Signaling disconnected. Leave and restart the session to become reachable again.");
  });
}

export async function hostSession(title: string): Promise<void> {
  const token = begin("host");
  try {
    authoritativeBoard = validateBoard(useBoardStore.getState().board);
    if (encoder.encode(JSON.stringify(authoritativeBoard)).length > MAX_MESSAGE_BYTES - 8192) {
      throw new Error("This board is too large for the collaboration preview (8 MiB).");
    }
    const nextIdentity = await ensureHostIdentity();
    if (token !== generation) return;
    identity = nextIdentity;
    useSessionStore.setState({
      title: title.replace(/\.board$/i, "").slice(0, 120) || "Untitled",
      invite: publicInvite(identity), localId: "host",
    });
    const current = createPeer(peerId(identity));
    peer = current;
    attachPeerErrors(current, token);
    connectionTimer = setTimeout(() => {
      if (token === generation) disconnect("Could not reach public signaling. Leave and retry.");
    }, CONNECT_TIMEOUT);
    current.on("open", () => {
      if (token !== generation) return;
      clearTimeout(connectionTimer);
      useSessionStore.setState({ status: "online" });
      publishRoster();
      heartbeat = setInterval(() => {
        for (const entry of connections.values()) {
          if (Date.now() - entry.lastSeen > 20_000) entry.conn.close();
          else if (entry.phase === "authenticated") send(entry.conn, { type: "ping" });
        }
      }, 5_000);
    });
    current.on("connection", (conn) => acceptConnection(conn, token));
  } catch (error) {
    if (token === generation) disconnect(error instanceof Error ? error.message : "Could not start sharing.");
  }
}

function acceptConnection(conn: DataConnection, token: number): void {
  // Reject non-raw serializers before the channel opens: PeerJS's binary
  // serializer otherwise allocates unbounded chunks before our data callback.
  if (conn.serialization !== "raw" || token !== generation || connections.size >= MAX_GUESTS + 8 || connections.has(conn.peer)) {
    conn.close();
    return;
  }
  const cleanup = () => {
    clearTimeout(entry.timer);
    receivers.delete(conn);
    if (connections.get(conn.peer) !== entry) return;
    connections.delete(conn.peer);
    conn.close();
    if (token === generation) {
      if (useSessionStore.getState().followingId === conn.peer) followPeer(null);
      publishRoster();
    }
  };
  const entry: HostConnection = {
    conn, phase: "new", lastSeen: Date.now(), messageCount: 0, byteCount: 0, windowStart: Date.now(),
    timer: setTimeout(cleanup, CONNECT_TIMEOUT),
  };
  connections.set(conn.peer, entry);
  conn.on("close", cleanup);
  conn.on("error", cleanup);
  conn.on("data", (raw) => {
    void handleHostMessage(entry, raw, token).catch(cleanup);
  });
}
async function handleHostMessage(entry: HostConnection, raw: unknown, token: number): Promise<void> {
  if (token !== generation || !identity) return;
  const { conn } = entry;
  if (Date.now() - entry.windowStart > 1000) {
    entry.windowStart = Date.now();
    entry.messageCount = 0;
    entry.byteCount = 0;
  }
  if (typeof raw !== "string" || raw.length > 16 * 1024) throw new Error("Invalid frame.");
  entry.byteCount += encoder.encode(raw).length;
  if (entry.byteCount > MAX_MESSAGE_BYTES * 3) throw new Error("Message byte rate exceeded.");
  const message = decode(raw, conn, entry.phase === "authenticated" ? MAX_MESSAGE_BYTES : 4096);
  if (!message) return;
  if (++entry.messageCount > 80) throw new Error("Message rate exceeded.");
  entry.lastSeen = Date.now();
  if (message.type === "challenge" && entry.phase === "new") {
    if (typeof message.nonce !== "string" || !/^[a-f0-9]{64}$/.test(message.nonce)) throw new Error("Invalid challenge.");
    entry.phase = "challenged";
    const signature = await signChallenge(identity, message.nonce);
    if (token === generation && conn.open) send(conn, { type: "proof", signature });
    return;
  }
  if (message.type === "hello" && entry.phase === "challenged") {
    if (message.version !== 1 || message.joinKey !== identity.joinKey) {
      send(conn, { type: "denied" });
      setTimeout(() => conn.close(), 200);
      return;
    }
    if (message.probe === true) {
      send(conn, { type: "available", title: useSessionStore.getState().title });
      setTimeout(() => conn.close(), 200);
      return;
    }
    if ([...connections.values()].filter((c) => c.phase === "authenticated").length >= MAX_GUESTS) {
      send(conn, { type: "full" });
      setTimeout(() => conn.close(), 200);
      return;
    }
    if (typeof message.name !== "string") throw new Error("Invalid name.");
    clearTimeout(entry.timer);
    entry.phase = "authenticated";
    entry.presence = {
      id: conn.peer, name: message.name.trim().slice(0, 48) || "Guest",
      color: colorFor(conn.peer), cursor: null, viewport: null,
    };
    send(conn, {
      type: "welcome", board: useBoardStore.getState().board, revision, policy: policy(),
      title: useSessionStore.getState().title,
    });
    publishRoster();
    return;
  }
  if (entry.phase !== "authenticated") throw new Error("Join required.");
  if (message.type === "pong") return;
  if (message.type === "presence") {
    entry.presence = readPresence(message.presence, conn.peer);
    publishRoster();
    return;
  }
  if (message.type === "edit") {
    if (typeof message.request !== "string" || message.request.length > 64) throw new Error("Invalid edit.");
    try {
      if (!useSessionStore.getState().allowEditing) throw new Error("The host has disabled guest editing.");
      const nextBoard = applyPatch(useBoardStore.getState().board, message.patch);
      const patch = createPatch(useBoardStore.getState().board, nextBoard);
      replaceProjection(nextBoard);
      authoritativeBoard = nextBoard;
      if (patch) {
        revision += 1;
        broadcast({ type: "update", patch, revision });
      }
      send(conn, { type: "ack", request: message.request, revision });
    } catch {
      send(conn, {
        type: "rejected", request: message.request, revision,
        board: useBoardStore.getState().board,
        reason: "Edit not applied: permissions changed or this object was edited elsewhere. Try again.",
      });
    }
    return;
  }
  throw new Error("Unsupported session message.");
}

function nonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function joinSession(value: string): Promise<void> {
  const invite = parseInvite(value);
  // Preserve the local file, viewport, undo history, and host credentials. A
  // visited board never becomes the document saved to the original file path.
  if (useSessionStore.getState().role !== "idle") throw new Error("Leave the current session first.");
  backup = { state: useBoardStore.getState(), document: captureDocument() };
  const token = begin("guest");
  useSessionStore.setState({ invite, title: "Connecting…" });
  try {
    const current = createPeer();
    peer = current;
    attachPeerErrors(current, token);
    connectionTimer = setTimeout(() => {
      if (token === generation) disconnect("Host unreachable. It may be offline, or your network may need a TURN relay.");
    }, CONNECT_TIMEOUT);
    current.on("open", () => {
      if (token !== generation) return;
      useSessionStore.setState({ localId: current.id });
      const conn = current.connect(peerId(invite), { reliable: true, serialization: "raw" });
      hostConnection = conn;
      const challenge = nonce();
      let verified = false;
      let proofReceived = false;
      conn.on("open", () => send(conn, { type: "challenge", nonce: challenge }));
      conn.on("close", () => {
        if (token === generation) disconnect("The host connection ended. Leave to return to your local board.");
      });
      conn.on("error", () => {
        if (token === generation) disconnect("Host connection failed.");
      });
      conn.on("data", (raw) => {
        void (async () => {
          if (token !== generation) return;
          const message = decode(raw, conn, verified ? MAX_MESSAGE_BYTES : 4096);
          if (!message) return;
          if (message.type === "proof" && !proofReceived) {
            proofReceived = true;
            if (typeof message.signature !== "string" || !await verifyChallenge(invite, challenge, message.signature)) {
              throw new Error("Host identity could not be verified. Do not use this connection.");
            }
            if (token !== generation) return;
            verified = true;
            send(conn, {
              type: "hello", version: 1, joinKey: invite.joinKey, probe: false,
              name: useSessionStore.getState().name,
            });
            return;
          }
          if (!verified) throw new Error("Unverified host.");
          guestLastSeen = Date.now();
          handleGuestMessage(message);
        })().catch((error) => {
          if (token === generation) disconnect(error instanceof Error ? error.message : "Invalid host message.");
        });
      });
    });
  } catch (error) {
    if (token === generation) disconnect(error instanceof Error ? error.message : "Could not join.");
  }
}
function readRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid revision.");
  return value;
}
function handleGuestMessage(message: Record<string, unknown>): void {
  const state = useSessionStore.getState();
  if (message.type === "denied") throw new Error("Invite revoked or invalid. Ask the host for a new invite.");
  if (message.type === "full") throw new Error("The session is full (eight guests maximum in this preview).");
  if (message.type === "welcome" && state.status === "connecting") {
    const board = validateBoard(message.board);
    const permissions = readPolicy(message.policy);
    if (typeof message.title !== "string") throw new Error("Invalid board title.");
    revision = readRevision(message.revision);
    authoritativeBoard = board;
    replaceProjection(board);
    clearTimeout(connectionTimer);
    useSessionStore.setState({
      status: "online", title: message.title.slice(0, 120), ...permissions, error: null,
    });
    heartbeat = setInterval(() => {
      if (Date.now() - guestLastSeen > 20_000) disconnect("Host stopped responding. Unacknowledged edits were not saved.");
    }, 5_000);
    schedulePresence();
    return;
  }
  if (state.status !== "online") throw new Error("Session is not ready.");
  switch (message.type) {
    case "ping":
      if (hostConnection) send(hostConnection, { type: "pong" });
      return;
    case "policy":
      useSessionStore.setState(readPolicy(message.policy));
      return;
    case "presence": {
      if (!Array.isArray(message.participants) || message.participants.length > MAX_GUESTS + 1) throw new Error("Invalid participants.");
      const participants = message.participants.map((value) => {
        const p = record(value);
        if (typeof p.id !== "string" || p.id.length > 128) throw new Error("Invalid participant ID.");
        return readPresence(p, p.id);
      });
      useSessionStore.setState({
        participants,
        followingId: participants.some((p) => p.id === state.followingId) ? state.followingId : null,
      });
      return;
    }
    case "update": {
      if (!authoritativeBoard || readRevision(message.revision) !== revision + 1) throw new Error("Board sync was interrupted. Leave and rejoin.");
      authoritativeBoard = applyPatch(authoritativeBoard, message.patch);
      revision += 1;
      // Keep ongoing local typing/gestures until our outstanding edit is
      // acknowledged, then rebase their remaining changes onto the host state.
      if (!pendingRequest) replaceProjection(authoritativeBoard);
      return;
    }
    case "ack": {
      if (message.request !== pendingRequest || readRevision(message.revision) !== revision) throw new Error("Unexpected edit acknowledgment.");
      if (!authoritativeBoard || !pendingTarget) throw new Error("Missing pending edit.");
      let nextProjection = authoritativeBoard;
      try {
        const queued = createPatch(pendingTarget, useBoardStore.getState().board);
        if (queued) {
          if (!state.allowEditing) throw new Error("Guest editing was disabled.");
          nextProjection = applyPatch(authoritativeBoard, queued);
        }
      } catch {
        useSessionStore.setState({ error: "Some newer local edits conflicted with host changes or permissions and were not applied. Please retry." });
      }
      replaceProjection(nextProjection);
      clearPending();
      scheduleGuestEdit();
      return;
    }
    case "rejected":
      if (message.request !== pendingRequest) throw new Error("Unexpected rejected edit.");
      authoritativeBoard = validateBoard(message.board);
      revision = readRevision(message.revision);
      replaceProjection(authoritativeBoard);
      clearPending();
      useSessionStore.setState({ error: "Your last edit was not applied: the object changed elsewhere or editing was disabled. Try again." });
      return;
    default:
      throw new Error("Unsupported host message.");
  }
}

useBoardStore.subscribe((state, previous) => {
  if (applying || state.board === previous.board) return;
  const session = useSessionStore.getState();
  if (session.role === "idle" || session.status !== "online") return;
  try {
    if (session.role === "host") {
      const patch = createPatch(previous.board, state.board);
      if (!patch) return;
      // A board must remain joinable, not just have individually small patches.
      validateBoard(state.board);
      if (encoder.encode(JSON.stringify(state.board)).length > MAX_MESSAGE_BYTES - 8192) {
        disconnect("Board exceeded the 8 MiB session limit. Local changes are intact; sharing has stopped.");
        return;
      }
      authoritativeBoard = state.board;
      revision += 1;
      broadcast({ type: "update", patch, revision });
    } else if (authoritativeBoard && hostConnection && session.allowEditing && !session.pending) {
      scheduleGuestEdit();
    }
  } catch {
    if (session.role === "guest" && authoritativeBoard) replaceProjection(authoritativeBoard);
    else disconnect("This edit cannot be shared safely. Local changes are intact; sharing has stopped.");
    useSessionStore.setState({ error: "Edit could not be shared. Check the board size and supported image formats." });
  }
});

function scheduleGuestEdit(): void {
  if (guestFlushScheduled || pendingRequest) return;
  guestFlushScheduled = true;
  const token = generation;
  // Batch a gesture's synchronous store actions (move + reparent, multi-select).
  queueMicrotask(() => {
    if (token !== generation) return;
    guestFlushScheduled = false;
    const session = useSessionStore.getState();
    if (!authoritativeBoard || !hostConnection || session.status !== "online" || !session.allowEditing) return;
    try {
      const target = useBoardStore.getState().board;
      const patch = createPatch(authoritativeBoard, target);
      if (!patch) return;
      pendingTarget = target;
      pendingRequest = crypto.randomUUID();
      useSessionStore.setState({ pending: true });
      send(hostConnection, { type: "edit", request: pendingRequest, patch });
      if (token === generation) {
        pendingTimer = setTimeout(() => disconnect("The host did not acknowledge your edits. Unconfirmed changes were rolled back locally."), CONNECT_TIMEOUT);
      }
    } catch {
      replaceProjection(authoritativeBoard);
      clearPending();
      useSessionStore.setState({ error: "Edits could not be shared. Check the board size and supported image formats." });
    }
  });
}

export function setSessionPolicy(next: { allowDownload?: boolean; allowEditing?: boolean }): void {
  if (useSessionStore.getState().role !== "host") return;
  useSessionStore.setState(next);
  broadcast({ type: "policy", policy: policy() });
}
export function kickPeer(id: string): void {
  if (useSessionStore.getState().role !== "host") return;
  // A bearer invite permits rejoining. Rotate the invite to revoke access.
  connections.get(id)?.conn.close();
}
export async function rotateSessionInvite(): Promise<void> {
  if (useSessionStore.getState().role !== "host") return;
  const token = generation;
  const next = await rotateHostInvite();
  if (token !== generation) return;
  identity = next;
  useSessionStore.setState({ invite: publicInvite(next) });
  for (const entry of connections.values()) entry.conn.close();
}
export function setDisplayName(value: string): void {
  const name = value.trim().slice(0, 48) || "Guest";
  useSessionStore.setState({ name });
  writeLocal(NAME_KEY, name);
  schedulePresence();
}
export function followPeer(id: string | null): void {
  if (id === useSessionStore.getState().localId) return;
  useSessionStore.setState({ followingId: id });
}
function schedulePresence(): void {
  if (presenceTimer || useSessionStore.getState().status !== "online") return;
  presenceTimer = setTimeout(() => {
    presenceTimer = undefined;
    const state = useSessionStore.getState();
    if (state.status !== "online") return;
    if (state.role === "host") publishRoster();
    else if (hostConnection) send(hostConnection, { type: "presence", presence: ownPresence() });
  }, 60);
}
export function publishCursor(cursor: Presence["cursor"]): void {
  ownCursor = cursor;
  schedulePresence();
}
export function publishViewport(viewport: NonNullable<Presence["viewport"]>): void {
  ownViewport = viewport;
  // Do not echo a followed viewport: otherwise A-following-B-following-A
  // can oscillate indefinitely with different window sizes/zoom clamps.
  if (!useSessionStore.getState().followingId) schedulePresence();
}
export function favoriteSession(): void {
  const state = useSessionStore.getState();
  if (!state.invite || state.status !== "online") return;
  const id = favoriteId(state.invite);
  const favorite: Favorite = { id, invite: state.invite, title: state.title, lastSeenOnline: Date.now() };
  const favorites = [favorite, ...state.favorites.filter((f) => f.id !== id)].slice(0, 50);
  useSessionStore.setState({ favorites });
  writeLocal(FAVORITES_KEY, JSON.stringify(favorites));
}
export function removeFavorite(id: string): void {
  const favorites = useSessionStore.getState().favorites.filter((f) => f.id !== id);
  useSessionStore.setState({ favorites });
  writeLocal(FAVORITES_KEY, JSON.stringify(favorites));
}

let refreshing = false;
export async function refreshFavorites(): Promise<void> {
  if (refreshing) return;
  const favorites = useSessionStore.getState().favorites;
  if (!favorites.length) return;
  refreshing = true;
  useSessionStore.setState({ favoriteStatuses: Object.fromEntries(favorites.map((f) => [f.id, "checking"])) });
  let probePeer: Peer | null = null;
  try {
    probePeer = createPeer();
    const current = probePeer;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Signaling timeout.")), 8000);
      current.on("open", () => { clearTimeout(timer); resolve(); });
      current.on("error", () => { clearTimeout(timer); reject(new Error("Signaling unavailable.")); });
    });
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(3, favorites.length) }, async () => {
      while (index < favorites.length) {
        const favorite = favorites[index++];
        const result = await probeFavorite(current, favorite.invite);
        const state = useSessionStore.getState();
        // Don't resurrect favorites deleted during an in-flight check.
        const updated = state.favorites.map((f) => f.id === favorite.id && result === "online"
          ? { ...f, lastSeenOnline: Date.now() } : f);
        useSessionStore.setState({
          favorites: updated, favoriteStatuses: { ...state.favoriteStatuses, [favorite.id]: result },
        });
      }
    }));
    writeLocal(FAVORITES_KEY, JSON.stringify(useSessionStore.getState().favorites));
  } catch {
    const state = useSessionStore.getState();
    useSessionStore.setState({ favoriteStatuses: Object.fromEntries(
      Object.entries(state.favoriteStatuses).map(([id, status]) => [id, status === "checking" ? "unreachable" : status]),
    ) });
  } finally {
    probePeer?.destroy();
    refreshing = false;
  }
}
function probeFavorite(current: Peer, invite: Invite): Promise<Reachability> {
  return new Promise((resolve) => {
    const conn = current.connect(peerId(invite), { reliable: true, serialization: "raw" });
    const challenge = nonce();
    let done = false;
    let verified = false;
    let proofReceived = false;
    const finish = (status: Reachability) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      receivers.delete(conn);
      conn.close();
      resolve(status);
    };
    const timer = setTimeout(() => finish("unreachable"), 8000);
    conn.on("open", () => send(conn, { type: "challenge", nonce: challenge }));
    conn.on("close", () => finish("unreachable"));
    conn.on("error", () => finish("unreachable"));
    conn.on("data", (raw) => {
      void (async () => {
        if (done) return;
        const message = decode(raw, conn, 4096);
        if (!message) return;
        if (message.type === "proof" && !proofReceived) {
          proofReceived = true;
          if (typeof message.signature !== "string" || !await verifyChallenge(invite, challenge, message.signature)) {
            finish("unreachable");
            return;
          }
          if (done) return;
          verified = true;
          send(conn, { type: "hello", version: 1, joinKey: invite.joinKey, probe: true });
        } else if (verified && message.type === "available") finish("online");
        else if (verified && message.type === "denied") finish("access-denied");
        else finish("unreachable");
      })().catch(() => finish("unreachable"));
    });
  });
}
