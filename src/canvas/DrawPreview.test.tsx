import { describe, expect, it, vi } from "vitest";
import type { ElementType } from "../whiteboard/model";
import { shapeOutlineWorld } from "../whiteboard/geometry";
import DrawPreview, { drawPreviewBounds } from "./DrawPreview";

vi.mock("react-konva", () => ({ Ellipse: "Ellipse", Line: "Line", Rect: "Rect" }));

describe("draw-tool preview", () => {
  it.each([
    [{ x: 10, y: 20 }, { x: 110, y: 100 }],
    [{ x: 110, y: 100 }, { x: 10, y: 20 }],
    [{ x: 110, y: 20 }, { x: 10, y: 100 }],
    [{ x: 10, y: 100 }, { x: 110, y: 20 }],
  ])("normalizes all drag directions", (start, end) => {
    expect(drawPreviewBounds(start, end)).toEqual({ x: 10, y: 20, width: 100, height: 80 });
  });

  it.each([
    ["ellipse", "Ellipse"],
    ["triangle", "Line"],
    ["diamond", "Line"],
    ["hexagon", "Line"],
    ["star", "Line"],
    ["rect", "Rect"],
    ["frame", "Rect"],
    ["sticky", "Rect"],
    ["text", "Rect"],
  ] as const)("renders %s using its real silhouette", (type: ElementType, expected) => {
    const start = { x: 110, y: 100 };
    const end = { x: 10, y: 20 };
    const node = DrawPreview({ type, start, end, zoom: 2 });
    expect(node.type).toBe(expected);
    expect(node.props.listening).toBe(false);
    expect(node.props.strokeWidth).toBe(0.75);
    if (expected === "Line") {
      const outline = shapeOutlineWorld(type, drawPreviewBounds(start, end));
      expect(outline.kind).toBe("polygon");
      if (outline.kind === "polygon") expect(node.props.points).toEqual(outline.points);
      expect(node.props.closed).toBe(true);
    }
    if (expected === "Ellipse") {
      expect(node.props).toMatchObject({ x: 60, y: 60, radiusX: 50, radiusY: 40 });
    }
    if (type !== "frame" && type !== "sticky") {
      expect(node.props.fill).toBe("rgba(45,140,240,0.08)");
    }
  });
});
