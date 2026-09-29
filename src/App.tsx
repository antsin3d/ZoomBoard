import { useCallback, useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import BoardCanvas, { useZoomControls } from "./canvas/BoardCanvas";
import ZoomTimeline from "./panels/ZoomTimeline";
import LayersPanel from "./panels/LayersPanel";
import PropsPanel from "./panels/PropsPanel";
import { useBoardStore } from "./whiteboard/store";
import { TIERS } from "./whiteboard/tiers";
import { deserializeBoard, serializeBoard } from "./whiteboard/document";
import { openBoardFile, saveBoardFile } from "./whiteboard/fileIO";
import { isTauri } from "@tauri-apps/api/core";
import { breakpointColor, type ShapeType, type ToolMode } from "./whiteboard/model";

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
  const active = SHAPE_TOOLS.find((shape) => shape.id === lastShape) ?? SHAPE_TOOLS[0];

  useEffect(() => {
    if (SHAPE_TOOLS.some((shape) => shape.id === tool)) setLastShape(tool as ShapeType);
  }, [tool]);

  return (
    <div
      className="shape-menu"
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className={`tool-btn shape-menu-trigger${SHAPE_TOOLS.some((shape) => shape.id === tool) ? " tool-active" : ""}`}
        title={`${active.title} · Click to select and show more shapes`}
        onClick={() => {
          onSelect(lastShape);
          setOpen((wasOpen) => !wasOpen);
        }}
      >
        <span>{active.label}</span><span className="shape-menu-caret">⌄</span>
      </button>
      {open && (
        <div className="shape-menu-popover">
          {SHAPE_TOOLS.map((shape) => (
            <button
              key={shape.id}
              type="button"
              className={`shape-choice${tool === shape.id ? " shape-choice-active" : ""}`}
              title={shape.title}
              onClick={() => {
                setLastShape(shape.id);
                onSelect(shape.id);
                setOpen(false);
              }}
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
  const {
    tool, setTool, zoom, activeTier, board, activeBreakpointId,
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
  const lastSavedRef = useRef(serializeBoard(board));
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
      if (state.board === prev.board) return;
      const isDirty = serializeBoard(state.board) !== lastSavedRef.current;
      dirtyRef.current = isDirty;
      setDirty(isDirty);
    });
  }, []);

  const activeTierObj = TIERS.find((t) => t.id === activeTier);
  // Use the store's zone-aware activeBreakpointId — not a manual cascade lookup.
  const activeBp = board.breakpoints.find((bp) => bp.id === activeBreakpointId);

  const handleToolClick = useCallback((nextTool: ToolMode) => {
    if (nextTool === "connector" && connectSelected()) {
      setTool("select");
      return;
    }
    setTool(nextTool);
  }, [connectSelected, setTool]);

  const handleOpen = useCallback(async () => {
    if (fileBusy) return;
    setFileBusy(true);
    try {
      const opened = await openBoardFile();
      if (!opened) return;
      const nextBoard = deserializeBoard(opened.contents);
      replaceBoard(nextBoard);
      setDocumentPath(opened.path);
      setDocumentName(opened.name);
      markClean(nextBoard);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "The board could not be opened.");
    } finally {
      setFileBusy(false);
    }
  }, [fileBusy, markClean, replaceBoard]);

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (fileBusyRef.current) return false;
    setFileBusy(true);
    fileBusyRef.current = true;
    try {
      const currentBoard = boardRef.current;
      const savedPath = await saveBoardFile(
        serializeBoard(currentBoard),
        documentPathRef.current,
        documentNameRef.current,
      );
      if (!savedPath) return false;
      setDocumentPath(savedPath);
      setDocumentName(savedPath.split(/[\\/]/).pop() ?? documentNameRef.current);
      documentPathRef.current = savedPath;
      documentNameRef.current = savedPath.split(/[\\/]/).pop() ?? documentNameRef.current;
      markClean(currentBoard);
      return true;
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "The board could not be saved.");
      return false;
    } finally {
      setFileBusy(false);
      fileBusyRef.current = false;
    }
  }, [markClean]);

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
          if (!saved) return;
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

  const displayName = documentName.replace(/\.board$/i, "");

  return (
    <div className="toolbar">
      <div className="toolbar-brand" title={documentPath ?? documentName}>
        Whiteboard · {displayName}{dirty ? " *" : ""}
      </div>

      <div className="toolbar-undo">
        <button className="tool-btn" onClick={() => void handleOpen()} disabled={fileBusy} title="Open (Ctrl+O)">
          Open
        </button>
        <button className="tool-btn" onClick={() => void handleSave()} disabled={fileBusy} title="Save (Ctrl+S)">
          Save
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
        <ShapeMenu tool={tool} onSelect={handleToolClick} />
        {TOOLS.slice(1).map((t) => (
          <button
            key={t.id}
            className={`tool-btn${tool === t.id ? " tool-active" : ""}`}
            title={t.title}
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
          disabled={_past.length === 0}
          title="Undo (Ctrl+Z)"
        >
          ↩
        </button>
        <button
          className="tool-btn"
          onClick={redo}
          disabled={_future.length === 0}
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

      {/* Zone indicator — Base when between breakpoints, breakpoint name otherwise */}
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
          : <span className="tier-badge base">Base · {activeTierObj?.name}</span>}
      </div>

      {/* Keyboard shortcut hint */}
      <div className="toolbar-hint">V · R · T · S · F · C drag to connect · Ctrl+G group · Shift+click multi</div>
      <SupportButton />
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <div className="app">
      <div className="app-toolbar"><Toolbar /></div>
      <div className="app-layers"><LayersPanel /></div>
      <div className="app-canvas"><BoardCanvas /></div>
      <div className="app-props"><PropsPanel /></div>
      <div className="app-timeline"><ZoomTimeline /></div>
    </div>
  );
}
