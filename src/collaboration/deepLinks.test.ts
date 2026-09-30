import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  getCurrent: vi.fn<() => Promise<string[] | null>>(),
  onOpenUrl: vi.fn<(handler: (urls: string[]) => void) => Promise<() => void>>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: native.isTauri }));
vi.mock("@tauri-apps/plugin-deep-link", () => native);

let onOpen: (urls: string[]) => void;
let events: string[];

beforeEach(() => {
  vi.resetModules();
  native.isTauri.mockReset().mockReturnValue(true);
  native.getCurrent.mockReset().mockResolvedValue(null);
  native.onOpenUrl.mockReset().mockImplementation(async (handler) => {
    onOpen = handler;
    return () => {};
  });
  events = [];
  const target = new EventTarget();
  target.addEventListener("whiteboard-invite", (event) => {
    events.push((event as CustomEvent<string>).detail);
  });
  vi.stubGlobal("window", target);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("native invite delivery", () => {
  it("retains a cold-launch invitation until the UI consumes it", async () => {
    const url = "whiteboard://join#cold_start-123";
    native.getCurrent.mockResolvedValue([url]);
    const links = await import("./deepLinks");
    await links.initializeDeepLinks();
    expect(events).toEqual([url]);
    expect(links.getPendingInvite()).toBe(url);
    expect(links.consumePendingInvite()).toBe(url);
    expect(links.consumePendingInvite()).toBeNull();
  });

  it("listens only once and delivers later opens including repeated links", async () => {
    const links = await import("./deepLinks");
    await Promise.all([links.initializeDeepLinks(), links.initializeDeepLinks()]);
    onOpen(["whiteboard://join#later"]);
    onOpen(["whiteboard://join#later"]);
    expect(native.onOpenUrl).toHaveBeenCalledTimes(1);
    expect(native.getCurrent).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["whiteboard://join#later", "whiteboard://join#later"]);
    expect(links.getPendingInvite()).toBe("whiteboard://join#later");
  });

  it("does not overwrite a newer live link with a stale startup snapshot", async () => {
    let resolveSnapshot!: (urls: string[]) => void;
    native.getCurrent.mockImplementation(() => new Promise((resolve) => { resolveSnapshot = resolve; }));
    const links = await import("./deepLinks");
    const starting = links.initializeDeepLinks();
    await vi.waitFor(() => expect(native.getCurrent).toHaveBeenCalledTimes(1));
    onOpen(["whiteboard://join#new"]);
    resolveSnapshot(["whiteboard://join#old"]);
    await starting;
    expect(events).toEqual(["whiteboard://join#new"]);
    expect(links.getPendingInvite()).toBe("whiteboard://join#new");
  });

  it.each([
    "https://join#abc",
    "other://join#abc",
    "whiteboard://other#abc",
    "whiteboard://user@join#abc",
    "whiteboard://join:42#abc",
    "whiteboard://join/path#abc",
    "whiteboard://join/#abc",
    "whiteboard://join?abc#abc",
    "whiteboard://join#",
    "whiteboard://join#abc\n",
    "whiteboard://join#abc%20",
    " whiteboard://join#abc",
    `whiteboard://join#${"a".repeat(8192)}`,
  ])("rejects a malformed or oversized native route (case %#)", async (url) => {
    native.getCurrent.mockResolvedValue([url]);
    const links = await import("./deepLinks");
    await links.initializeDeepLinks();
    onOpen([url]);
    expect(events).toEqual([]);
    expect(links.getPendingInvite()).toBeNull();
  });

  it("does not call native APIs in a normal browser", async () => {
    native.isTauri.mockReturnValue(false);
    const links = await import("./deepLinks");
    await links.initializeDeepLinks();
    expect(native.onOpenUrl).not.toHaveBeenCalled();
    expect(native.getCurrent).not.toHaveBeenCalled();
  });

  it("retains event delivery when startup retrieval fails without logging secrets", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    native.getCurrent.mockRejectedValue(new Error("whiteboard://join#secret"));
    const links = await import("./deepLinks");
    await links.initializeDeepLinks();
    onOpen(["whiteboard://join#later"]);
    expect(events).toEqual(["whiteboard://join#later"]);
    expect(warn).toHaveBeenCalledWith("Native startup invitation could not be read.");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("secret");
  });
});
