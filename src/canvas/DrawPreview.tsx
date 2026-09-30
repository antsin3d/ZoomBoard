import { Ellipse, Line, Rect } from "react-konva";
import type { ElementType } from "../whiteboard/model";
import { shapeOutlineWorld, type Point } from "../whiteboard/geometry";

export function drawPreviewBounds(start: Point, end: Point) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export default function DrawPreview({ type, start, end, zoom }: {
  type: ElementType;
  start: Point;
  end: Point;
  zoom: number;
}) {
  const bounds = drawPreviewBounds(start, end);
  const outline = shapeOutlineWorld(type, bounds);
  const style = {
    fill: type === "sticky" ? "rgba(255,243,163,0.65)"
      : type === "frame" ? "transparent" : "rgba(45,140,240,0.08)",
    stroke: "#2d8cf0",
    strokeWidth: 1.5 / zoom,
    dash: [6 / zoom, 4 / zoom],
    listening: false,
  };
  if (outline.kind === "ellipse") {
    return <Ellipse {...style}
      x={bounds.x + bounds.width / 2} y={bounds.y + bounds.height / 2}
      radiusX={bounds.width / 2} radiusY={bounds.height / 2}
    />;
  }
  if (outline.kind === "polygon") {
    return <Line {...style} points={outline.points} closed />;
  }
  return <Rect {...style} {...bounds} />;
}
