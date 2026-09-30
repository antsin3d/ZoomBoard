import { isTauri } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";

export const INVITE_EVENT = "whiteboard-invite";
const INVITE_PREFIX = "whiteboard://join#";
const MAX_INVITE_URL_LENGTH = 8192;
let pendingInvite: string | null = null;
let initialization: Promise<void> | null = null;

/** The last native invitation, retained until a mounted UI consumes it. */
export function getPendingInvite(): string | null {
  return pendingInvite;
}

/** Call after attaching the event listener, and when handling its detail URL. */
export function consumePendingInvite(): string | null {
  const invite = pendingInvite;
  pendingInvite = null;
  return invite;
}

function acceptInvites(urls: string[]): boolean {
  // Accept only the canonical route and a bounded base64url invitation.
  // Full invitation/key validation belongs to the explicit Join action.
  // No URL normalization: credentials, ports, paths, queries and whitespace
  // must not be silently accepted or stripped.
  let latest: string | null = null;
  for (const url of urls) {
    if (
      typeof url === "string" &&
      url.length <= MAX_INVITE_URL_LENGTH &&
      url.startsWith(INVITE_PREFIX) &&
      url.length > INVITE_PREFIX.length &&
      !/[^A-Za-z0-9_-]/.test(url.slice(INVITE_PREFIX.length))
    ) {
      latest = url;
    }
  }
  if (latest === null) return false;
  pendingInvite = latest;
  window.dispatchEvent(new CustomEvent<string>(INVITE_EVENT, { detail: latest }));
  return true;
}

/**
 * Start once after React render. Events only prefill an invitation: this module
 * never connects, navigates, modifies a board, or handles browser location.hash.
 * The pending slot bridges asynchronous React mounting and cold native launches.
 */
export function initializeDeepLinks(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  if (initialization) return initialization;

  initialization = (async () => {
    let receivedOpenUrl = false;
    // Subscribe before the startup snapshot so links cannot fall into the gap.
    try {
      await onOpenUrl((urls) => {
        if (acceptInvites(urls)) receivedOpenUrl = true;
      });
    } catch {
      // Errors can contain invocation arguments. Never log the raw exception.
      console.warn("Native invitation listener could not be started.");
    }

    try {
      const urls = await getCurrent();
      // A live event takes priority over a potentially stale startup snapshot,
      // and must not be delivered twice if getCurrent already contains it.
      if (!receivedOpenUrl && urls) acceptInvites(urls);
    } catch {
      console.warn("Native startup invitation could not be read.");
    }
  })();
  return initialization;
}
