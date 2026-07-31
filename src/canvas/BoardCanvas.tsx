import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Stage, Layer, Line as KonvaLine, Rect as KonvaRect, Group as KonvaGroup, Transformer } from "react-konva";
import type Konva from "konva";
import { useBoardStore } from "../whiteboard/store";
import {
  BASE_KEYFRAME_ID,
  resolveState,
  type ElementState,
  type BoardElement,
  type ElementType,
  type ToolMode,
} from "../whiteboard/model";
import ElementNode from "./ElementNode";
import {
  canvasDropTargetAt,
  effectiveSelectionRoots,
  isCanvasDropTarget,
  isContainer,
  outermostGroupAncestor,
  rendersAsContainer,
  resolveConnectorState,
  worldBoundsAtZoom,
} from "../whiteboard/geometry";

const ZOOM_FACTOR = 1.08;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const BBOX_PAD = 8;
const DEFAULT_STICKY_SIZE = 180;

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function screenToWorld(sx: number, sy: number, panX: number, panY: number, zoom: number) {
  return { x: (sx - panX) / zoom, y: (sy - panY) / zoom };
}

function toolToElementType(tool: ToolMode): ElementType | null {
  return tool === "select" ? null : tool;
}

// ─── GroupNode ────────────────────────────────────────────────────────────────
// Renders a group element as a Konva.Group so that:
//  • The group's position / rotation / opacity are additive on top of children.
//  • Setting group.visible = false hides all children (via the Konva layer,
//    not by mutating children's stored visibility).
//  • A dashed bounding box is shown when the group or any of its children are
//    selected.

interface GroupNodeProps {
  group: BoardElement;
  groupState: ElementState;
  childElements: BoardElement[];
  selectedIds: string[];
  zoom: number;
  isSelected: boolean;
  anyChildSelected: boolean;
  onSelect: (id: string, addToSelection?: boolean) => void;
  onDragEnd: (id: string, x: number, y: number) => void;
  onAltDragStart: (id: string) => void;
  onDragProgress: (id: string) => void;
  resolveEl: (id: string) => ElementState | null;
  registerNode: (id: string, node: Konva.Group | null) => void;
}

interface LocalBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

function getContainerLocalBounds(
  group: BoardElement,
  groupState: ElementState,
  childElements: BoardElement[],
  resolveEl: (id: string) => ElementState | null,
): LocalBounds | null {
  // Pure groups size to their children; frames and other nestable parents keep
  // their authored bounds so dropping under a shape uses that shape's box.
  if (group.type !== "group") {
    return { x: 0, y: 0, w: groupState.width, h: groupState.height };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const child of childElements) {
    const state = resolveEl(child.id);
    if (!state?.visible) continue;
    minX = Math.min(minX, state.x);
    minY = Math.min(minY, state.y);
    maxX = Math.max(maxX, state.x + state.width);
    maxY = Math.max(maxY, state.y + state.height);
  }
  return isFinite(minX)
    ? {
        x: minX - BBOX_PAD,
        y: minY - BBOX_PAD,
        w: maxX - minX + BBOX_PAD * 2,
        h: maxY - minY + BBOX_PAD * 2,
      }
    : null;
}

