import { beforeEach, describe, expect, it } from "vitest";
import { setBoardAccess } from "../collaboration/access";
import { DEFAULT_STATE, presentationState, resolveState, type Board } from "./model";
import { createRegionTimeline } from "./regions";
import { useBoardStore } from "./store";
import { stateForPresentation } from "./geometry";

const store = () => useBoardStore.getState();
const element = () => store().board.elements[0];
const firstId = () => store().board.breakpoints[0].id;
const fresh = (): Board => ({
  breakpoints: createRegionTimeline(),
  elements: [{ id: "shape", name: "Shape", type: "rect", base: { ...DEFAULT_STATE }, keyframes: {} }],
});

beforeEach(() => {
  setBoardAccess(true, true);
  store().replaceBoard(fresh());
  store().setZoom(1);
});

describe("region editing", () => {
  it("starts uniform throughout the zoom range", () => {
    expect(store().board.breakpoints).toHaveLength(1);
    store().setKeyframe("shape", firstId(), { fill: "#ff0000" });
    for (const zoom of [0.05, 0.25, 1, 2, 8]) {
      expect(resolveState(element(), zoom, store().board.breakpoints).fill).toBe("#ff0000");
    }
  });

  it("cuts at 1x without changing appearance, then edits each region independently", () => {
    const left = firstId();
    store().setKeyframe("shape", left, { fill: "#ff0000", content: "Same", x: 25 });
    const right = store().addBreakpoint(1);
    expect(right).not.toBe("");
    expect(store().activeBreakpointId).toBe(right);
    expect(element().keyframes[right]).toBeUndefined();
    expect(presentationState(element(), right, store().board.breakpoints))
      .toEqual(presentationState(element(), left, store().board.breakpoints));
    store().setKeyframe("shape", right, { fill: "#0000ff", content: "Different" });
    expect(presentationState(element(), left)).toMatchObject({ fill: "#ff0000", content: "Same" });
    expect(presentationState(element(), right)).toMatchObject({ fill: "#0000ff", content: "Different" });
    expect(element().base.content).toBe("");
  });

  it("copies the region containing the cut, not the neighboring region or tween", () => {
    const middle = store().addBreakpoint(0.5);
    store().setKeyframe("shape", middle, { opacity: 0.3, content: "Middle" });
    const right = store().addBreakpoint(2);
    expect(element().keyframes[right]).toBeUndefined();
    expect(presentationState(element(), right, store().board.breakpoints))
      .toMatchObject({ opacity: 0.3, content: "Middle" });
    expect(presentationState(element(), firstId()).opacity).toBe(1);
  });

  it("creates defaults without a keyframe and writes only the region that is edited", () => {
    const left = firstId();
    const right = store().addBreakpoint(1);
    const id = store().addElement("rect", { x: 240, y: 180, fill: "#abcdef" });
    const created = () => store().board.elements.find((el) => el.id === id)!;

    expect(store().activeBreakpointId).toBe(right);
    expect(created().base).toMatchObject({ x: 240, y: 180, fill: "#abcdef" });
    expect(created().keyframes).toEqual({});

    store().setKeyframe(id, right, { fill: "#123456" });
    expect(Object.keys(created().keyframes)).toEqual([right]);
    expect(created().keyframes[right]).toEqual({ fill: "#123456" });
    expect(created().keyframes[left]).toBeUndefined();

    store().setZoom(0.25);
    store().setKeyframe(id, left, { opacity: 0.5 });
    expect(new Set(Object.keys(created().keyframes))).toEqual(new Set([left, right]));
  });

  it("copies selected objects' settings from one region and pastes them into another", () => {
    store().replaceBoard({
      ...fresh(),
      elements: [
        ...fresh().elements,
        { id: "other", name: "Other", type: "ellipse", base: { ...DEFAULT_STATE }, keyframes: {} },
      ],
    });
    store().setZoom(1);
    const left = firstId();
    const right = store().addBreakpoint(1);
    store().setKeyframe("shape", right, { fill: "#ff0000", x: 40 });
    store().setKeyframe("other", right, { opacity: 0.4 });
    store().setSelectedIds(["shape", "other"]);
    expect(store().copyRegionSettings()).toBe(2);

    store().setZoom(0.25);
    expect(store().activeBreakpointId).toBe(left);
    const undoDepth = store()._past.length;
    expect(store().pasteRegionSettings()).toBe(2);
    expect(store()._past.length).toBe(undoDepth + 1);
    const byId = (id: string) => store().board.elements.find((el) => el.id === id)!;
    expect(presentationState(byId("shape"), left)).toMatchObject({ fill: "#ff0000", x: 40 });
    expect(presentationState(byId("other"), left).opacity).toBe(0.4);
    expect(store().pasteRegionSettings()).toBe(0);

    store().setKeyframe("shape", left, { rotation: 30 });
    store().setSelectedIds(["shape"]);
    expect(store().pasteRegionSettings()).toBe(1);
    expect(presentationState(byId("shape"), left).rotation).toBe(0);

    store().undo();
    expect(presentationState(byId("shape"), left).rotation).toBe(30);
  });

  it("never reveals hidden elements when adding an identical tween", () => {
    store().setKeyframe("shape", firstId(), { visible: false });
    const right = store().addBreakpoint(1);
    expect(right).not.toBe("");
    for (const zoom of [0.95, 1, 1.05]) {
      expect(resolveState(element(), zoom, store().board.breakpoints).visible).toBe(false);
    }
  });

  it("rejects cuts that would silently shorten an existing tween", () => {
    const right = store().addBreakpoint(1);
    store().setKeyframe("shape", right, { x: 100 });
    const before = store().board;
    const history = store()._past.length;
    expect(resolveState(element(), 1, before.breakpoints).x).toBeCloseTo(50);
    expect(store().addBreakpoint(1.02)).toBe("");
    expect(store().addBreakpoint(0.98)).toBe("");
    expect(store().board).toBe(before);
    expect(store()._past).toHaveLength(history);
    expect(store().addBreakpoint(1.5)).not.toBe("");
    expect(resolveState(element(), 1, store().board.breakpoints).x).toBeCloseTo(50);
  });

  it("prevents duplicate/edge cuts and divider crossings without extra history", () => {
    const middle = store().addBreakpoint(1);
    const right = store().addBreakpoint(2);
    const history = store()._past.length;
    for (const zoom of [1, 1.001, 0.05, 8, NaN]) expect(store().addBreakpoint(zoom)).toBe("");
    expect(store()._past).toHaveLength(history);
    store().updateBreakpoint(middle, { zoom: 5 });
    expect(store().board.breakpoints.find((bp) => bp.id === middle)!.zoom).toBeLessThan(2);
    store().updateBreakpoint(right, { zoom: 0.01 });
    expect(store().board.breakpoints.map((bp) => bp.id)).toEqual([firstId(), middle, right]);
    store().updateBreakpoint(firstId(), { zoom: 0.2 });
    expect(store().board.breakpoints[0].zoom).toBe(0.05);
  });

  it("records one undo step for a divider gesture and restores region selection", () => {
    const right = store().addBreakpoint(1);
    const before = store()._past.length;
    store().updateBreakpoint(right, { zoom: 1.3 });
    store().updateBreakpoint(right, { zoom: 1.5 }, false);
    store().updateBreakpoint(right, { zoom: 2 }, false);
    expect(store()._past).toHaveLength(before + 1);
    expect(store().activeBreakpointId).toBe(firstId());
    store().undo();
    expect(store().board.breakpoints[1].zoom).toBe(1);
    expect(store().activeBreakpointId).toBe(right);
    store().redo();
    expect(store().board.breakpoints[1].zoom).toBe(2);
  });

  it("merges into the left region and can undo the removed customization", () => {
    const right = store().addBreakpoint(1);
    store().setKeyframe("shape", right, { fill: "#0000ff" });
    store().removeBreakpoint(right);
    expect(store().board.breakpoints).toHaveLength(1);
    expect(element().keyframes[right]).toBeUndefined();
    expect(store().resolve("shape")!.fill).toBe(DEFAULT_STATE.fill);
    store().undo();
    expect(presentationState(element(), right).fill).toBe("#0000ff");
    store().removeBreakpoint(firstId());
    expect(store().board.breakpoints).toHaveLength(2);
  });

  it("merges a contiguous multi-selection into the leftmost region in one undo step", () => {
    const middle = store().addBreakpoint(0.5);
    const right = store().addBreakpoint(2);
    store().setKeyframe("shape", middle, { fill: "#00ff00" });
    store().setKeyframe("shape", right, { fill: "#0000ff" });
    const history = store()._past.length;
    expect(store().mergeRegions([firstId(), right])).toBeNull();
    expect(store().mergeRegions([right])).toBeNull();
    expect(store().mergeRegions([right, middle])).toBe(middle);
    expect(store().board.breakpoints.map((bp) => bp.id)).toEqual([firstId(), middle]);
    expect(element().keyframes[right]).toBeUndefined();
    expect(resolveState(element(), 6, store().board.breakpoints).fill).toBe("#00ff00");
    expect(store()._past).toHaveLength(history + 1);
    store().undo();
    expect(store().board.breakpoints).toHaveLength(3);
    expect(presentationState(element(), right).fill).toBe("#0000ff");
  });

  it("requests text editing for a double-clicked element, but not groups or read-only guests", () => {
    store().editElementText("shape");
    const request = store().textEditRequest;
    expect(store().selectedIds).toEqual(["shape"]);
    expect(request?.id).toBe("shape");
    store().editElementText("shape");
    expect(store().textEditRequest!.nonce).toBe(request!.nonce + 1);
    setBoardAccess(false, false);
    store().editElementText("shape");
    expect(store().textEditRequest!.nonce).toBe(request!.nonce + 1);
    setBoardAccess(true, true);
  });

  it("resets a customization with undo and does not mutate another region", () => {
    const right = store().addBreakpoint(1);
    store().setKeyframe("shape", right, { fill: "#0000ff" });
    store().clearKeyframeKey("shape", right, "fill");
    expect(presentationState(element(), right).fill).toBe(DEFAULT_STATE.fill);
    store().undo();
    expect(presentationState(element(), right).fill).toBe("#0000ff");
    expect(presentationState(element(), firstId()).fill).toBe(DEFAULT_STATE.fill);
  });

  it("resolves geometry by presentation ID, including the baseline, not a fixed 1x anchor", () => {
    const left = firstId();
    const right = store().addBreakpoint(0.5);
    store().setKeyframe("shape", left, { x: 10 });
    store().setKeyframe("shape", right, { x: 200 });
    expect(stateForPresentation(store().board, element(), left).x).toBe(10);
    expect(stateForPresentation(store().board, element(), right).x).toBe(200);
    expect(stateForPresentation(store().board, element(), "__base__").x).toBe(0);
  });

  it("guards region mutations for read-only guests", () => {
    const right = store().addBreakpoint(1);
    store().setKeyframe("shape", right, { fill: "#123456" });
    store().setSelectedIds(["shape"]);
    store().copyRegionSettings();
    store().setZoom(0.25);
    const before = store().board;
    const history = store()._past.length;
    setBoardAccess(false, false);
    expect(store().pasteRegionSettings()).toBe(0);
    expect(store().addBreakpoint(2)).toBe("");
    store().updateBreakpoint(right, { zoom: 2 });
    store().removeBreakpoint(right);
    store().setKeyframe("shape", right, { x: 20 });
    expect(store().board).toBe(before);
    expect(store()._past).toHaveLength(history);
    setBoardAccess(true, true);
  });
});
