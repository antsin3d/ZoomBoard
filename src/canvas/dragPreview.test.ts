import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_STATE, resolveState, type Board, type BoardElement } from "../whiteboard/model";
import {
  clearLivePositions, resolveConnectorState, setLivePosition, withLiveState, worldPositionAtZoom,
} from "../whiteboard/geometry";
import { createDragPreview, dragPreviewPositions, dragSelection, resolveLiveConnectorState } from "./dragPreview";

function element(id: string, x: number, y: number, type: BoardElement["type"] = "rect", parentId?: string): BoardElement {
  return {
    id, name: id, type, parentId,
    base: { ...DEFAULT_STATE, x, y, width: 100, height: 80, connectorStyle: "straight" },
    keyframes: {},
  };
}

function preview(board: Board, ids: string[], id: string, dx: number, dy: number, zoom = 1) {
  const drag = createDragPreview(board, ids, id, zoom)!;
  const positions = dragPreviewPositions(drag, { x: drag.origin.x + dx, y: drag.origin.y + dy });
  for (const [rootId, position] of positions) setLivePosition(rootId, position);
  return positions;
}

afterEach(clearLivePositions);

describe("selection drag preview", () => {
  it("moves every root live, with deeply selected descendants inheriting exactly once", () => {
    const group = element("group", 10, 20, "group");
    const frame = element("frame", 30, 40, "frame", "group");
    const child = element("child", 5, 6, "rect", "frame");
    const other = element("other", 500, 100);
    const board: Board = { breakpoints: [], elements: [group, frame, child, other] };
    const positions = preview(board, ["group", "child", "other"], "group", 70, -15);
    expect([...positions.keys()]).toEqual(["group", "other"]);
    expect(worldPositionAtZoom(board, child, 1)).toEqual({ x: 115, y: 51 });
    expect(worldPositionAtZoom(board, other, 1)).toEqual({ x: 570, y: 85 });
    expect(withLiveState(child.base, child.id)).toBe(child.base);
    expect(child.base.x).toBe(5);
  });

  it("drags a directly grabbed descendant alone when any ancestor is selected", () => {
    const board: Board = { breakpoints: [], elements: [
      element("group", 10, 20, "group"),
      element("frame", 30, 40, "frame", "group"),
      element("child", 5, 6, "rect", "frame"),
      element("other", 500, 100),
    ] };
    const selection = dragSelection(board, ["group", "child", "other"], "child");
    expect(selection.movesSelection).toBe(false);
    expect(selection.roots.map((root) => root.id)).toEqual(["child"]);
    preview(board, ["group", "child", "other"], "child", 10, 0);
    expect(worldPositionAtZoom(board, board.elements[2], 1)).toEqual({ x: 55, y: 66 });
    expect(worldPositionAtZoom(board, board.elements[0], 1)).toEqual({ x: 10, y: 20 });
  });

  it("uses resolved presentation positions and accepts axis-locked deltas", () => {
    const shape = element("shape", 1, 2);
    shape.keyframes.detail = { x: 300, y: 400 };
    const board: Board = {
      breakpoints: [{ id: "detail", name: "Detail", zoom: 2, transition: "snap", transitionRange: 0 }],
      elements: [shape, element("other", 20, 30)],
    };
    const positions = preview(board, ["shape", "other"], "shape", 0, 45, 2);
    expect(positions.get("shape")).toEqual({ x: 300, y: 445 });
    expect(positions.get("other")).toEqual({ x: 20, y: 75 });
    clearLivePositions();
    expect(withLiveState(resolveState(shape, 2, board.breakpoints), shape.id)).toMatchObject({ x: 300, y: 400 });
  });

  it("tracks connectors attached to descendants and other moving roots", () => {
    const frame = element("frame", 10, 20, "frame");
    const child = element("child", 5, 6, "rect", "frame");
    const other = element("other", 500, 100);
    const connector = { ...element("wire", 0, 0, "connector"), connectorStartId: "child", connectorEndId: "other" };
    const board: Board = { breakpoints: [], elements: [frame, child, other, connector] };
    const before = resolveConnectorState(board, connector, 1);
    preview(board, ["frame", "child", "other"], "frame", 70, -15);
    const during = resolveLiveConnectorState(board, connector, 1);
    expect(during.x).toBeCloseTo(before.x + 70);
    expect(during.y).toBeCloseTo(before.y - 15);
    expect(during.connectorPoints).toHaveLength(before.connectorPoints!.length);
    during.connectorPoints!.forEach((value, index) => {
      expect(value).toBeCloseTo(before.connectorPoints![index]);
    });
  });

  it.each(["straight", "stepped", "curved"] as const)("keeps floating %s connector hulls distinct from stored origins", (style) => {
    const connector = element("wire", 300, 200, "connector");
    connector.base.connectorStyle = style;
    connector.base.connectorPoints = [80, 90, -50, -60];
    const board: Board = { breakpoints: [], elements: [connector, element("other", 800, 700)] };
    const original = resolveConnectorState(board, connector, 1);
    expect(original.x).not.toBe(connector.base.x);
    const positions = preview(board, ["wire", "other"], "wire", 37, -24);
    expect(positions.get("wire")).toEqual({ x: 337, y: 176 });
    const during = resolveLiveConnectorState(board, connector, 1);
    clearLivePositions();
    const committed = { ...connector, base: { ...connector.base, ...positions.get("wire") } };
    const after = resolveConnectorState({ ...board, elements: [committed, board.elements[1]] }, committed, 1);
    expect(during).toEqual(after);
  });

  it("does not translate an attached connector's routed hull a second time", () => {
    const a = element("a", 0, 0);
    const b = element("b", 400, 0);
    const wire = { ...element("wire", 0, 0, "connector"), connectorStartId: "a", connectorEndId: "b" };
    const board: Board = { breakpoints: [], elements: [a, b, wire] };
    const original = resolveConnectorState(board, wire, 1);
    preview(board, ["a", "wire"], "a", 50, 25);
    const during = resolveLiveConnectorState(board, wire, 1);
    clearLivePositions();
    const committedBoard = { ...board, elements: board.elements.map((el) => (
      ["a", "wire"].includes(el.id) ? { ...el, base: { ...el.base, x: el.base.x + 50, y: el.base.y + 25 } } : el
    )) };
    const after = resolveConnectorState(committedBoard, committedBoard.elements[2], 1);
    expect(during).toEqual(after);
    expect(during.width).toBeLessThan(original.width);
  });

  it("preserves half-attached floating-end behavior during selection drags", () => {
    const shape = element("shape", 100, 100);
    const wire = { ...element("wire", 0, 0, "connector"), connectorStartId: "shape" };
    wire.base.connectorPoints = [0, 0, 120, 75];
    const board: Board = { breakpoints: [], elements: [shape, wire] };
    preview(board, ["shape", "wire"], "shape", -35, 25);
    const during = resolveLiveConnectorState(board, wire, 1);
    clearLivePositions();
    const committedBoard = { ...board, elements: board.elements.map((el) => (
      { ...el, base: { ...el.base, x: el.base.x - 35, y: el.base.y + 25 } }
    )) };
    expect(during).toEqual(resolveConnectorState(committedBoard, committedBoard.elements[1], 1));
  });

  it("moves nested floating connectors through their parents, not twice", () => {
    const frame = element("frame", 100, 200, "frame");
    const wire = element("wire", 20, 30, "connector", "frame");
    wire.base.connectorPoints = [0, 0, 150, 50];
    const board: Board = { breakpoints: [], elements: [frame, wire] };
    const original = resolveConnectorState(board, wire, 1);
    preview(board, ["frame", "wire"], "frame", 50, 25);
    expect(resolveLiveConnectorState(board, wire, 1)).toEqual(original);
    expect(worldPositionAtZoom(board, wire, 1)).toEqual({ x: 170, y: 255 });
    clearLivePositions();
    expect(worldPositionAtZoom(board, wire, 1)).toEqual({ x: 120, y: 230 });
  });
});
