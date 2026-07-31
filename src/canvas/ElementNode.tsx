import { useRef, useEffect, useState } from "react";
import { Group, Line, Rect, Shape, Text } from "react-konva";
import type Konva from "konva";
import { useBoardStore } from "../whiteboard/store";
import type { BoardElement, ElementState } from "../whiteboard/model";
import { outermostGroupAncestor } from "../whiteboard/geometry";

const SELECTION_COLOR = "#2d8cf0";
const SELECTION_MULTI_COLOR = "#8b5cf6";
const SELECTION_WIDTH = 2;
const TEXT_PAD = 8;

function useTexture(src?: string) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) {
      setImage(null);
      return;
    }
    const next = new window.Image();
    next.onload = () => setImage(next);
    next.src = src;
    return () => { next.onload = null; };
  }, [src]);
  return image;
}

function shapePath(
  ctx: CanvasRenderingContext2D,
  type: BoardElement["type"],
  width: number,
  height: number,
) {
  ctx.beginPath();
  if (type === "ellipse") {
    ctx.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  } else if (type === "triangle") {
    ctx.moveTo(width / 2, 0);
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
  } else if (type === "diamond") {
    ctx.moveTo(width / 2, 0);
    ctx.lineTo(width, height / 2);
    ctx.lineTo(width / 2, height);
    ctx.lineTo(0, height / 2);
  } else if (type === "hexagon") {
    ctx.moveTo(width * 0.25, 0);
    ctx.lineTo(width * 0.75, 0);
    ctx.lineTo(width, height / 2);
    ctx.lineTo(width * 0.75, height);
    ctx.lineTo(width * 0.25, height);
    ctx.lineTo(0, height / 2);
  } else if (type === "star") {
    const cx = width / 2;
    const cy = height / 2;
    const outerX = width / 2;
    const outerY = height / 2;
    for (let point = 0; point < 10; point += 1) {
      const angle = -Math.PI / 2 + point * Math.PI / 5;
      const radius = point % 2 === 0 ? 1 : 0.44;
      const px = cx + Math.cos(angle) * outerX * radius;
      const py = cy + Math.sin(angle) * outerY * radius;
      if (point === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  } else if (typeof ctx.roundRect === "function") {
    ctx.roundRect(0, 0, width, height, type === "sticky" ? 2 : type === "frame" ? 0 : 6);
  } else {
    ctx.rect(0, 0, width, height);
  }
  ctx.closePath();
}

interface Props {
  element: BoardElement;
  state: ElementState;
  isSelected: boolean;
  onSelect: (id: string, addToSelection?: boolean) => void;
  onDragEnd: (id: string, x: number, y: number) => void;
  onAltDragStart?: (id: string) => void;
  /** Fired while dragging so the canvas can preview the drop container. */
  onDragProgress?: (id: string) => void;
  registerNode?: (id: string, node: Konva.Group | null) => void;
}

function textAlignAnchor(align: ElementState["textAlign"]): number {
  if (align === "left") return 0;
  if (align === "right") return 1;
  return 0.5;
}

function textVAlignAnchor(align: ElementState["textVAlign"]): number {
  if (align === "top") return 0;
  if (align === "bottom") return 1;
  return 0.5;
}

function estimateTextBlock(
  content: string,
  fontSize: number,
  lineHeight: number,
  maxWidth: number,
  maxHeight: number,
) {
  const averageCharacterWidth = fontSize * 0.56;
  const charactersPerLine = Math.max(1, Math.floor(maxWidth / averageCharacterWidth));
  let lineCount = 0;
  let longestLine = 1;

  for (const paragraph of content.split(/\r?\n/)) {
    if (!paragraph.length) {
      lineCount += 1;
      continue;
    }
    let currentLength = 0;
    for (const word of paragraph.split(/\s+/)) {
      if (word.length > charactersPerLine) {
        if (currentLength) {
          longestLine = Math.max(longestLine, currentLength);
          lineCount += 1;
          currentLength = 0;
        }
        const fullLines = Math.floor(word.length / charactersPerLine);
        lineCount += fullLines;
        longestLine = Math.max(longestLine, Math.min(word.length, charactersPerLine));
        currentLength = word.length % charactersPerLine;
        continue;
      }
      const nextLength = currentLength ? currentLength + 1 + word.length : word.length;
      if (nextLength > charactersPerLine) {
        longestLine = Math.max(longestLine, currentLength);
        lineCount += 1;
        currentLength = word.length;
      } else {
        currentLength = nextLength;
      }
    }
    longestLine = Math.max(longestLine, currentLength);
    lineCount += 1;
  }

  const estimatedWidth = longestLine * averageCharacterWidth;
  const estimatedHeight = Math.max(1, lineCount) * fontSize * lineHeight;

  return {
    width: Math.max(1, Math.min(maxWidth, estimatedWidth)),
    height: Math.max(fontSize * lineHeight, Math.min(maxHeight, estimatedHeight)),
  };
}

export default function ElementNode({
  element, state, isSelected, onSelect, onDragEnd, onAltDragStart, onDragProgress, registerNode,
}: Props) {
  const groupRef = useRef<Konva.Group>(null);
  const shiftHeld = useBoardStore((s) => s.shiftHeld);
  const selectedIds = useBoardStore((s) => s.selectedIds);
  const allElements = useBoardStore((s) => s.board.elements);
  const isMultiSelected = isSelected && selectedIds.length > 1;
  const fillTexture = useTexture(state.fillTextureSrc ?? (element.type === "image" ? state.imageSrc : undefined));
  const strokeTexture = useTexture(state.strokeTextureSrc);

  // A grouped element answers as its group until it is explicitly selected;
  // anything else (including frame children) responds on its own.
  const groupAncestorId = outermostGroupAncestor(allElements, element.id);
  const firstClickTarget = groupAncestorId ?? element.id;
  const canDrag = (
    (!groupAncestorId || isSelected)
    && !element.connectorStartId
    && !element.connectorEndId
  );

  // Axis-lock state for Shift+drag
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const axisLock = useRef<"x" | "y" | null>(null);

  // Expose the Konva node so BoardCanvas can attach the Transformer.
  useEffect(() => {
    const node = groupRef.current;
    if (node) registerNode?.(element.id, node);
    return () => { registerNode?.(element.id, null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element.id]);

  // Animate opacity changes (crossfade between breakpoint states)
  useEffect(() => {
    const node = groupRef.current;
    if (!node) return;
    node.to({ opacity: state.visible ? state.opacity : 0, duration: 0.2 });
  }, [state.visible, state.opacity]);

  if (!state.visible || state.opacity <= 0) return null;

  const {
    x, y, width, height, rotation, fill, stroke, strokeWidth,
    content, fontSize, fontFamily, fontStyle, textDecoration, lineHeight,
    textColor, textAlign, textVAlign,
  } = state;

  const selColor = isMultiSelected ? SELECTION_MULTI_COLOR : SELECTION_COLOR;
  const pivotX = width / 2;
  const pivotY = height / 2;
  const textAnchorX = state.textAnchorX ?? textAlignAnchor(textAlign);
  const textAnchorY = state.textAnchorY ?? textVAlignAnchor(textVAlign);
  const innerTextWidth = Math.max(1, width - TEXT_PAD * 2);
  const innerTextHeight = Math.max(1, height - TEXT_PAD * 2);
  const textBlock = estimateTextBlock(content, fontSize, lineHeight, innerTextWidth, innerTextHeight);
  const textX = TEXT_PAD + (innerTextWidth - textBlock.width) * textAnchorX;
  const textY = TEXT_PAD + (innerTextHeight - textBlock.height) * textAnchorY;

  return (
    <Group
      ref={groupRef}
      x={x + pivotX}
      y={y + pivotY}
      offsetX={pivotX}
      offsetY={pivotY}
      width={width}
      height={height}
      rotation={rotation}
      opacity={state.visible ? state.opacity : 0}
      draggable={canDrag}
      onClick={(e) => {
        e.cancelBubble = true;
        onSelect(firstClickTarget, e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey);
      }}
      onDblClick={(e) => {
        e.cancelBubble = true;
        onSelect(element.id, e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey);
      }}
      onTap={(e) => {
        e.cancelBubble = true;
        onSelect(firstClickTarget);
      }}
      // Konva drag events bubble, so a parent would otherwise react to (and
      // commit) its child's drag. Only handle events fired by this node.
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
        onDragProgress?.(element.id);
      }}
      onDragEnd={(e) => {
        if (e.target !== groupRef.current) return;
        axisLock.current = null;
        dragStartPos.current = null;
        onDragEnd(element.id, e.target.x() - pivotX, e.target.y() - pivotY);
      }}
    >
      {element.type === "text" ? (
        <Text
          x={TEXT_PAD}
          y={TEXT_PAD}
          width={Math.max(1, width - TEXT_PAD * 2)}
          height={Math.max(1, height - TEXT_PAD * 2)}
          text={content}
          fontFamily={fontFamily}
          fontSize={fontSize}
          fontStyle={fontStyle}
          textDecoration={textDecoration}
          fill={textColor}
          align={textAlign}
          verticalAlign={textVAlign}
          wrap="word"
          lineHeight={lineHeight}
        />
      ) : element.type === "connector" ? (
        <Line
          points={
            state.connectorStyle === "stepped"
              ? (() => {
                const points = state.connectorPoints ?? [0, 0, width, height];
                const [sx, sy, ex, ey] = points;
                const midX = (sx + ex) / 2;
                return [sx, sy, midX, sy, midX, ey, ex, ey];
              })()
              : state.connectorStyle === "bezier"
                ? (() => {
                  const points = state.connectorPoints ?? [0, 0, width, height];
                  const [sx, sy, ex, ey] = points;
                  const dx = ex - sx;
                  const dy = ey - sy;
                  const length = Math.max(1, Math.hypot(dx, dy));
                  const curve = Math.min(90, Math.max(28, length * 0.22));
                  const nx = -dy / length;
                  const ny = dx / length;
                  return [
                    sx, sy,
                    sx + dx / 3 + nx * curve, sy + dy / 3 + ny * curve,
                    sx + dx * 2 / 3 + nx * curve, sy + dy * 2 / 3 + ny * curve,
                    ex, ey,
                  ];
                })()
                : state.connectorPoints ?? [0, 0, width, height]
          }
          bezier={state.connectorStyle === "bezier"}
          stroke={isSelected ? selColor : stroke}
          strokeWidth={isSelected ? SELECTION_WIDTH : strokeWidth}
          hitStrokeWidth={12}
          lineCap="round"
          lineJoin="round"
        />
      ) : (
        <Shape
          width={width}
          height={height}
          fill={element.type === "frame" ? "transparent" : fill}
          stroke={isSelected ? selColor : stroke}
          strokeWidth={isSelected ? SELECTION_WIDTH : strokeWidth}
          sceneFunc={(context) => {
            const ctx = context._context;
            shapePath(ctx, element.type, width, height);
            if (element.type !== "frame") {
              if (fillTexture) {
                ctx.save();
                ctx.clip();
                ctx.drawImage(fillTexture, 0, 0, width, height);
                ctx.restore();
                shapePath(ctx, element.type, width, height);
              } else {
                ctx.fillStyle = fill;
                ctx.fill();
              }
            }
            ctx.lineWidth = isSelected ? SELECTION_WIDTH : strokeWidth;
            ctx.strokeStyle = isSelected ? selColor : stroke;
            if (strokeTexture && !isSelected) {
              const pattern = ctx.createPattern(strokeTexture, "repeat");
              if (pattern) ctx.strokeStyle = pattern;
            }
            if (element.type === "frame") ctx.setLineDash([8, 5]);
            ctx.stroke();
            ctx.setLineDash([]);
          }}
          hitFunc={(context, shape) => {
            shapePath(context._context, element.type, width, height);
            context.fillStrokeShape(shape);
          }}
        />
      )}

      {/* Labels inside shape elements */}
      {!["text", "connector", "image", "group"].includes(element.type) && content && (
        <Text
          x={textX}
          y={textY}
          width={textBlock.width}
          height={textBlock.height}
          text={content}
          fontFamily={fontFamily}
          fontSize={fontSize}
          fontStyle={fontStyle}
          textDecoration={textDecoration}
          fill={textColor}
          align={textAlign}
          verticalAlign="top"
          lineHeight={lineHeight}
          wrap="word"
          listening={false}
        />
      )}

      {/* Selection outline for text elements */}
      {element.type === "text" && isSelected && (
        <Rect
          x={-1}
          y={-1}
          width={width + 2}
          height={height + 2}
          fill="transparent"
          stroke={selColor}
          strokeWidth={SELECTION_WIDTH}
          dash={[4, 4]}
          cornerRadius={3}
          listening={false}
        />
      )}
    </Group>
  );
}