function GroupNode({
  group, groupState, childElements, selectedIds, zoom,
  isSelected, anyChildSelected, onSelect, onDragEnd, onAltDragStart, onDragProgress,
  resolveEl, registerNode,
}: GroupNodeProps) {
  const shiftHeld = useBoardStore((s) => s.shiftHeld);
  const allElements = useBoardStore((s) => s.board.elements);
  const groupRef = useRef<Konva.Group>(null);
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const axisLock = useRef<"x" | "y" | null>(null);

  useEffect(() => {
    const node = groupRef.current;
    if (node) registerNode(group.id, node);
    return () => registerNode(group.id, null);
  }, [group.id, registerNode]);

  // Compute the bounding box of visible children IN the group's local coordinate
  // space (children are stored relative to the group origin).
  const bbox = useMemo(
    () => getContainerLocalBounds(group, groupState, childElements, resolveEl),
    [childElements, group, groupState, resolveEl],
  );

  // When the group is invisible, the Konva Group (and thus all children) will
  // not render — this is the "group visibility overrides content" behaviour.
  if (!groupState.visible || groupState.opacity <= 0) return null;

  const showBbox = isSelected || anyChildSelected;
  const bboxStroke = isSelected ? "#8b5cf6" : "#94a3b8";
  const sw = 1.5 / zoom;
  const dashArr = [8 / zoom, 5 / zoom];
  const framePivotX = group.type !== "group" ? groupState.width / 2 : 0;
  const framePivotY = group.type !== "group" ? groupState.height / 2 : 0;
  const groupAncestorId = outermostGroupAncestor(allElements, group.id);
  const canDrag = !groupAncestorId || isSelected;

  return (
    <KonvaGroup
      ref={groupRef}
      _useStrictMode={group.type === "group"}
      x={groupState.x + framePivotX}
      y={groupState.y + framePivotY}
      offsetX={framePivotX}
      offsetY={framePivotY}
      width={groupState.width}
      height={groupState.height}
      rotation={groupState.rotation}
      opacity={groupState.opacity}
      draggable={canDrag}
      // Konva drag events bubble; ignore the ones belonging to child nodes.
      onDragStart={(e) => {
        if (e.target !== groupRef.current) return;
        if (!isSelected) onSelect(group.id);
        if (e.evt.altKey) onAltDragStart(group.id);
        dragStartPos.current = {
          x: groupRef.current?.x() ?? groupState.x,
          y: groupRef.current?.y() ?? groupState.y,
        };
        axisLock.current = null;
      }}
      onDragMove={(e) => {
        if (e.target !== groupRef.current) return;
        const node = groupRef.current;
        const start = dragStartPos.current;
        if (node && start && shiftHeld) {
          const dx = Math.abs(node.x() - start.x);
          const dy = Math.abs(node.y() - start.y);
          if (!axisLock.current && (dx > 5 || dy > 5)) {
            axisLock.current = dx > dy ? "x" : "y";
          }
          if (axisLock.current === "x") node.y(start.y);
          if (axisLock.current === "y") node.x(start.x);
        }
        onDragProgress(group.id);
      }}
      onDragEnd={(e) => {
        if (e.target !== groupRef.current) return;
        axisLock.current = null;
        dragStartPos.current = null;
        onDragEnd(group.id, e.target.x() - framePivotX, e.target.y() - framePivotY);
      }}
    >
      {bbox && (
        <KonvaRect
          x={bbox.x}
          y={bbox.y}
          width={bbox.w}
          height={bbox.h}
          fill={groupState.fill}
          stroke={groupState.stroke}
          strokeWidth={groupState.strokeWidth}
          listening={false}
        />
      )}

      {/* Child elements — inherit the group's transform */}
      {childElements.map((child) => {
        const cState = resolveEl(child.id);
        if (!cState) return null;
        if (rendersAsContainer(useBoardStore.getState().board, child)) {
          const nestedChildren = useBoardStore.getState().board.elements.filter(
            (candidate) => candidate.parentId === child.id,
          );
          return (
            <GroupNode
              key={child.id}
              group={child}
              groupState={cState}
              childElements={nestedChildren}
              selectedIds={selectedIds}
              zoom={zoom}
              isSelected={selectedIds.includes(child.id)}
              anyChildSelected={nestedChildren.some((candidate) => selectedIds.includes(candidate.id))}
              onSelect={onSelect}
              onDragEnd={onDragEnd}
              onAltDragStart={onAltDragStart}
              onDragProgress={onDragProgress}
              resolveEl={resolveEl}
              registerNode={registerNode}
            />
          );
        }
        return (
          <ElementNode
            key={child.id}
            element={child}
            state={cState}
            isSelected={selectedIds.includes(child.id)}
            onSelect={onSelect}
            onDragEnd={onDragEnd}
            onAltDragStart={onAltDragStart}
            onDragProgress={onDragProgress}
            registerNode={registerNode}
          />
        );
      })}

      {/* Bounding box outline — rendered on top so it's always visible */}
      {bbox && showBbox && (
        <KonvaRect
          x={bbox.x}
          y={bbox.y}
          width={bbox.w}
          height={bbox.h}
          fill="transparent"
          stroke={bboxStroke}
          strokeWidth={sw}
          dash={dashArr}
          cornerRadius={6}
          listening={false}
        />
      )}

    </KonvaGroup>
  );
}

// Group/frame backgrounds use a dedicated hit tree rendered before every
// ordinary element. This keeps their visual z-order intact while allowing
// visible objects behind an empty part of a container to receive the click.
interface GroupHitNodeProps {
  group: BoardElement;
  groupState: ElementState;
  childElements: BoardElement[];
  selectedIds: string[];
  onSelect: (id: string, addToSelection?: boolean) => void;
  onDragEnd: (id: string, x: number, y: number) => void;
  onAltDragStart: (id: string) => void;
  onDragProgress: (id: string) => void;
  onDragMoveVisual: (id: string, x: number, y: number) => void;
  resolveEl: (id: string) => ElementState | null;
}

