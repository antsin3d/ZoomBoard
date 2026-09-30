import { useCallback, useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import BoardCanvas, { useZoomControls } from "./canvas/BoardCanvas";
import ZoomTimeline from "./panels/ZoomTimeline";
import LayersPanel from "./panels/LayersPanel";
import PropsPanel from "./panels/PropsPanel";
import { useBoardStore } from "./whiteboard/store";
import { migrateToRegions } from "./whiteboard/regions";
import { deserializeBoard, serializeBoard, serializeBoardCopy } from "./whiteboard/document";
import { openBoardFile, saveBoardFile } from "./whiteboard/fileIO";
import { isTauri } from "@tauri-apps/api/core";
import { breakpointColor, type ShapeType, type ToolMode } from "./whiteboard/model";
import SessionPanel from "./collaboration/SessionPanel";
import { useSessionStore } from "./collaboration/session";
import { consumePendingInvite, INVITE_EVENT } from "./collaboration/deepLinks";
import "./collaboration/collaboration.css";

const SUPPORT_URL = "https://www.buymeacoffee.com/GetUp";

function SupportButton() {
  const handleClick = async () => {
    if (isTauri()) {
      try {
        const { open } = await import("@tauri-apps/plugin-shell");
        await open(SUPPORT_URL);
        return;
      } catch {
        // Fall through to a plain browser open below.
      }
    }
    window.open(SUPPORT_URL, "_blank", "noopener,noreferrer");
  };
  return (
    <button
      type="button"
      className="tool-btn support-btn"
      onClick={() => void handleClick()}
      title="Support me on Buy Me a Coffee"
    >
      <span aria-hidden="true">☕</span><span>Support</span>
    </button>
  );
}

// ─── Toolbar ──────────────────────────────────────────────────────────────────

const SelectIcon = () => (
  <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 3.75v15.3l4.2-4.05 2.55 5.1 2.35-1.18-2.48-4.92h5.63L5 3.75Z" />
  </svg>
);

const SHAPE_TOOLS: { id: ShapeType; label: string; title: string }[] = [
  { id: "rect", label: "▭", title: "Rectangle (R)" },
  { id: "ellipse", label: "○", title: "Ellipse" },
  { id: "triangle", label: "△", title: "Triangle" },
  { id: "diamond", label: "◇", title: "Diamond" },
  { id: "hexagon", label: "⬡", title: "Hexagon" },
  { id: "star", label: "☆", title: "Star" },
];

const TOOLS: { id: ToolMode; label: ReactNode; title: string }[] = [
  { id: "select", label: <SelectIcon />, title: "Select (V)" },
  { id: "text", label: "T", title: "Text (T)" },
  { id: "sticky", label: "◆", title: "Sticky note (S)" },
  { id: "frame", label: "▣", title: "Frame (F)" },
  { id: "connector", label: "╱", title: "Connector (C)" },
];

function ShapeMenu({
  tool, onSelect,
}: {
  tool: ToolMode;
  onSelect: (tool: ToolMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const [lastShape, setLastShape] = useState<ShapeType>("rect");
  const menuRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const active = SHAPE_TOOLS.find((shape) => shape.id === lastShape) ?? SHAPE_TOOLS[0];
  const shapeActive = SHAPE_TOOLS.some((shape) => shape.id === tool);

  useEffect(() => {
    if (shapeActive) setLastShape(tool as ShapeType);
  }, [shapeActive, tool]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    window.addEventListener("pointerdown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const chooseShape = (shape: ShapeType) => {
    setLastShape(shape);
    onSelect(shape);
    setOpen(false);
  };

  return (
    <div className="shape-menu" ref={menuRef}>
      <button
        type="button"
        className={`tool-btn shape-menu-primary${shapeActive ? " tool-active" : ""}`}
        title={active.title}
        onClick={() => {
          onSelect(lastShape);
          setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{active.label}</span>
      </button>
      <button
        ref={toggleRef}
        type="button"
        className={`tool-btn shape-menu-toggle${open ? " shape-menu-toggle-open" : ""}`}
        title="Choose shape"
        aria-label="Choose shape"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className="shape-menu-caret" aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="shape-menu-popover" role="menu" aria-label="Shapes">
          {SHAPE_TOOLS.map((shape) => (
            <button
              key={shape.id}
              type="button"
              className={`shape-choice${tool === shape.id ? " shape-choice-active" : ""}`}
              title={shape.title}
              role="menuitemradio"
              aria-checked={tool === shape.id}
              onClick={() => chooseShape(shape.id)}
            >
              <span className="shape-choice-icon">{shape.label}</span>
              <span>{shape.title.replace(/\s*\([^)]*\)$/, "")}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Toolbar() {
  const session = useSessionStore(useShallow((state) => ({
    role: state.role, status: state.status, title: state.title,
    allowEditing: state.allowEditing, allowDownload: state.allowDownload,
    pending: state.pending, error: state.error,
  })));
  const [sessionPanelOpen, setSessionPanelOpen] = useState(false);
  const [inviteInput, setInviteInput] = useState("");
  const guest = session.role === "guest";
  const editable = !guest || (session.status === "online" && session.allowEditing);
  const {
    tool, setTool, zoom, board, activeBreakpointId,
    _past, _future, undo, redo, replaceBoard,
    connectSelected,
  } = useBoardStore();
  const { zoomTo, resetZoom } = useZoomControls();
  const [documentPath, setDocumentPath] = useState<string | null>(null);
  const [documentName, setDocumentName] = useState("Untitled.board");
  const [fileBusy, setFileBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  const documentPathRef = useRef(documentPath);
  const documentNameRef = useRef(documentName);
  const boardRef = useRef(board);
  const dirtyRef = useRef(dirty);
  // Never serialize a guest projection into the local document during render.
  const lastSavedRef = useRef<string | null>(null);
  if (lastSavedRef.current === null) lastSavedRef.current = serializeBoard(board);
  const localDirtyRef = useRef(false);
  const fileBusyRef = useRef(fileBusy);
  const closingRef = useRef(false);
  documentPathRef.current = documentPath;
  documentNameRef.current = documentName;
  boardRef.current = board;
  dirtyRef.current = dirty;
  fileBusyRef.current = fileBusy;

  const markClean = useCallback((nextBoard: typeof board) => {
    lastSavedRef.current = serializeBoard(nextBoard);
    dirtyRef.current = false;
    setDirty(false);
  }, []);

  useEffect(() => {
    return useBoardStore.subscribe((state, prev) => {
      if (useSessionStore.getState().role === "guest") return;
      if (state.board === prev.board) return;
      const isDirty = serializeBoard(state.board) !== lastSavedRef.current;
      dirtyRef.current = isDirty;
      setDirty(isDirty);
    });
  }, []);

  useEffect(() => useSessionStore.subscribe((state, prev) => {
    if (state.role === "guest" && prev.role !== "guest") {
      localDirtyRef.current = dirtyRef.current;
    } else if (prev.role === "guest" && state.role !== "guest") {
      dirtyRef.current = localDirtyRef.current;
      setDirty(localDirtyRef.current);
    } else if (state.role === "host" && state.invite !== prev.invite) {
      // Host identity changes live in the file envelope, not in board elements.
      const changed = serializeBoard(useBoardStore.getState().board) !== lastSavedRef.current;
      dirtyRef.current = changed;
      setDirty(changed);
    }
  }), []);

  useEffect(() => {
    const prefill = (value: string) => {
      setInviteInput(value);
      setSessionPanelOpen(true);
    };
    const readHash = () => {
      const hash = window.location.hash;
      if (hash.startsWith("#join=")) {
        try { prefill(decodeURIComponent(hash.slice(6))); }
        catch { prefill(hash.slice(6)); }
      }
    };
    const onInvite = (event: Event) => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (typeof detail === "string") {
        consumePendingInvite();
        prefill(detail);
      }
    };
    readHash();
    window.addEventListener("hashchange", readHash);
    window.addEventListener(INVITE_EVENT, onInvite);
    const pendingInvite = consumePendingInvite();
    if (pendingInvite) prefill(pendingInvite);
    return () => {
      window.removeEventListener("hashchange", readHash);
      window.removeEventListener(INVITE_EVENT, onInvite);
    };
  }, []);

  // Use the store's zone-aware activeBreakpointId — not a manual cascade lookup.
  const activeBp = board.breakpoints.find((bp) => bp.id === activeBreakpointId);

  const handleToolClick = useCallback((nextTool: ToolMode) => {
    if (!editable && nextTool !== "select") return;
    if (nextTool === "connector" && connectSelected()) {
      setTool("select");
      return;
    }
    setTool(nextTool);
  }, [connectSelected, setTool, editable]);

  const handleOpen = useCallback(async () => {
    if (fileBusyRef.current || useSessionStore.getState().role !== "idle") return;
    fileBusyRef.current = true;
    setFileBusy(true);
    try {
      const opened = await openBoardFile();
      if (!opened || useSessionStore.getState().role !== "idle") return;
      // Migrate only local files. Remote snapshots must keep the host's IDs
      // exactly, otherwise collaboration patches could target different clips.
      const nextBoard = migrateToRegions(deserializeBoard(opened.contents));
      replaceBoard(nextBoard);
      setDocumentPath(opened.path);
      setDocumentName(opened.name);
      markClean(nextBoard);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "The board could not be opened.");
    } finally {
      fileBusyRef.current = false;
      setFileBusy(false);
    }
  }, [markClean, replaceBoard]);

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (fileBusyRef.current) return false;
    const currentSession = useSessionStore.getState();
    if (currentSession.role === "guest" && (currentSession.status !== "online" || !currentSession.allowDownload)) return false;
    setFileBusy(true);
    fileBusyRef.current = true;
    try {
      const currentBoard = boardRef.current;
      if (currentSession.role === "guest") {
        const copy = serializeBoardCopy(currentBoard);
        return !!await saveBoardFile(copy, null, `${currentSession.title.replace(/\.board$/i, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_") || "Shared board"} copy.board`);
      }
      const contents = serializeBoard(currentBoard);
      const savedPath = await saveBoardFile(
        contents,
        documentPathRef.current,
        documentNameRef.current,
      );
      if (!savedPath) return false;
      setDocumentPath(isTauri() ? savedPath : null);
      setDocumentName(savedPath.split(/[\\/]/).pop() ?? documentNameRef.current);
      documentPathRef.current = isTauri() ? savedPath : null;
      documentNameRef.current = savedPath.split(/[\\/]/).pop() ?? documentNameRef.current;
      lastSavedRef.current = contents;
      const changedWhileSaving = serializeBoard(useBoardStore.getState().board) !== contents;
      dirtyRef.current = changedWhileSaving;
      setDirty(changedWhileSaving);
      return true;
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "The board could not be saved.");
      return false;
    } finally {
      setFileBusy(false);
      fileBusyRef.current = false;
    }
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        void handleOpen();
      } else if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [handleOpen, handleSave]);

  // Ask to save unsaved changes before the window closes.
  useEffect(() => {
    if (!isTauri()) {
      const onBeforeUnload = (event: BeforeUnloadEvent) => {
        if (!dirtyRef.current) return;
        event.preventDefault();
        event.returnValue = "";
      };
      window.addEventListener("beforeunload", onBeforeUnload);
      return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const { message } = await import("@tauri-apps/plugin-dialog");
      if (cancelled) return;
      const appWindow = getCurrentWindow();
      unlisten = await appWindow.onCloseRequested(async (event) => {
        if (!dirtyRef.current || closingRef.current) return;
        event.preventDefault();
        if (fileBusyRef.current) return;
        if (useSessionStore.getState().role === "guest") {
          await message("Your local board has unsaved changes. Leave the session to restore and save your local work before closing.", {
            title: "Unsaved local work",
            kind: "warning",
          });
          return;
        }

        const answer = await message(
          `Do you want to save changes to "${documentNameRef.current}"?`,
          {
            title: "Whiteboard",
            kind: "warning",
            buttons: {
              yes: "Save",
              no: "Don't Save",
              cancel: "Cancel",
            },
          },
        );

        if (answer === "Cancel") return;
        if (answer === "Save") {
          const saved = await handleSave();
          // Remote edits can arrive while the native save dialog/write is open.
          // Never close over a newer board than the snapshot actually saved.
          if (!saved || dirtyRef.current) return;
        }

        closingRef.current = true;
        dirtyRef.current = false;
        await appWindow.destroy();
      });
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleSave]);

  const displayName = guest ? `${session.title} · Guest` : documentName.replace(/\.board$/i, "");

  return (
    <div className="toolbar">
      <div className="toolbar-brand" title={guest ? `Local board preserved: ${documentName}${dirty ? " (unsaved)" : ""}` : documentPath ?? documentName}>
        Whiteboard · {displayName}{dirty && !guest ? " *" : ""}
      </div>

      <div className="toolbar-undo">
        <button className="tool-btn" onClick={() => void handleOpen()} disabled={fileBusy || session.role !== "idle"} title={session.role !== "idle" ? "Leave the session before opening another board" : "Open (Ctrl+O)"}>
          Open
        </button>
        <button className="tool-btn" onClick={() => void handleSave()} disabled={fileBusy || (guest && (session.status !== "online" || !session.allowDownload))} title={guest ? "Download an independent copy (Ctrl+S)" : "Save (Ctrl+S)"}>
          {guest ? "Save copy" : "Save"}
        </button>
      </div>

      {/* Tool buttons */}
      <div className="toolbar-tools">
        {TOOLS.slice(0, 1).map((t) => (
          <button
            key={t.id}
            className={`tool-btn${tool === t.id ? " tool-active" : ""}`}
            title={t.title}
            onClick={() => handleToolClick(t.id)}
          >
            {t.label}
          </button>
        ))}
        {editable && <ShapeMenu tool={tool} onSelect={handleToolClick} />}
        {TOOLS.slice(1).map((t) => (
          <button
            key={t.id}
            className={`tool-btn${tool === t.id ? " tool-active" : ""}`}
            title={t.title}
            disabled={!editable}
            onClick={() => handleToolClick(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Undo / Redo */}
      <div className="toolbar-undo">
        <button
          className="tool-btn"
          onClick={undo}
          disabled={!editable || _past.length === 0}
          title="Undo (Ctrl+Z)"
        >
          ↩
        </button>
        <button
          className="tool-btn"
          onClick={redo}
          disabled={!editable || _future.length === 0}
          title="Redo (Ctrl+Y)"
        >
          ↪
        </button>
      </div>

      {/* Zoom controls */}
      <div className="toolbar-zoom">
        <button className="tool-btn" onClick={() => zoomTo(1 / 1.4)} title="Zoom out">−</button>
        <button className="zoom-pct" onClick={resetZoom} title="Reset zoom">
          {Math.round(zoom * 100)}%
        </button>
        <button className="tool-btn" onClick={() => zoomTo(1.4)} title="Zoom in">+</button>
      </div>

      {/* Current zoom region */}
      <div className="toolbar-tier">
        {activeBp
          ? (
            <span
              className="tier-badge bp"
              style={{ "--keyframe-color": breakpointColor(board.breakpoints, activeBp.id) } as CSSProperties}
            >
              {activeBp.name}
            </span>
          )
          : <span className="tier-badge base">All zoom levels</span>}
      </div>

      {/* Keyboard shortcut hint */}
      <div className="toolbar-hint">V · R · T · S · F · C drag to connect · Ctrl+G group · Shift+click multi</div>
      <button type="button" className={`tool-btn session-toggle${sessionPanelOpen ? " tool-active" : ""}`} aria-expanded={sessionPanelOpen} onClick={() => setSessionPanelOpen((open) => !open)}>
        {session.role === "idle" ? "Share / Join" : `${session.role === "host" ? "Hosting" : "Session"} · ${session.status}`}
      </button>
      <SupportButton />
      {session.error && !sessionPanelOpen && (
        <div className="session-notice" role="alert">
          <span>{session.error}</span>
          <button type="button" onClick={() => setSessionPanelOpen(true)}>Session</button>
          <button type="button" onClick={() => useSessionStore.setState({ error: null })} aria-label="Dismiss session notice">×</button>
        </div>
      )}
      {sessionPanelOpen && <SessionPanel documentName={documentName} fileBusy={fileBusy} inviteInput={inviteInput} onClose={() => setSessionPanelOpen(false)} />}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const editingLocked = useSessionStore((state) =>
    state.role === "guest" && (state.status !== "online" || !state.allowEditing));
  const tool = useBoardStore((state) => state.tool);
  const setTool = useBoardStore((state) => state.setTool);
  return (
    <div
      className="app"
      onPointerDownCapture={(event) => {
        if (tool === "select") return;
        const target = event.target as HTMLElement;
        if (target.closest([
          ".canvas-wrapper",
          ".shape-menu",
          ".timeline-track",
          ".zr-track",
          "[data-layer-row]",
          "[role='dialog']",
          "[role='button']",
          "[role='option']",
          "button",
          "input",
          "textarea",
          "select",
          "a",
          "label",
          "[contenteditable='true']",
        ].join(","))) return;
        setTool("select");
      }}
    >
      <div className="app-toolbar"><Toolbar /></div>
      <div className="app-layers" inert={editingLocked}><LayersPanel /></div>
      <div className="app-canvas"><BoardCanvas /></div>
      <div className="app-props" inert={editingLocked}><PropsPanel /></div>
      <div className="app-timeline"><ZoomTimeline /></div>
    </div>
  );
}
