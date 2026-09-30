import { useBoardStore } from "../whiteboard/store";
import { useSessionStore } from "./session";

export default function PresenceOverlay() {
  const { participants, localId, role, status, followingId } = useSessionStore();
  const zoom = useBoardStore((state) => state.zoom);
  const panX = useBoardStore((state) => state.panX);
  const panY = useBoardStore((state) => state.panY);
  if (role === "idle" || status !== "online") return null;
  const followed = participants.find((peer) => peer.id === followingId);

  return (
    <div className="presence-overlay" aria-hidden="true">
      {followed && <div className="presence-following">Following {followed.name} · interact to stop</div>}
      {participants.filter((peer) => peer.id !== localId && peer.cursor).map((peer) => (
        <div key={peer.id} className="presence-cursor" style={{
          transform: `translate(${peer.cursor!.x * zoom + panX}px, ${peer.cursor!.y * zoom + panY}px)`,
          color: peer.color,
        }}>
          <svg width="16" height="20" viewBox="0 0 16 20"><path d="M1 1v16l4-4 3 6 3-1-3-6h6Z" fill="currentColor" stroke="white" strokeWidth="1.5" /></svg>
          <span style={{ backgroundColor: peer.color }}>{peer.name}</span>
        </div>
      ))}
    </div>
  );
}