function GroupHitNode({
  group, groupState, childElements, selectedIds,
  onSelect, onDragEnd, onAltDragStart, onDragProgress, onDragMoveVisual, resolveEl,
}: GroupHitNodeProps) {
  const shiftHeld = useBoardStore((state) => state.shiftHeld);
  const allElements = useBoardStore((state) => state.board.elements);
  const hitRef = useRef<Konva.Group>(null);
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const axisLock = useRef<"x" | "y" | null>(null);
  const bbox = useMemo(
    () => getContainerLocalBounds(group, groupState, childElements, resolveEl),
    [childElements, group, groupState, resolveEl],
  );

  if (!bbox || !groupState.visible || groupState.opacity <= 0) return null;

  const groupAncestorId = outermostGroupAncestor(allElements, group.id);
  const isSelected = selectedIds.includes(group.id);
  const firstClickTarget = groupAncestorId ?? group.id;
  const canDrag = !groupAncestorId || isSelected;
  const framePivotX = group.type !== "group" ? groupState.width / 2 : 0;
  const framePivotY = group.type !== "group" ? groupState.height / 2 : 0;

  return (
    <KonvaGroup
      ref={hitRef}
      x={groupState.x + framePivotX}
      y={groupState.y + framePivotY}
      offsetX={framePivotX}
      offsetY={framePivotY}
      width={groupState.width}
      height={groupState.height}
      rotation={groupState.rotation}
      draggable={canDrag}
      // Konva drag events bubble; ignore the ones belonging to child nodes.
      onDragStart={(event) => {
        if (event.target !== hitRef.current) return;
        if (!isSelected) onSelect(group.id);
        if (event.evt.altKey) onAltDragStart(group.id);
        dragStartPos.current = {
          x: hitRef.current?.x() ?? groupState.x,
          y: hitRef.current?.y() ?? groupState.y,
        };
        axisLock.current = null;
      }}
      onDragMove={(event) => {
        if (event.target !== hitRef.current) return;
        const node = hitRef.current;
        const start = dragStartPos.current;
        if (!node || !start) return;
        if (shiftHeld) {
          const dx = Math.abs(node.x() - start.x);
          const dy = Math.abs(node.y() - start.y);
          if (!axisLock.current && (dx > 5 || dy > 5)) {
            axisLock.current = dx > dy ? "x" : "y";
          }
          if (axisLock.current === "x") node.y(start.y);
          if (axisLock.current === "y") node.x(start.x);
        }
        onDragMoveVisual(group.id, node.x(), node.y());
        onDragProgress(group.id);
      }}
      onDragEnd={(event) => {
        if (event.target !== hitRef.current) return;
        axisLock.current = null;
        dragStartPos.current = null;
        onDragEnd(group.id, event.target.x() - framePivotX, event.target.y() - framePivotY);
      }}
    >
      <KonvaRect
        x={bbox.x}
        y={bbox.y}
        width={bbox.w}
        height={bbox.h}
        fill="rgba(0,0,0,0.001)"
        stroke="transparent"
        strokeWidth={0}
        cornerRadius={6}
        onClick={(event) => {
          event.cancelBubble = true;
          onSelect(
            firstClickTarget,
            event.evt.shiftKey || event.evt.ctrlKey || event.evt.metaKey,
          );
        }}
        onDblClick={(event) => {
          event.cancelBubble = true;
          onSelect(group.id, event.evt.shiftKey || event.evt.ctrlKey || event.evt.metaKey);
        }}
        onTap={(event) => {
          event.cancelBubble = true;
          onSelect(firstClickTarget);
        }}
      />

      {childElements
        .filter((child) => isContainer(child) || allElements.some((candidate) => candidate.parentId === child.id))
        .map((child) => {
        const childState = resolveEl(child.id);
        if (!childState) return null;
        return (
          <GroupHitNode
            key={child.id}
            group={child}
            groupState={childState}
            childElements={allElements.filter((candidate) => candidate.parentId === child.id)}
            selectedIds={selectedIds}
            onSelect={onSelect}
            onDragEnd={onDragEnd}
            onAltDragStart={onAltDragStart}
            onDragProgress={onDragProgress}
            onDragMoveVisual={onDragMoveVisual}
            resolveEl={resolveEl}
          />
        );
      })}
    </KonvaGroup>
  );
}

// ─── BoardCanvas ──────────────────────────────────────────────────────────────

