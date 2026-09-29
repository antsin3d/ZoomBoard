import { useEffect, useMemo, useRef, useState } from "react";
import { Group, Line, Circle, Rect, Ellipse, Text } from "react-konva";
import type Konva from "konva";
import { useBoardStore } from "../whiteboard/store";
import {
  normalizeConnectorStyle,
  type BoardElement,
  type ConnectorEndpointType,
  type ElementState,
} from "../whiteboard/model";
import {
  collectConnectorObstacles,
  connectorDashArray,
  connectorEndAngles,
  connectorWorldEndpoints,
  edgePoint,
  findAttachTargetAt,
  outermostGroupAncestor,
  pointAlongRoutedConnector,
  routeConnectorPoints,
  shapeOutlineWorld,
  worldPositionAtZoom,
  type Point,
} from "../whiteboard/geometry";

const SELECTION_COLOR = "#2d8cf0";
const SELECTION_MULTI_COLOR = "#8b5cf6";
const SELECTION_WIDTH = 2;

interface Props {
  element: BoardElement;
  state: ElementState;
  zoom: number;
  isSelected: boolean;
  onSelect: (id: string, addToSelection?: boolean) => void;
  onDragEnd: (id: string, x: number, y: number) => void;
  onAltDragStart?: (id: string) => void;
  onDragProgress?: (id: string, x?: number, y?: number) => void;
  registerNode?: (id: string, node: Konva.Group | null) => void;
}

function EndpointMarker({
  type,
  size,
  angle,
  x,
  y,
  color,
  strokeWidth,
}: {
  type: ConnectorEndpointType | undefined;
  size: number;
  angle: number;
  x: number;
  y: number;
  color: string;
  strokeWidth: number;
}) {
  const kind = type ?? "none";
  if (kind === "none") return null;
  const s = Math.max(6, size);
  const rot = (angle * 180) / Math.PI;
  const sw = Math.max(1, strokeWidth);

  if (kind === "arrow") {
    return (
      <Group x={x} y={y} rotation={rot} listening={false}>
        <Line
          points={[-s, -s * 0.55, 0, 0, -s, s * 0.55]}
          stroke={color}
          strokeWidth={sw}
          lineCap="round"
          lineJoin="round"
          listening={false}
        />
      </Group>
    );
  }
  if (kind === "triangle") {
    return (
      <Group x={x} y={y} rotation={rot} listening={false}>
        <Line
          points={[0, 0, -s, -s * 0.55, -s, s * 0.55]}
          closed
          fill={color}
          stroke={color}
          strokeWidth={sw}
          lineJoin="round"
          listening={false}
        />
      </Group>
    );
  }
  if (kind === "diamond") {
    return (
      <Group x={x} y={y} rotation={rot} listening={false}>
        <Line
          points={[0, 0, -s * 0.6, -s * 0.45, -s * 1.2, 0, -s * 0.6, s * 0.45]}
          closed
          fill={color}
          stroke={color}
          strokeWidth={sw}
          lineJoin="round"
          listening={false}
        />
      </Group>
    );
  }
  if (kind === "circle") {
    return (
      <Group x={x} y={y} rotation={rot} listening={false}>
        <Circle
          x={-s * 0.42}
          y={0}
          radius={s * 0.45}
          fill="#ffffff"
          stroke={color}
          strokeWidth={sw}
          listening={false}
        />
      </Group>
    );
  }
  if (kind === "square") {
    const r = s * 0.45;
    return (
      <Group x={x} y={y} rotation={rot} listening={false}>
        <Rect
          x={-s * 0.85 - r}
          y={-r}
          width={r * 2}
          height={r * 2}
          fill="#ffffff"
          stroke={color}
          strokeWidth={sw}
          listening={false}
        />
      </Group>
    );
  }
  // bar: perpendicular tick at the tip.
  return (
    <Group x={x} y={y} rotation={rot} listening={false}>
      <Line
        points={[0, -s * 0.6, 0, s * 0.6]}
        stroke={color}
        strokeWidth={sw * 1.4}
        lineCap="round"
        listening={false}
      />
    </Group>
  );
}

