import { MAX_MESSAGE_BYTES } from "./protocol";

export const MAX_FRAME_BYTES = 16 * 1024;
export const MAX_FRAME_CHARS = 2048;
export const MAX_FRAME_COUNT = Math.ceil(MAX_MESSAGE_BYTES / MAX_FRAME_CHARS);
export const FRAME_TIMEOUT_MS = 15_000;
const encoder = new TextEncoder();

/** Send all returned frames contiguously on a reliable, ordered raw channel. */
export function encodeFrames(message: string): string[] {
  if (typeof message !== "string" || message.length > MAX_MESSAGE_BYTES
    || encoder.encode(message).byteLength > MAX_MESSAGE_BYTES) {
    throw new Error("Message exceeds 8 MiB or is not a string.");
  }
  const chunks: string[] = [];
  let start = 0;
  do {
    let end = Math.min(start + MAX_FRAME_CHARS, message.length);
    // Keep surrogate pairs together so per-frame UTF-8 accounting is exact.
    if (end < message.length && message.charCodeAt(end - 1) >= 0xd800
      && message.charCodeAt(end - 1) <= 0xdbff && message.charCodeAt(end) >= 0xdc00
      && message.charCodeAt(end) <= 0xdfff) end--;
    chunks.push(message.slice(start, end));
    start = end;
  } while (start < message.length);
  if (chunks.length > MAX_FRAME_COUNT) throw new Error("Too many message frames.");
  // Even six-byte JSON escapes for every code unit fit within MAX_FRAME_BYTES.
  return chunks.map((s, i) => JSON.stringify({ v: 1, i, n: chunks.length, s }));
}

/** Bounded assembly for one message at a time; violations discard all state. */
export class FrameReceiver {
  private parts: string[] = [];
  private count = 0;
  private bytes = 0;
  private startedAt: number | null = null;

  push(raw: unknown, maxBytes = MAX_MESSAGE_BYTES): string | null {
    try {
      const now = Date.now();
      if (this.startedAt !== null && now - this.startedAt >= FRAME_TIMEOUT_MS) {
        throw new Error("Incomplete message expired.");
      }
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_MESSAGE_BYTES) {
        throw new Error("Invalid message byte limit.");
      }
      // Bound both parsing and the temporary UTF-8 allocation, before JSON.parse.
      if (typeof raw !== "string" || raw.length > MAX_FRAME_BYTES
        || encoder.encode(raw).byteLength > MAX_FRAME_BYTES) {
        throw new Error("Invalid or oversized frame.");
      }
      const frame: unknown = JSON.parse(raw);
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
        throw new Error("Invalid frame object.");
      }
      const fields = frame as Record<string, unknown>;
      const { v, i, n, s } = fields;
      if (Object.keys(fields).length !== 4
        || !["v", "i", "n", "s"].every((key) => Object.hasOwn(fields, key))
        || v !== 1 || typeof i !== "number" || !Number.isSafeInteger(i)
        || typeof n !== "number" || !Number.isSafeInteger(n)
        || n < 1 || n > MAX_FRAME_COUNT || i < 0 || i >= n
        || typeof s !== "string" || s.length > MAX_FRAME_CHARS) {
        throw new Error("Invalid frame schema.");
      }
      if (i !== this.parts.length || (this.count !== 0 && n !== this.count)) {
        throw new Error("Out-of-order or interleaved frame.");
      }
      // Malicious split surrogate pairs may be overcounted, never undercounted.
      const bytes = this.bytes + encoder.encode(s).byteLength;
      if (bytes > maxBytes) throw new Error("Message exceeds byte limit.");
      if (this.startedAt === null) {
        this.startedAt = now;
        this.count = n;
      }
      this.bytes = bytes;
      this.parts.push(s);
      if (this.parts.length !== this.count) return null;
      const message = this.parts.join("");
      this.clear();
      return message;
    } catch (error) {
      this.clear();
      throw error;
    }
  }

  clear(): void {
    this.parts = [];
    this.count = 0;
    this.bytes = 0;
    this.startedAt = null;
  }
}
