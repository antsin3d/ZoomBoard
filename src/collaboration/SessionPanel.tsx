import { useEffect, useRef, useState } from "react";
import {
  favoriteSession, followPeer, hostSession, joinSession, kickPeer, leaveSession,
  refreshFavorites, removeFavorite, rotateSessionInvite, setDisplayName,
  setSessionPolicy, useSessionStore,
} from "./session";
import { inviteCode, inviteLink } from "./protocol";

interface SessionPanelProps {
  documentName: string;
  fileBusy: boolean;
  inviteInput: string;
  onClose: () => void;
}

export default function SessionPanel({ documentName, fileBusy, inviteInput, onClose }: SessionPanelProps) {
  const session = useSessionStore();
  const [joinInput, setJoinInput] = useState(inviteInput);
  const [nameInput, setNameInput] = useState(session.name);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const idle = session.role === "idle";
  const host = session.role === "host";
  const locked = busy || fileBusy || session.status === "connecting";

  useEffect(() => setJoinInput(inviteInput), [inviteInput]);
  useEffect(() => setNameInput(session.name), [session.name]);

  // Probes are only scheduled while this panel is mounted and the app is visible.
  useEffect(() => {
    let running = false;
    let active = true;
    const probe = async () => {
      if (running || document.hidden) return;
      running = true;
      try { await refreshFavorites(); }
      catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Favorites could not be checked.");
      } finally { running = false; }
    };
    void probe();
    const timer = window.setInterval(() => void probe(), 25_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const run = async (action: () => void | Promise<void>) => {
    if (busyRef.current || fileBusy) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The session action failed."); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const join = (value: string) => run(async () => {
    if (useSessionStore.getState().role !== "idle") return;
    await joinSession(value);
  });
  const copy = (value: string, label: string) => run(async () => {
    if (!navigator.clipboard) throw new Error("Clipboard unavailable. Select and copy the invitation below.");
    await navigator.clipboard.writeText(value);
    setNotice(`${label} copied.`);
  });

  return (
    <section className="session-panel" role="dialog" aria-labelledby="session-heading">
      <header className="session-header">
        <h2 id="session-heading">Share / Join</h2>
        <button type="button" className="tool-btn" onClick={onClose} aria-label="Close collaboration panel">×</button>
      </header>
      <div className="session-body">
        <div className="session-row">
          <span className={`session-status session-status-${session.status}`}>{session.status}</span>
          {!idle && <strong className="session-truncate">{session.title} · {host ? "Host" : "Guest"}</strong>}
        </div>
        <label className="session-field">
          Display name
          <input value={nameInput} maxLength={48} onChange={(event) => setNameInput(event.target.value)} onBlur={() => {
            setDisplayName(nameInput);
            setNameInput(useSessionStore.getState().name);
          }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} placeholder="Your name" />
        </label>
        {idle ? (
          <>
            <button type="button" className="session-primary" disabled={locked} onClick={() => void run(async () => {
              if (useSessionStore.getState().role === "idle") await hostSession(documentName.replace(/\.board$/i, ""));
            })}>Host this board</button>
            <form className="session-join" onSubmit={(event) => { event.preventDefault(); if (!locked && joinInput.trim()) void join(joinInput.trim()); }}>
              <label className="session-field">
                Invitation link or code
                <textarea value={joinInput} onChange={(event) => setJoinInput(event.target.value)} rows={2} placeholder="Paste a whiteboard:// link or code" />
              </label>
              <button type="submit" className="session-primary" disabled={locked || !joinInput.trim()}>Join session</button>
            </form>
            <p className="session-help">Your local board stays in this app and is restored when you leave. Joining never opens or overwrites a local file.</p>
          </>
        ) : (
          <>
            <p className="session-help">Leave this session before opening a different board or joining another one.</p>
            {session.invite && (
              <>
                <label className="session-field">
                  Invitation
                  <textarea readOnly rows={2} value={inviteLink(session.invite)} onFocus={(event) => event.currentTarget.select()} />
                </label>
                <div className="session-row">
                  <button type="button" disabled={locked} onClick={() => void copy(inviteLink(session.invite!), "Link")}>Copy link</button>
                  <button type="button" disabled={locked} onClick={() => void copy(inviteCode(session.invite!), "Code")}>Copy code</button>
                  {!host && <button type="button" disabled={locked} onClick={() => void run(favoriteSession)}>Favorite</button>}
                </div>
                <p className="session-help">Paste this link or code into Share / Join in Whiteboard. No hosted website is required.</p>
              </>
            )}
            {host ? (
              <>
                <fieldset className="session-policy" disabled={locked}>
                  <legend>Guest permissions</legend>
                  <label><input type="checkbox" checked={session.allowEditing} onChange={(event) => setSessionPolicy({ allowEditing: event.target.checked })} /> Allow editing</label>
                  <label><input type="checkbox" checked={session.allowDownload} onChange={(event) => setSessionPolicy({ allowDownload: event.target.checked })} /> Allow download / copy</label>
                </fieldset>
                <p className="session-help">Save your board after generating or rotating its invitation to preserve the host identity and invitation across restarts.</p>
                <button type="button" disabled={locked} onClick={() => {
                  if (window.confirm("Rotate this invitation and disconnect current guests? Previous links and saved favorites will no longer grant access. Save the board afterward to keep the new invitation.")) void run(rotateSessionInvite);
                }}>Rotate invitation…</button>
              </>
            ) : (
              <p className="session-help">
                {session.status !== "online" ? "Connection unavailable. Editing and download are disabled; leave to restore your local board." :
                  `${session.allowEditing ? "Editing allowed" : "View only"} · ${session.allowDownload ? "Download / copy allowed" : "Download / copy disabled"}`}
                {session.pending && " · Waiting for host acknowledgement"}
              </p>
            )}
            <div className="session-participants">
              <h3>Participants</h3>
              {session.participants.map((peer) => (
                <div className="session-row" key={peer.id}>
                  <span className="session-peer-dot" style={{ backgroundColor: peer.color }} />
                  <span className="session-truncate">{peer.name}{peer.id === session.localId ? " (you)" : ""}</span>
                  {peer.id !== session.localId && (
                    <>
                      <button type="button" disabled={session.status !== "online"} aria-pressed={session.followingId === peer.id} onClick={() => followPeer(session.followingId === peer.id ? null : peer.id)}>
                        {session.followingId === peer.id ? "Stop following" : "Follow"}
                      </button>
                      {host && <button type="button" disabled={locked} onClick={() => {
                        if (window.confirm(`Remove ${peer.name} from this session? They can rejoin with the same invitation. Rotate the invitation to revoke access.`)) void run(() => kickPeer(peer.id));
                      }}>Remove</button>}
                    </>
                  )}
                </div>
              ))}
            </div>
            <button type="button" className="session-danger" disabled={busy || fileBusy} onClick={() => {
              if (!host || window.confirm("End this session and disconnect all guests?")) void run(leaveSession);
            }}>{host ? "End session" : "Leave session"}</button>
          </>
        )}
        <section className="session-favorites">
          <div className="session-row">
            <h3>Favorite sessions</h3>
            <button type="button" disabled={locked} onClick={() => void run(refreshFavorites)}>Refresh</button>
          </div>
          {!session.favorites.length && <p className="session-help">Favorite a joined session to find it here later. Hosts must be online.</p>}
          {session.favorites.map((favorite) => (
            <div className="session-favorite" key={favorite.id}>
              <div className="session-row"><strong className="session-truncate">{favorite.title}</strong><span className="session-help">{session.favoriteStatuses[favorite.id] ?? "Not checked"}</span></div>
              <div className="session-row">
                <button type="button" disabled={locked || !idle} onClick={() => void join(inviteCode(favorite.invite))}>Join</button>
                <button type="button" disabled={locked} onClick={() => void run(() => removeFavorite(favorite.id))}>Remove favorite</button>
              </div>
            </div>
          ))}
        </section>
        {(error || session.error) && <p className="session-error" role="alert">{error || session.error}</p>}
        {notice && <p className="session-help" role="status">{notice}</p>}
        <p className="session-help session-disclosure">Uses public PeerJS signaling and STUN services operated by third parties. Connections are best-effort; there is no TURN relay, so some networks cannot connect. Visitors receive board data even when download is disabled: this is an app permission, not copy protection. Only share invitations with people you trust.</p>
      </div>
    </section>
  );
}