export default function ConnectorNode({
  element, state, zoom, isSelected, onSelect, onDragEnd, onAltDragStart, onDragProgress, registerNode,
}: Props) {
  const groupRef = useRef<Konva.Group>(null);
  const allElements = useBoardStore((s) => s.board.elements);
  const selectedIds = useBoardStore((s) => s.selectedIds);
  const shiftHeld = useBoardStore((s) => s.shiftHeld);
  const isMultiSelected = isSelected && selectedIds.length > 1;
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const axisLock = useRef<"x" | "y" | null>(null);

  // Endpoint-drag preview: world-space override while a handle is dragged.
  // Committed once on drag end so history stays a single undo step.
  const [preview, setPreview] = useState<{ end: "start" | "end"; world: Point } | null>(null);

  // Node the dragged end would attach to — highlighted so the drop target is obvious.
  const snapTarget = useMemo(() => {
    if (!preview) return null;
    const board = useBoardStore.getState().board;
    const z = useBoardStore.getState().zoom;
    return findAttachTargetAt(board, preview.world, z, [element.id]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, element.id]);

  useEffect(() => {
    const node = groupRef.current;
    if (node) registerNode?.(element.id, node);
    return () => { registerNode?.(element.id, null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element.id]);

  useEffect(() => {
    const node = groupRef.current;
    if (!node) return;
    node.to({ opacity: state.visible ? state.opacity : 0, duration: 0.2 });
  }, [state.visible, state.opacity]);

  const groupAncestorId = outermostGroupAncestor(allElements, element.id);
  const firstClickTarget = groupAncestorId ?? element.id;
  const fullyFloating = !element.connectorStartId && !element.connectorEndId;
  const canDragBody = fullyFloating && (!groupAncestorId || isSelected);

  const {
    x, y, width, height, fill, stroke, strokeWidth,
    content, fontSize, fontFamily, fontStyle, textDecoration, lineHeight, textColor,
  } = state;

  const pivotX = width / 2;
  const pivotY = height / 2;
  const selColor = isMultiSelected ? SELECTION_MULTI_COLOR : SELECTION_COLOR;

  // Frame origin in world coords (includes parent offset for nested connectors).
  const frameWorld = useMemo(() => {
    const board = useBoardStore.getState().board;
    const z = useBoardStore.getState().zoom;
    const parent = element.parentId ? board.elements.find((c) => c.id === element.parentId) : undefined;
    const pw = parent ? worldPositionAtZoom(board, parent, z) : { x: 0, y: 0 };
    return { x: state.x + pw.x, y: state.y + pw.y };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.x, state.y, element.parentId, allElements]);

  // Rendered path in frame-local coords, with live preview applied.
  // While dragging an end over a shape, stick to that shape's real edge
  // via a direct center→cursor ray (no side/offset round-trip).
  const renderPath = useMemo(() => {
    const style = normalizeConnectorStyle(state.connectorStyle);
    const fallback = { points: state.connectorPoints ?? [0, 0, width, height], bezier: style === "curved" && (state.connectorPoints ?? []).length >= 8 };
    if (!preview) {
      return {
        points: state.connectorPoints ?? [0, 0, width, height],
        bezier: style === "curved",
      };
    }
    const board = useBoardStore.getState().board;
    const z = useBoardStore.getState().zoom;
    const endpoints = connectorWorldEndpoints(board, element, z);
    if (!endpoints) return fallback;
    let dragWorld = preview.world;
    if (snapTarget) {
      dragWorld = edgePoint(snapTarget.bounds, preview.world, snapTarget.element.type);
    }
    const s = preview.end === "start" ? dragWorld : endpoints.start;
    const e = preview.end === "end" ? dragWorld : endpoints.end;
    // Recompute exit sides from the live endpoints so stepped/curved routes
    // don't keep a stale side while the handle slides around the silhouette.
    const startSide = preview.end === "start" && snapTarget
      ? (Math.abs(s.x - (snapTarget.bounds.x + snapTarget.bounds.width / 2))
          >= Math.abs(s.y - (snapTarget.bounds.y + snapTarget.bounds.height / 2))
          ? (s.x >= snapTarget.bounds.x + snapTarget.bounds.width / 2 ? "right" : "left")
          : (s.y >= snapTarget.bounds.y + snapTarget.bounds.height / 2 ? "bottom" : "top"))
      : endpoints.startSide;
    const endSide = preview.end === "end" && snapTarget
      ? (Math.abs(e.x - (snapTarget.bounds.x + snapTarget.bounds.width / 2))
          >= Math.abs(e.y - (snapTarget.bounds.y + snapTarget.bounds.height / 2))
          ? (e.x >= snapTarget.bounds.x + snapTarget.bounds.width / 2 ? "right" : "left")
          : (e.y >= snapTarget.bounds.y + snapTarget.bounds.height / 2 ? "bottom" : "top"))
      : endpoints.endSide;
    const exclude = [element.id];
    const startId = preview.end === "start" && snapTarget
      ? snapTarget.element.id
      : element.connectorStartId;
    const endId = preview.end === "end" && snapTarget
      ? snapTarget.element.id
      : element.connectorEndId;
    if (startId) exclude.push(startId);
    if (endId) exclude.push(endId);
    const obstacles = collectConnectorObstacles(board, z, exclude);
    const routedWorld = routeConnectorPoints(s, e, style, startSide, endSide, obstacles);
    const localPts = routedWorld.worldPoints.map((v, i) => (i % 2 === 0 ? v - frameWorld.x : v - frameWorld.y));
    return { points: localPts, bezier: routedWorld.bezier };
  }, [preview, snapTarget, state.connectorPoints, state.connectorStyle, state.x, state.y, frameWorld, width, height, element]);

  const angles = useMemo(
    () => connectorEndAngles(renderPath.points, renderPath.bezier),
    [renderPath],
  );
  const dash = useMemo(() => connectorDashArray(state.connectorDash, zoom), [state.connectorDash, zoom]);

  const labelT = state.connectorLabelPosition ?? 0.5;
  const labelInfo = useMemo(
    () => pointAlongRoutedConnector(renderPath.points, renderPath.bezier, labelT),
    [renderPath, labelT],
  );
  const labelX = labelInfo.point.x + (state.connectorLabelOffsetX ?? 0);
  const labelY = labelInfo.point.y + (state.connectorLabelOffsetY ?? 0);

  // Measure label for the background pill (hidden measurer + visible copy).
  const measureRef = useRef<Konva.Text>(null);
  const [labelSize, setLabelSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const node = measureRef.current;
    if (!node || !content) return;
    const w = node.textWidth ?? node.width();
    const h = node.textHeight ?? node.height();
    setLabelSize({ w, h });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, fontSize, fontFamily, fontStyle, lineHeight, labelT]);

  if (!state.visible || state.opacity <= 0) return null;

  // Keep the real stroke visible when selected; selection is drawn as a halo under it.
  const lineColor = stroke;
  const lineWidth = strokeWidth;
  const local = renderPath.points;
  const startLX = local[0] ?? 0;
  const startLY = local[1] ?? 0;
  const endLX = local[local.length - 2] ?? width;
  const endLY = local[local.length - 1] ?? height;
  const handleR = 6 / Math.max(zoom, 0.2);

  const updatePreview = (end: "start" | "end", node: Konva.Circle) => {
    const raw = { x: frameWorld.x + node.x(), y: frameWorld.y + node.y() };
    const board = useBoardStore.getState().board;
    const z = useBoardStore.getState().zoom;
    const hit = findAttachTargetAt(board, raw, z, [element.id]);
    if (hit) {
      const stuck = edgePoint(hit.bounds, raw, hit.element.type);
      node.position({ x: stuck.x - frameWorld.x, y: stuck.y - frameWorld.y });
      setPreview({ end, world: stuck });
      return;
    }
    setPreview({ end, world: raw });
  };

  const commitPreview = (end: "start" | "end", node: Konva.Circle) => {
    const world = { x: frameWorld.x + node.x(), y: frameWorld.y + node.y() };
    setPreview(null);
    node.position(end === "start" ? { x: startLX, y: startLY } : { x: endLX, y: endLY });
    node.getLayer()?.batchDraw();
    useBoardStore.getState().moveConnectorEndpointTo(element.id, end, world);
  };

  const snappingEnd = snapTarget && preview ? preview.end : null;

  return (
    <Group
      ref={groupRef}
      x={x + pivotX}
      y={y + pivotY}
      offsetX={pivotX}
      offsetY={pivotY}
      width={width}
      height={height}
      opacity={state.visible ? state.opacity : 0}
      draggable={canDragBody}
      onClick={(e) => {
        e.cancelBubble = true;
        onSelect(firstClickTarget, e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey);
      }}
      onTap={(e) => {
        e.cancelBubble = true;
        onSelect(firstClickTarget);
      }}
      onDblClick={(e) => {
        e.cancelBubble = true;
        onSelect(element.id, e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey);
      }}
      onDragStart={(e) => {
        if (e.target !== groupRef.current) return;
        if (!isSelected) onSelect(element.id);
        if (e.evt.altKey) onAltDragStart?.(element.id);
        dragStartPos.current = { x: groupRef.current?.x() ?? x, y: groupRef.current?.y() ?? y };
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
        if (node) onDragProgress?.(element.id, node.x() - pivotX, node.y() - pivotY);
      }}
      onDragEnd={(e) => {
        if (e.target !== groupRef.current) return;
        axisLock.current = null;
        dragStartPos.current = null;
        onDragEnd(element.id, e.target.x() - pivotX, e.target.y() - pivotY);
      }}
    >
      {isSelected && (
        <Line
          points={local}
          bezier={renderPath.bezier}
          stroke={selColor}
          strokeWidth={Math.max(lineWidth, 1) + SELECTION_WIDTH * 2}
          listening={false}
          lineCap="round"
          lineJoin="round"
          opacity={0.55}
        />
      )}
      <Line
        points={local}
        bezier={renderPath.bezier}
        stroke={lineColor}
        strokeWidth={lineWidth}
        dash={dash}
        hitStrokeWidth={14}
        lineCap="round"
        lineJoin="round"
        onClick={(e) => {
          e.cancelBubble = true;
          onSelect(element.id, e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey);
        }}
      />
      <EndpointMarker
        type={state.connectorStartType}
        size={state.connectorStartSize ?? 12}
        angle={angles.start}
        x={startLX}
        y={startLY}
        color={lineColor}
        strokeWidth={lineWidth}
      />
      <EndpointMarker
        type={state.connectorEndType}
        size={state.connectorEndSize ?? 12}
        angle={angles.end}
        x={endLX}
        y={endLY}
        color={lineColor}
        strokeWidth={lineWidth}
      />

      {/* Inline label — pill background follows Fill ("transparent" = text only),
          border follows the line color, text follows the Text controls. */}
      {content.trim().length > 0 && (
        <Group
          x={labelX}
          y={labelY}
          draggable={isSelected}
          onClick={(e) => {
            e.cancelBubble = true;
            onSelect(element.id, e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey);
          }}
          onDragEnd={(e) => {
            const target = e.target as Konva.Group;
            if (target === groupRef.current) return;
            e.cancelBubble = true;
            const dropX = target.x();
            const dropY = target.y();
            let bestT = labelT;
            let bestDist = Infinity;
            for (let i = 0; i <= 40; i += 1) {
              const t = i / 40;
              const info = pointAlongRoutedConnector(local, renderPath.bezier, t);
              const d = Math.hypot(info.point.x - dropX, info.point.y - dropY);
              if (d < bestDist) {
                bestDist = d;
                bestT = t;
              }
            }
            const info = pointAlongRoutedConnector(local, renderPath.bezier, bestT);
            useBoardStore.getState().setConnectorLabelPosition(
              element.id,
              Math.round(bestT * 100) / 100,
              Math.round((dropX - info.point.x) * 10) / 10,
              Math.round((dropY - info.point.y) * 10) / 10,
            );
          }}
        >
          <Rect
            x={-labelSize.w / 2 - 7}
            y={-labelSize.h / 2 - 5}
            width={labelSize.w + 14}
            height={labelSize.h + 10}
            fill={fill}
            stroke={stroke}
            strokeWidth={1}
            cornerRadius={6}
            shadowColor="rgba(15,23,42,0.18)"
            shadowBlur={4}
            shadowOffsetY={1}
            listening={false}
            visible={fill !== "transparent"}
          />
          <Text
            x={-labelSize.w / 2}
            y={-labelSize.h / 2}
            width={Math.max(1, labelSize.w)}
            height={Math.max(1, labelSize.h)}
            text={content}
            fontFamily={fontFamily}
            fontSize={fontSize}
            fontStyle={fontStyle}
            textDecoration={textDecoration}
            fill={textColor}
            align="center"
            lineHeight={lineHeight}
            wrap="word"
            listening={false}
          />
          {/* Hidden measurer — kept offscreen so the pill fits the text. */}
          <Text
            ref={measureRef}
            x={-5000}
            y={-5000}
            text={content}
            fontFamily={fontFamily}
            fontSize={fontSize}
            fontStyle={fontStyle}
            lineHeight={lineHeight}
            listening={false}
          />
        </Group>
      )}

      {/* Drop-target highlight — the node the dragged end will attach to. */}
      {snapTarget && preview && (() => {
        const localX = snapTarget.bounds.x - frameWorld.x;
        const localY = snapTarget.bounds.y - frameWorld.y;
        const outline = shapeOutlineWorld(snapTarget.element.type, snapTarget.bounds);
        const strokeW = 2 / Math.max(zoom, 0.2);
        const dash = [5 / Math.max(zoom, 0.2), 4 / Math.max(zoom, 0.2)];
        const anchorWorld = edgePoint(
          snapTarget.bounds,
          preview.world,
          snapTarget.element.type,
        );
        const highlight =
          outline.kind === "ellipse" ? (
            <Ellipse
              x={localX + snapTarget.bounds.width / 2}
              y={localY + snapTarget.bounds.height / 2}
              radiusX={snapTarget.bounds.width / 2}
              radiusY={snapTarget.bounds.height / 2}
              fill="rgba(34,197,94,0.08)"
              stroke="#22c55e"
              strokeWidth={strokeW}
              dash={dash}
              listening={false}
            />
          ) : outline.kind === "polygon" ? (
            <Line
              points={outline.points.map((v, i) => (i % 2 === 0 ? v - frameWorld.x : v - frameWorld.y))}
              closed
              fill="rgba(34,197,94,0.08)"
              stroke="#22c55e"
              strokeWidth={strokeW}
              dash={dash}
              listening={false}
            />
          ) : (
            <Rect
              x={localX}
              y={localY}
              width={snapTarget.bounds.width}
              height={snapTarget.bounds.height}
              fill="rgba(34,197,94,0.08)"
              stroke="#22c55e"
              strokeWidth={strokeW}
              dash={dash}
              cornerRadius={6}
              listening={false}
            />
          );
        return (
          <>
            {highlight}
            <Circle
              x={anchorWorld.x - frameWorld.x}
              y={anchorWorld.y - frameWorld.y}
              radius={4 / Math.max(zoom, 0.2)}
              fill="#22c55e"
              stroke="#ffffff"
              strokeWidth={1.5 / Math.max(zoom, 0.2)}
              listening={false}
            />
          </>
        );
      })()}

      {/* Endpoint handles — drag onto a shape edge to attach (edge snapping),
          or into empty space for a floating end. */}
      {isSelected && (
        <>
          <Circle
            x={startLX}
            y={startLY}
            radius={snappingEnd === "start" ? handleR * 1.4 : handleR}
            fill={snappingEnd === "start" ? "#22c55e" : "#ffffff"}
            stroke={snappingEnd === "start" ? "#16a34a" : selColor}
            strokeWidth={2 / Math.max(zoom, 0.2)}
            draggable
            onMouseEnter={(e) => {
              const c = e.target.getStage()?.container();
              if (c) c.style.cursor = "move";
            }}
            onMouseLeave={(e) => {
              const c = e.target.getStage()?.container();
              if (c) c.style.cursor = "";
            }}
            onDragStart={(e) => {
              e.cancelBubble = true;
              updatePreview("start", e.target as Konva.Circle);
            }}
            onDragMove={(e) => {
              e.cancelBubble = true;
              updatePreview("start", e.target as Konva.Circle);
            }}
            onDragEnd={(e) => {
              e.cancelBubble = true;
              commitPreview("start", e.target as Konva.Circle);
            }}
          />
          <Circle
            x={endLX}
            y={endLY}
            radius={snappingEnd === "end" ? handleR * 1.4 : handleR}
            fill={snappingEnd === "end" ? "#22c55e" : "#ffffff"}
            stroke={snappingEnd === "end" ? "#16a34a" : selColor}
            strokeWidth={2 / Math.max(zoom, 0.2)}
            draggable
            onMouseEnter={(e) => {
              const c = e.target.getStage()?.container();
              if (c) c.style.cursor = "move";
            }}
            onMouseLeave={(e) => {
              const c = e.target.getStage()?.container();
              if (c) c.style.cursor = "";
            }}
            onDragStart={(e) => {
              e.cancelBubble = true;
              updatePreview("end", e.target as Konva.Circle);
            }}
            onDragMove={(e) => {
              e.cancelBubble = true;
              updatePreview("end", e.target as Konva.Circle);
            }}
            onDragEnd={(e) => {
              e.cancelBubble = true;
              commitPreview("end", e.target as Konva.Circle);
            }}
          />
        </>
      )}
    </Group>
  );
}
