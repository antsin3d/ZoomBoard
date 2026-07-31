import { useCallback, useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import BoardCanvas, { useZoomControls } from "./canvas/BoardCanvas";
import ZoomTimeline from "./panels/ZoomTimeline";
import LayersPanel from "./panels/LayersPanel";
import PropsPanel from "./panels/PropsPanel";
import { useBoardStore } from "./whiteboard/store";
import { TIERS } from "./whiteboard/tiers";
import { deserializeBoard, serializeBoard } from "./whiteboard/document";
import { openBoardFile, saveBoardFile } from "./whiteboard/fileIO";
import { breakpointColor, type ShapeType, type ToolMode } from "./whiteboard/model";

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
  const hoverTimer = useRef<number | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const longPressTriggered = useRef(false);
  const active = SHAPE_TOOLS.find((shape) => shape.id === lastShape) ?? SHAPE_TOOLS[0];

  useEffect(() => {
    if (SHAPE_TOOLS.some((shape) => shape.id === tool)) setLastShape(tool as ShapeType);
  }, [tool]);

  const clearTimer = (timer: { current: number | null }) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  return (
    <div
      className="shape-menu"
      onMouseEnter={() => {
        clearTimer(hoverTimer);
        hoverTimer.current = window.setTimeout(() => setOpen(true), 250);
      }}
      onMouseLeave={() => {
        clearTimer(hoverTimer);
        setOpen(false);
      }}
    >
      <button
        type="button"
        className={`tool-btn shape-menu-trigger${SHAPE_TOOLS.some((shape) => shape.id === tool) ? " tool-active" : ""}`}
        title={`${active.title} · Hover or hold for more shapes`}
        onPointerDown={() => {
          clearTimer(longPressTimer);
          longPressTriggered.current = false;
          longPressTimer.current = window.setTimeout(() => {
            longPressTriggered.current = true;
            setOpen(true);
          }, 450);
        }}
        onPointerUp={() => clearTimer(longPressTimer)}
        onPointerCancel={() => clearTimer(longPressTimer)}
        onClick={() => {
          clearTimer(hoverTimer);
          if (longPressTriggered.current) {
            longPressTriggered.current = false;
            return;
          }
          setOpen(false);
          onSelect(lastShape);
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
      replaceBoard(deserializeBoard(opened.contents));
      setDocumentPath(opened.path);
      setDocumentName(opened.name);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "The board could not be opened.");
    } finally {
      setFileBusy(false);
    }
  }, [fileBusy, replaceBoard]);

  const handleSave = useCallback(async () => {
    if (fileBusy) return;
    setFileBusy(true);
    try {
      const savedPath = await saveBoardFile(serializeBoard(board), documentPath, documentName);
      if (savedPath) {
        setDocumentPath(savedPath);
        setDocumentName(savedPath.split(/[\\/]/).pop() ?? documentName);
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "The board could not be saved.");
    } finally {
      setFileBusy(false);
    }
  }, [board, documentName, documentPath, fileBusy]);

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

  return (
    <div className="toolbar">
      <div className="toolbar-brand" title={documentPath ?? documentName}>
        Whiteboard · {documentName.replace(/\.board$/i, "")}
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
      <div className="toolbar-hint">V · R · T · S · F · C · Ctrl+G group · Shift+click multi</div>
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