interface DrawDragState { startX: number; startY: number; currentX: number; currentY: number; }
interface MarqueeState  { startX: number; startY: number; curX: number;     curY: number;     }

export default function BoardCanvas() {
  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const nodeMapRef = useRef<Map<string, Konva.Group>>(new Map());
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [drawDrag, setDrawDrag] = useState<DrawDragState | null>(null);
  const [marqueeDrag, setMarqueeDrag] = useState<MarqueeState | null>(null);

  const spaceHeld = useRef(false);
  const isPanning = useRef(false);
  const panStartRef = useRef({ mx: 0, my: 0, px: 0, py: 0 });

  const dropHighlightRef = useRef<Konva.Rect>(null);
  const dropTargetIdRef = useRef<string | null>(null);

  const {
    board, zoom, panX, panY,
    selectedIds, tool,
    setZoom, setPan, setTool, selectElement, clearSelection, setSelectedIds,
    addElement, createFrame, reparentElements, setKeyframe, moveSelectedBy,
    groupSelected, ungroup, resolve, setShiftHeld,
    undo, redo, copySelected, pasteClipboard, duplicateSelected, connectSelected,
  } = useBoardStore();

  const resolveCanvasElement = useCallback((id: string): ElementState | null => {
    const element = board.elements.find((candidate) => candidate.id === id);
    if (!element) return null;
    return element.type === "connector"
      ? resolveConnectorState(board, element, zoom)
      : resolve(id);
  }, [board, resolve, zoom]);

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Track Shift and Space keys globally.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target as HTMLElement)?.matches?.("input,textarea")) {
        spaceHeld.current = true;
      }
      if (e.key === "Shift") setShiftHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceHeld.current = false;
      if (e.key === "Shift") setShiftHeld(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [setShiftHeld]);

  // Wheel zoom — anchored to pointer.
  const handleWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const pointer = stage.getPointerPosition() ?? { x: size.w / 2, y: size.h / 2 };
    const dir = e.evt.deltaY > 0 ? -1 : 1;
    const newZoom = clamp(dir > 0 ? zoom * ZOOM_FACTOR : zoom / ZOOM_FACTOR, MIN_ZOOM, MAX_ZOOM);
    const worldX = (pointer.x - panX) / zoom;
    const worldY = (pointer.y - panY) / zoom;
    setZoom(newZoom);
    setPan(pointer.x - worldX * newZoom, pointer.y - worldY * newZoom);
  }, [zoom, panX, panY, size, setZoom, setPan]);

  // Mousedown: start pan (right-click or space+left) or marquee/draw.
  const handleMouseDown = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = stageRef.current;
    if (!stage) return;
    const ptr = stage.getPointerPosition();
    if (!ptr) return;

    // Right-click OR space+left = pan
    if (e.evt.button === 2 || (e.evt.button === 0 && spaceHeld.current)) {
      e.evt.preventDefault();
      isPanning.current = true;
      panStartRef.current = { mx: e.evt.clientX, my: e.evt.clientY, px: panX, py: panY };
      if (stage.container()) stage.container().style.cursor = "grabbing";
      return;
    }

    if (tool === "select") {
      if (e.target === stage) {
        stage.stopDrag();
        const world = screenToWorld(ptr.x, ptr.y, panX, panY, zoom);
        setMarqueeDrag({ startX: world.x, startY: world.y, curX: world.x, curY: world.y });
        if (!e.evt.shiftKey) clearSelection();
      }
      return;
    }

    if (e.target === stage) {
      const world = screenToWorld(ptr.x, ptr.y, panX, panY, zoom);
      setDrawDrag({ startX: world.x, startY: world.y, currentX: world.x, currentY: world.y });
    }
  }, [tool, panX, panY, zoom, clearSelection]);

  const handleMouseMove = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = stageRef.current;
    if (!stage) return;
    const ptr = stage.getPointerPosition();
    if (!ptr) return;

    if (isPanning.current) {
      const dx = e.evt.clientX - panStartRef.current.mx;
      const dy = e.evt.clientY - panStartRef.current.my;
      setPan(panStartRef.current.px + dx, panStartRef.current.py + dy);
      return;
    }

    const world = screenToWorld(ptr.x, ptr.y, panX, panY, zoom);

    if (marqueeDrag) {
      setMarqueeDrag((d) => d ? { ...d, curX: world.x, curY: world.y } : null);
      return;
    }
    if (drawDrag) {
      setDrawDrag((d) => d ? { ...d, currentX: world.x, currentY: world.y } : null);
      e.evt.preventDefault();
    }
  }, [marqueeDrag, drawDrag, panX, panY, zoom, setPan]);

  const handleMouseUp = useCallback(() => {
    if (isPanning.current) {
      isPanning.current = false;
      const stage = stageRef.current;
      if (stage?.container()) {
        const tool = useBoardStore.getState().tool;
        stage.container().style.cursor = tool === "select" ? "default" : "crosshair";
      }
      return;
    }

    if (marqueeDrag) {
      const mx = Math.min(marqueeDrag.startX, marqueeDrag.curX);
      const my = Math.min(marqueeDrag.startY, marqueeDrag.curY);
      const mw = Math.abs(marqueeDrag.curX - marqueeDrag.startX);
      const mh = Math.abs(marqueeDrag.curY - marqueeDrag.startY);

      if (mw > 4 && mh > 4) {
        const inBounds = board.elements.filter((el) => {
          if (el.type === "group") return false;
          const state = resolveCanvasElement(el.id);
          if (!state?.visible) return false;
          // For grouped elements, account for their group's position offset.
          const parent = el.parentId ? board.elements.find((g) => g.id === el.parentId) : null;
          const pState = parent ? resolveCanvasElement(parent.id) : null;
          const worldX = (pState?.x ?? 0) + state.x;
          const worldY = (pState?.y ?? 0) + state.y;
          return (
            worldX < mx + mw && worldX + state.width > mx &&
            worldY < my + mh && worldY + state.height > my
          );
        });
        if (inBounds.length > 0) setSelectedIds(inBounds.map((el) => el.id));
      }
      setMarqueeDrag(null);
      return;
    }

    if (drawDrag) {
      const x = Math.min(drawDrag.startX, drawDrag.currentX);
      const y = Math.min(drawDrag.startY, drawDrag.currentY);
      const w = Math.abs(drawDrag.currentX - drawDrag.startX);
      const h = Math.abs(drawDrag.currentY - drawDrag.startY);
      const elementType = toolToElementType(tool);
      if (elementType === "sticky" && (w <= 4 || h <= 4)) {
        addElement("sticky", {
          x: drawDrag.startX - DEFAULT_STICKY_SIZE / 2,
          y: drawDrag.startY - DEFAULT_STICKY_SIZE / 2,
          width: DEFAULT_STICKY_SIZE,
          height: DEFAULT_STICKY_SIZE,
        });
      } else if (w > 4 && h > 4 && elementType) {
        if (elementType === "frame") {
          createFrame({ x, y, width: w, height: h });
        } else {
          addElement(elementType, { x, y, width: w, height: h } as Partial<ElementState>);
        }
      }
      setDrawDrag(null);
    }
  }, [
    marqueeDrag, drawDrag, tool, board.elements, resolveCanvasElement,
    setSelectedIds, addElement, createFrame,
  ]);

  // The elements a drag started on `id` actually moves, and the frame the
  // pointer is currently over (null = bare canvas).
  const resolveDrop = useCallback((id: string) => {
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    const { board: b, zoom: z, panX: px, panY: py, selectedIds: sids } = useBoardStore.getState();
    const element = b.elements.find((candidate) => candidate.id === id);
    const movesSelection =
      !!element
      && sids.includes(id)
      && sids.length > 1
      && !(element.parentId && sids.includes(element.parentId));
    const roots = movesSelection
      ? effectiveSelectionRoots(b, sids)
      : element ? [element] : [];
    if (!pointer) return { roots, movesSelection, targetId: null as string | null, known: false };
    const world = screenToWorld(pointer.x, pointer.y, px, py, z);
    const target = canvasDropTargetAt(b, world, z, roots.map((root) => root.id));
    return { roots, movesSelection, targetId: target?.id ?? null, known: true };
  }, []);

  const paintDropHighlight = useCallback((targetId: string | null) => {
    if (dropTargetIdRef.current === targetId) return;
    dropTargetIdRef.current = targetId;
    const rect = dropHighlightRef.current;
    if (!rect) return;
    const { board: b, zoom: z } = useBoardStore.getState();
    const target = targetId ? b.elements.find((element) => element.id === targetId) : undefined;
    if (!target) {
      rect.visible(false);
    } else {
      const bounds = worldBoundsAtZoom(b, target, z);
      rect.setAttrs({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        strokeWidth: 2.5 / z,
        cornerRadius: 4 / z,
        visible: true,
      });
    }
    rect.getLayer()?.batchDraw();
  }, []);

  // Highlight the frame under the pointer, Miro-style, while something is dragged.
  const handleDragProgress = useCallback((id: string) => {
    const { roots, targetId } = resolveDrop(id);
    const alreadyInside =
      targetId !== null && roots.every((root) => (root.parentId ?? null) === targetId);
    paintDropHighlight(alreadyInside ? null : targetId);
  }, [paintDropHighlight, resolveDrop]);

  // Element / group drag end — handles multi-select too.
  const handleDragEnd = useCallback((id: string, newX: number, newY: number) => {
    const { board: b, zoom: z, activeBreakpointId: abpId } = useBoardStore.getState();
    const kfId = abpId ?? BASE_KEYFRAME_ID;
    const el = b.elements.find((element) => element.id === id);
    const drop = resolveDrop(id);
    paintDropHighlight(null);
    if (!el) return;

    if (drop.movesSelection) {
      const resolved = resolveState(el, z, b.breakpoints);
      moveSelectedBy(newX - resolved.x, newY - resolved.y);
    } else {
      // A dragged child wins over a simultaneously-selected parent: moving the
      // parent here would teleport the whole hierarchy by the child's
      // local-coordinate delta.
      setKeyframe(id, kfId, { x: newX, y: newY });
    }

    if (!drop.known) return;
    const current = useBoardStore.getState().board;
    const adopt = drop.roots.filter((root) => (root.parentId ?? null) !== drop.targetId);
    if (!adopt.length) return;

    if (drop.targetId) {
      // Folding into the previous history entry keeps move + adopt one undo step.
      reparentElements(adopt.map((root) => root.id), drop.targetId, false);
      return;
    }
    // Only frames release their children on drop; group membership is explicit.
    const released = adopt.filter((root) => {
      const parent = current.elements.find((element) => element.id === root.parentId);
      return parent ? isCanvasDropTarget(parent) : false;
    });
    if (released.length) reparentElements(released.map((root) => root.id), null, false);
  }, [moveSelectedBy, paintDropHighlight, reparentElements, resolveDrop, setKeyframe]);

  const handleAltDragStart = useCallback((id: string) => {
    const { selectedIds: sids } = useBoardStore.getState();
    if (!sids.includes(id)) selectElement(id);
    // Leave exact copies at the starting position while the currently selected
    // originals continue through the active drag operation.
    duplicateSelected(0, 0, false);
  }, [duplicateSelected, selectElement]);

  // ── Resize / rotate via Konva Transformer ─────────────────────────────────

  // Stable callback passed to every ElementNode so they register their Konva
  // Group node in the map. The Transformer then attaches to the right node.
  const registerNode = useCallback((id: string, node: Konva.Group | null) => {
    if (node) {
      nodeMapRef.current.set(id, node);
      const state = useBoardStore.getState();
      const selected = state.selectedIds.length === 1 && state.selectedIds[0] === id;
      const element = state.board.elements.find((candidate) => candidate.id === id);
      const transformable = element
        && element.type !== "group"
        && !(element.type === "connector" && (element.connectorStartId || element.connectorEndId));
      if (selected && state.tool === "select" && transformable && transformerRef.current) {
        transformerRef.current.nodes([node]);
        transformerRef.current.getLayer()?.batchDraw();
      }
    } else {
      nodeMapRef.current.delete(id);
    }
  }, []);

  const handleGroupHitDragMove = useCallback((id: string, x: number, y: number) => {
    const visualNode = nodeMapRef.current.get(id);
    if (!visualNode) return;
    visualNode.position({ x, y });
    transformerRef.current?.forceUpdate();
    visualNode.getLayer()?.batchDraw();
  }, []);

  // Attach / detach the Transformer whenever selection or tool changes.
  useEffect(() => {
    const tr = transformerRef.current;
    if (!tr) return;
    const { board: b, selectedIds: sids, tool: t } = useBoardStore.getState();
    const single = sids.length === 1 && t === "select";
    const el = single ? b.elements.find((e) => e.id === sids[0]) : null;
    const showTr = single
      && el
      && el.type !== "group"
      && !(el.type === "connector" && (el.connectorStartId || el.connectorEndId));
    const node = showTr ? nodeMapRef.current.get(sids[0]) : null;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selectedIds, tool, board.elements]);

  // When a transform ends, convert Konva's scale+position back to our top-left
  // coordinate convention (same as the center-pivot dragEnd conversion).
  const handleTransformEnd = useCallback(() => {
    const { selectedIds: sids, activeBreakpointId } = useBoardStore.getState();
    if (sids.length !== 1) return;
    const node = nodeMapRef.current.get(sids[0]);
    if (!node) return;

    const sx = node.scaleX();
    const sy = node.scaleY();
    const newWidth  = Math.max(10, node.width()  * sx);
    const newHeight = Math.max(10, node.height() * sy);
    // node.x()/y() is the visual center (we placed element at x+pivotX with offsetX=pivotX)
    const newX = node.x() - newWidth  / 2;
    const newY = node.y() - newHeight / 2;
    const newRotation = node.rotation();

    // Reset scale on the Konva node — React will drive size via width/height props
    node.scaleX(1);
    node.scaleY(1);

    const kfId = activeBreakpointId ?? BASE_KEYFRAME_ID;
    setKeyframe(sids[0], kfId, { x: newX, y: newY, width: newWidth, height: newHeight, rotation: newRotation });
  }, [setKeyframe]);

  // Cancel panning if mouse is released outside the stage.
  useEffect(() => {
    const onGlobalMouseUp = () => { isPanning.current = false; };
    window.addEventListener("mouseup", onGlobalMouseUp);
    return () => window.removeEventListener("mouseup", onGlobalMouseUp);
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inInput = (e.target as HTMLElement)?.matches?.("input,textarea");
      if (inInput) return;

      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault(); undo(); return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault(); redo(); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        e.preventDefault(); void copySelected(); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
        e.preventDefault(); void pasteClipboard(); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        e.preventDefault(); duplicateSelected(); return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        useBoardStore.getState().removeElements(useBoardStore.getState().selectedIds);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        const { board: b } = useBoardStore.getState();
        setSelectedIds(b.elements.filter((el) => !el.parentId).map((el) => el.id));
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "g") {
        e.preventDefault();
        if (e.shiftKey) {
          const { selectedIds: sids, board: b } = useBoardStore.getState();
          const grp = b.elements.find((el) => el.id === sids[0] && isContainer(el));
          if (grp) ungroup(grp.id);
        } else {
          groupSelected();
        }
        return;
      }

      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const toolShortcuts: Partial<Record<string, ToolMode>> = {
          v: "select",
          r: "rect",
          t: "text",
          s: "sticky",
          f: "frame",
          c: "connector",
        };
        const nextTool = toolShortcuts[e.key.toLowerCase()];
        if (nextTool) {
          e.preventDefault();
          if (nextTool === "connector" && connectSelected()) {
            setTool("select");
          } else {
            setTool(nextTool);
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    setTool, setSelectedIds, groupSelected, ungroup,
    undo, redo, copySelected, pasteClipboard, duplicateSelected, connectSelected,
  ]);

  const previewRect = drawDrag ? {
    x: Math.min(drawDrag.startX, drawDrag.currentX),
    y: Math.min(drawDrag.startY, drawDrag.currentY),
    w: Math.abs(drawDrag.currentX - drawDrag.startX),
    h: Math.abs(drawDrag.currentY - drawDrag.startY),
  } : null;

  const marqueeRect = marqueeDrag ? {
    x: Math.min(marqueeDrag.startX, marqueeDrag.curX),
    y: Math.min(marqueeDrag.startY, marqueeDrag.curY),
    w: Math.abs(marqueeDrag.curX - marqueeDrag.startX),
    h: Math.abs(marqueeDrag.curY - marqueeDrag.startY),
  } : null;

  return (
    <Stage
      ref={stageRef}
      width={size.w}
      height={size.h}
      scaleX={zoom}
      scaleY={zoom}
      x={panX}
      y={panY}
      draggable={false}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onContextMenu={(e) => e.evt.preventDefault()}
      style={{ cursor: tool === "select" ? "default" : "crosshair" }}
    >
      <Layer>
        {/* Container selection surfaces always sit behind ordinary objects,
            regardless of the containers' visual layer order. */}
        {tool === "select" && board.elements.map((el) => {
          if (el.parentId || !rendersAsContainer(board, el)) return null;
          const state = resolveCanvasElement(el.id);
          if (!state) return null;
          return (
            <GroupHitNode
              key={`hit-${el.id}`}
              group={el}
              groupState={state}
              childElements={board.elements.filter((child) => child.parentId === el.id)}
              selectedIds={selectedIds}
              onSelect={selectElement}
              onDragEnd={handleDragEnd}
              onAltDragStart={handleAltDragStart}
              onDragProgress={handleDragProgress}
              onDragMoveVisual={handleGroupHitDragMove}
              resolveEl={resolveCanvasElement}
            />
          );
        })}

        {/* Render all elements in array order (preserving z-order).
            - Elements with a parentId are rendered INSIDE their GroupNode.
            - GroupNode wraps children in a Konva.Group that applies the
              group's transform so visibility / position are additive. */}
        {board.elements.map((el) => {
          // Children are rendered inside their GroupNode — skip them here.
          if (el.parentId) return null;

          const state = resolveCanvasElement(el.id);
          if (!state) return null;

          if (rendersAsContainer(board, el)) {
            const childEls = board.elements.filter((c) => c.parentId === el.id);
            return (
              <GroupNode
                key={el.id}
                group={el}
                groupState={state}
                childElements={childEls}
                selectedIds={selectedIds}
                zoom={zoom}
                isSelected={selectedIds.includes(el.id)}
                anyChildSelected={childEls.some((c) => selectedIds.includes(c.id))}
                onSelect={selectElement}
                onDragEnd={handleDragEnd}
                onAltDragStart={handleAltDragStart}
                onDragProgress={handleDragProgress}
                resolveEl={resolveCanvasElement}
                registerNode={registerNode}
              />
            );
          }

          return (
            <ElementNode
              key={el.id}
              element={el}
              state={state}
              isSelected={selectedIds.includes(el.id)}
              onSelect={selectElement}
              onDragEnd={handleDragEnd}
              onAltDragStart={handleAltDragStart}
              onDragProgress={handleDragProgress}
              registerNode={registerNode}
            />
          );
        })}

        {/* Draw-tool preview */}
        {previewRect && tool === "connector" ? (
          <KonvaLine
            points={[
              previewRect.x, previewRect.y,
              previewRect.x + previewRect.w, previewRect.y + previewRect.h,
            ]}
            stroke="#2d8cf0"
            strokeWidth={2 / zoom}
            dash={[6 / zoom, 4 / zoom]}
            listening={false}
          />
        ) : previewRect && (
          <KonvaRect
            x={previewRect.x} y={previewRect.y}
            width={previewRect.w} height={previewRect.h}
            fill={
              tool === "sticky"
                ? "rgba(255,243,163,0.65)"
                : tool === "frame"
                  ? "transparent"
                  : "rgba(45,140,240,0.08)"
            }
            stroke="#2d8cf0"
            strokeWidth={1.5 / zoom}
            dash={[6 / zoom, 4 / zoom]}
            listening={false}
          />
        )}

        {/* Marquee selection preview */}
        {marqueeRect && marqueeRect.w > 2 && marqueeRect.h > 2 && (
          <KonvaRect
            x={marqueeRect.x} y={marqueeRect.y}
            width={marqueeRect.w} height={marqueeRect.h}
            fill="rgba(45,140,240,0.05)"
            stroke="#2d8cf0"
            strokeWidth={1 / zoom}
            dash={[5 / zoom, 3 / zoom]}
            listening={false}
          />
        )}
        {/* Drop-container highlight — driven imperatively during a drag so the
            React tree (and the dragged Konva node) is left untouched. */}
        <KonvaRect
          ref={dropHighlightRef}
          name="drop-highlight"
          visible={false}
          listening={false}
          fill="rgba(45,140,240,0.08)"
          stroke="#2d8cf0"
        />

        {/* Resize / rotate Transformer — attached to the selected element */}
        <Transformer
          ref={transformerRef}
          rotateEnabled={true}
          rotationSnaps={[0, 45, 90, 135, 180, 225, 270, 315]}
          rotationSnapTolerance={5}
          keepRatio={false}
          borderStroke="#2d8cf0"
          borderStrokeWidth={1.5 / zoom}
          anchorStroke="#2d8cf0"
          anchorFill="white"
          anchorSize={9 / zoom}
          anchorCornerRadius={2 / zoom}
          padding={2 / zoom}
          boundBoxFunc={(oldBox, newBox) =>
            newBox.width < 10 || newBox.height < 10 ? oldBox : newBox
          }
          onTransformEnd={handleTransformEnd}
        />
      </Layer>
    </Stage>
  );
}

// ─── Zoom controls ────────────────────────────────────────────────────────────

export function useZoomControls() {
  const { zoom, panX, panY, setZoom, setPan } = useBoardStore();

  const zoomTo = useCallback((factor: number) => {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const newZoom = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const worldX = (cx - panX) / zoom;
    const worldY = (cy - panY) / zoom;
    setZoom(newZoom);
    setPan(cx - worldX * newZoom, cy - worldY * newZoom);
  }, [zoom, panX, panY, setZoom, setPan]);

  const resetZoom = useCallback(() => {
    setZoom(1);
    setPan(window.innerWidth / 2, window.innerHeight / 2);
  }, [setZoom, setPan]);

  return { zoomTo, resetZoom };
}
