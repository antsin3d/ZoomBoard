import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeFrames, FrameReceiver, FRAME_TIMEOUT_MS, MAX_FRAME_BYTES,
  MAX_FRAME_CHARS, MAX_FRAME_COUNT,
} from "./framing";
import { MAX_MESSAGE_BYTES } from "./protocol";

const encoder = new TextEncoder();
const frame = (i: number, n: number, s = "part") => JSON.stringify({ v: 1, i, n, s });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function roundtrip(message: string, maxBytes?: number): string {
  const frames = encodeFrames(message);
  const receiver = new FrameReceiver();
  let result: string | null = null;
  for (let i = 0; i < frames.length; i++) {
    expect(encoder.encode(frames[i]).byteLength).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    result = receiver.push(frames[i], maxBytes);
    if (i < frames.length - 1) expect(result).toBeNull();
  }
  expect(result).toBe(message);
  return result!;
}

describe("raw channel framing", () => {
  it("roundtrips messages larger than 64 KiB without exposing partial content", () => {
    roundtrip(JSON.stringify({ data: "abcd".repeat(40_000) }));
  });

  it.each(["", "plain text, not application JSON", "{broken", "null"])(
    "returns completed messages verbatim (case %#)", (message) => {
      roundtrip(message);
    },
  );

  it("roundtrips unicode, controls, quotes, slashes and lone surrogates", () => {
    roundtrip(("😀漢字é\u0000\u0001\b\f\n\r\t\"\\\ud800X\udc00").repeat(3000));
  });

  it("keeps maximally escaped control frames under the wire byte limit", () => {
    roundtrip("\u0000".repeat(MAX_FRAME_CHARS * 40));
  });

  it("preserves scalar boundaries and derives the actual count after splitting", () => {
    const message = "a".repeat(MAX_FRAME_CHARS - 1) + "😀" + "b".repeat(MAX_FRAME_CHARS - 1);
    const frames = encodeFrames(message).map((raw) => JSON.parse(raw));
    expect(frames).toHaveLength(3);
    expect(frames[0].s).toBe("a".repeat(MAX_FRAME_CHARS - 1));
    expect(frames[1].s.startsWith("😀")).toBe(true);
    expect(frames.map(({ i, n }) => [i, n])).toEqual([[0, 3], [1, 3], [2, 3]]);
    roundtrip(message, encoder.encode(message).byteLength);
  });

  it("accepts the full 8 MiB ASCII limit with the maximum frame count", () => {
    const message = "a".repeat(MAX_MESSAGE_BYTES);
    expect(encodeFrames(message)).toHaveLength(MAX_FRAME_COUNT);
    roundtrip(message);
  });

  it("accepts the exact byte limit with a surrogate boundary adjustment", () => {
    const message = "a".repeat(MAX_FRAME_CHARS - 1) + "😀"
      + "a".repeat(MAX_MESSAGE_BYTES - MAX_FRAME_CHARS - 3);
    expect(encoder.encode(message).byteLength).toBe(MAX_MESSAGE_BYTES);
    roundtrip(message);
  });

  it.each([
    "a".repeat(MAX_MESSAGE_BYTES + 1),
    "é".repeat(MAX_MESSAGE_BYTES / 2 + 1),
  ])("rejects outgoing messages exceeding the UTF-8 limit (case %#)", (message) => {
    expect(() => encodeFrames(message)).toThrow(/8 MiB/);
  });

  it.each([
    undefined, null, 1, {}, [], new Uint8Array([123, 125]), new ArrayBuffer(4),
    "", "{", "null", "true", "1", "[]", '"text"',
    JSON.stringify({ v: 2, i: 0, n: 1, s: "" }),
    JSON.stringify({ i: 0, n: 1, s: "" }),
    JSON.stringify({ v: 1, i: 0, n: 1 }),
    JSON.stringify({ v: 1, i: 0, n: 1, s: "", extra: true }),
    '{"v":1,"i":0,"n":1,"s":"","__proto__":{}}',
    JSON.stringify({ v: 1, i: "0", n: 1, s: "" }),
    JSON.stringify({ v: 1, i: 0, n: "1", s: "" }),
    JSON.stringify({ v: 1, i: 0, n: 1, s: 123 }),
    frame(-1, 1), frame(0.5, 1), frame(0, 1.5), frame(0, 0), frame(0, -1),
    frame(0, MAX_FRAME_COUNT + 1), frame(0, Number.MAX_SAFE_INTEGER + 1),
    frame(Number.MAX_SAFE_INTEGER + 1, 1), frame(1, 1),
    '{"v":1,"i":1e400,"n":1,"s":""}',
    '{"v":1,"i":0,"n":1e400,"s":""}',
    frame(0, 1, "x".repeat(MAX_FRAME_CHARS + 1)),
  ])("rejects malformed frames and resets buffered state (case %#)", (raw) => {
    const receiver = new FrameReceiver();
    expect(receiver.push(frame(0, 2))).toBeNull();
    expect(() => receiver.push(raw)).toThrow();
    expect(receiver.push(frame(0, 1, "fresh"))).toBe("fresh");
  });

  it.each([
    " ".repeat(MAX_FRAME_BYTES + 1),
    JSON.stringify({ v: 1, i: 0, n: 1, s: "漢".repeat(6000) }),
  ])("checks raw UTF-8 size before parsing (case %#)", (raw) => {
    const parse = vi.spyOn(JSON, "parse");
    expect(() => new FrameReceiver().push(raw)).toThrow(/oversized frame/);
    expect(parse).not.toHaveBeenCalled();
  });

  it("accepts exactly the raw frame byte limit, including JSON whitespace", () => {
    const raw = frame(0, 1, "hello");
    expect(new FrameReceiver().push(raw + " ".repeat(MAX_FRAME_BYTES - raw.length))).toBe("hello");
  });

  it("enforces an unauthenticated aggregate byte limit before completion", () => {
    const receiver = new FrameReceiver();
    expect(receiver.push(frame(0, 3, "a".repeat(2048)), 4096)).toBeNull();
    expect(receiver.push(frame(1, 3, "a".repeat(2048)), 4096)).toBeNull();
    expect(() => receiver.push(frame(2, 3, "x"), 4096)).toThrow(/byte limit/);
    expect(receiver.push(frame(0, 1, "fresh"), 4096)).toBe("fresh");
  });

  it("counts UTF-8 bytes rather than code units for the aggregate limit", () => {
    const receiver = new FrameReceiver();
    expect(receiver.push(frame(0, 2, "é".repeat(1024)), 4096)).toBeNull();
    expect(() => receiver.push(frame(1, 2, "é".repeat(1025)), 4096)).toThrow(/byte limit/);
  });

  it("enforces the full byte limit even when declared count and chunk sizes are valid", () => {
    const receiver = new FrameReceiver();
    const chunk = "漢".repeat(MAX_FRAME_CHARS);
    const accepted = Math.floor(MAX_MESSAGE_BYTES / encoder.encode(chunk).byteLength);
    for (let i = 0; i < accepted; i++) {
      expect(receiver.push(frame(i, MAX_FRAME_COUNT, chunk))).toBeNull();
    }
    expect(() => receiver.push(frame(accepted, MAX_FRAME_COUNT, chunk))).toThrow(/byte limit/);
  });

  it("rechecks the current byte limit against all accumulated parts", () => {
    const receiver = new FrameReceiver();
    expect(receiver.push(frame(0, 2, "a".repeat(2048)))).toBeNull();
    expect(() => receiver.push(frame(1, 2, ""), 1024)).toThrow(/byte limit/);
  });

  it.each([-1, NaN, Infinity, 1.5, MAX_MESSAGE_BYTES + 1])(
    "rejects unsafe caller byte limits (case %#)", (limit) => {
      expect(() => new FrameReceiver().push(frame(0, 1), limit)).toThrow(/byte limit/);
    },
  );

  it("allows an empty message at a zero byte limit", () => {
    expect(new FrameReceiver().push(frame(0, 1, ""), 0)).toBe("");
  });

  it.each([
    [frame(1, 2)],
    [frame(0, 3), frame(2, 3)],
    [frame(0, 2), frame(0, 2)],
    [frame(0, 2), frame(0, 1, "interleaved")],
    [frame(0, 2), frame(1, 3)],
    [frame(0, 3), frame(1, 2)],
  ])("rejects wrong ordering, replay and changed counts (case %#)", (...frames) => {
    const receiver = new FrameReceiver();
    for (const raw of frames.slice(0, -1)) expect(receiver.push(raw)).toBeNull();
    expect(() => receiver.push(frames[frames.length - 1])).toThrow(/order|interleaved/);
    expect(receiver.push(frame(0, 1, "fresh"))).toBe("fresh");
  });

  it("bounds the number of buffered parts even when chunks are empty", () => {
    const receiver = new FrameReceiver();
    for (let i = 0; i < MAX_FRAME_COUNT - 1; i++) {
      expect(receiver.push(frame(i, MAX_FRAME_COUNT, ""))).toBeNull();
    }
    expect(receiver.push(frame(MAX_FRAME_COUNT - 1, MAX_FRAME_COUNT, ""))).toBe("");
    expect(() => receiver.push(frame(MAX_FRAME_COUNT, MAX_FRAME_COUNT, ""))).toThrow();
  });

  it("clears partial messages, bytes and timestamps explicitly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const receiver = new FrameReceiver();
    expect(receiver.push(frame(0, 2, "a".repeat(2048)))).toBeNull();
    receiver.clear();
    receiver.clear();
    vi.setSystemTime(FRAME_TIMEOUT_MS);
    expect(receiver.push(frame(0, 1, "fresh"), 5)).toBe("fresh");
    expect(() => receiver.push(frame(1, 2))).toThrow();
  });

  it("expires from the first part, even when subsequent parts make progress", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const receiver = new FrameReceiver();
    expect(receiver.push(frame(0, 3))).toBeNull();
    vi.setSystemTime(FRAME_TIMEOUT_MS - 1);
    expect(receiver.push(frame(1, 3))).toBeNull();
    vi.setSystemTime(FRAME_TIMEOUT_MS);
    expect(() => receiver.push(frame(2, 3))).toThrow(/expired/);
    expect(receiver.push(frame(0, 1, "fresh"))).toBe("fresh");
  });

  it("checks expiry when a heartbeat arrives instead of the next part", () => {
    vi.useFakeTimers();
    const receiver = new FrameReceiver();
    expect(receiver.push(frame(0, 2))).toBeNull();
    vi.advanceTimersByTime(FRAME_TIMEOUT_MS);
    expect(() => receiver.push(frame(0, 1, "heartbeat"))).toThrow(/expired/);
  });

  it("resets assembly state after completion for the next message", () => {
    vi.useFakeTimers();
    const receiver = new FrameReceiver();
    expect(receiver.push(frame(0, 2, "a"))).toBeNull();
    expect(receiver.push(frame(1, 2, "b"))).toBe("ab");
    vi.advanceTimersByTime(FRAME_TIMEOUT_MS);
    expect(receiver.push(frame(0, 1, "next"), 4)).toBe("next");
  });
});
