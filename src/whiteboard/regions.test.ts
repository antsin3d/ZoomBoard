import { describe, expect, it } from "vitest";
import {
  BASE_KEYFRAME_ID, DEFAULT_STATE, activeBreakpoint, isRegionTimeline,
  presentationKeyForZoom, presentationState, regionTweenBounds, resolveState, resolveStateDirect,
  type Board, type BoardElement, type Breakpoint,
} from "./model";
import { createRegionTimeline, MAX_REGION_ZOOM, migrateToRegions, MIN_REGION_ZOOM } from "./regions";

function region(id: string, zoom: number, overrides: Partial<Breakpoint> = {}): Breakpoint {
  return { id, zoom, name: id, region: true, transition: "crossfade", transitionRange: 0, ...overrides };
}
function element(overrides: Partial<BoardElement> = {}): BoardElement {
  return { id: "shape", type: "rect", name: "Shape", base: { ...DEFAULT_STATE }, keyframes: {}, ...overrides };
}
function legacy(id: string, zoom: number, transitionRange = 0): Breakpoint {
  return { id, zoom, name: id, transition: "crossfade", transitionRange };
}

describe("region resolution", () => {
  it("starts with one independent region covering the entire supported range", () => {
    const timeline = createRegionTimeline();
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      zoom: MIN_REGION_ZOOM, name: "Region 1", region: true,
      transition: "crossfade", transitionRange: 0, tweenIn: 0.12, tweenOut: 0.12,
    });
    expect(timeline[0].id).not.toBe(BASE_KEYFRAME_ID);
    const el = element({ keyframes: { [timeline[0].id]: { x: 42 } } });
    for (const zoom of [0.01, MIN_REGION_ZOOM, 0.5, 0.99, 1, 2, MAX_REGION_ZOOM, 16]) {
      expect(activeBreakpoint(zoom, timeline)).toBe(timeline[0]);
      expect(resolveState(el, zoom, timeline)).toEqual({ ...DEFAULT_STATE, x: 42 });
    }
    expect(isRegionTimeline(timeline)).toBe(true);
    expect(isRegionTimeline([])).toBe(false);
    expect(isRegionTimeline([legacy("old", 2)])).toBe(false);
    expect(isRegionTimeline([timeline[0], legacy("old", 2)])).toBe(false);
  });

  it("uses exact start dividers including 1x, without inheriting adjacent edits", () => {
    const timeline = [region("a", 0.05), region("b", 1, { transition: "snap" }), region("c", 2)];
    const el = element({ keyframes: { a: { x: 80, fill: "#ffffff" }, b: { y: 25 } } });
    expect(activeBreakpoint(0.99999, timeline)?.id).toBe("a");
    expect(activeBreakpoint(1, timeline)?.id).toBe("b");
    expect(presentationKeyForZoom(1, timeline)).toBe("b");
    expect(resolveStateDirect(el, 1, timeline)).toEqual({ ...DEFAULT_STATE, y: 25 });
    expect(presentationState(el, "b")).toEqual(resolveStateDirect(el, 1, timeline));
    expect(resolveStateDirect(el, 2, timeline)).toEqual(DEFAULT_STATE);
    el.keyframes.a.x = 999;
    el.keyframes.a.content = "Only A";
    expect(resolveStateDirect(el, 1, timeline)).toEqual({ ...DEFAULT_STATE, y: 25 });
    expect(resolveStateDirect(el, 2, timeline)).toEqual(DEFAULT_STATE);
  });

  it("smoothsteps in log2 zoom using asymmetric before/after widths", () => {
    const timeline = [region("a", 0.05), region("b", 1, { tweenIn: 0.2, tweenOut: 0.6 })];
    const el = element({ keyframes: { b: { x: 100 } } });
    const bounds = regionTweenBounds(timeline, "b");
    expect(bounds.start).toBeCloseTo(2 ** -0.2);
    expect(bounds.end).toBeCloseTo(2 ** 0.6);
    expect(resolveState(el, bounds.start, timeline)).toEqual(DEFAULT_STATE);
    expect(resolveState(el, bounds.end, timeline)).toEqual({ ...DEFAULT_STATE, x: 100 });
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const zoom = 2 ** (-0.2 + t * 0.8);
      expect(resolveState(el, zoom, timeline).x).toBeCloseTo(100 * t * t * (3 - 2 * t));
    }
    // The asymmetric divider is at t=.25, not the transition midpoint.
    expect(resolveState(el, 1, timeline).x).toBeCloseTo(15.625);
    expect(resolveStateDirect(el, 1, timeline).x).toBe(100);
  });

  it("defaults tween widths to .12 and ignores legacy transitionRange on regions", () => {
    const timeline = [region("a", 0.05), region("b", 1, { transitionRange: 50 })];
    const el = element({ keyframes: { b: { x: 100 } } });
    expect(regionTweenBounds(timeline, "b").start).toBeCloseTo(2 ** -0.12);
    expect(regionTweenBounds(timeline, "b").end).toBeCloseTo(2 ** 0.12);
    expect(resolveState(el, 1, timeline).x).toBeCloseTo(50);
    expect(resolveState(el, 0.5, timeline).x).toBe(0);
    expect(resolveState(el, 2, timeline).x).toBe(100);
  });

  it("clamps neighboring tweens at geometric midpoints with no overlap", () => {
    const timeline = [0.05, 0.5, 0.8, 1.3].map((zoom, index) =>
      region(`r${index}`, zoom, { tweenIn: 16, tweenOut: 16 }));
    const bounds = timeline.map((bp) => regionTweenBounds(timeline, bp.id));
    expect(bounds[0]).toEqual({ start: 0.05, end: 0.05 });
    expect(bounds[1].start).toBeCloseTo(Math.sqrt(0.05 * 0.5));
    expect(bounds[1].end).toBeCloseTo(Math.sqrt(0.5 * 0.8));
    expect(bounds[2].start).toBe(bounds[1].end);
    expect(bounds[2].end).toBe(bounds[3].start);
    expect(bounds[3].end).toBe(MAX_REGION_ZOOM);
    const el = element({ keyframes: { r1: { x: 10 }, r2: { x: 20 }, r3: { x: 30 } } });
    expect(resolveState(el, bounds[1].end, timeline).x).toBe(10);
    expect(resolveState(el, bounds[2].end, timeline).x).toBe(20);
  });

  it.each([
    { transition: "snap" as const, tweenIn: 1, tweenOut: 1 },
    { transition: "crossfade" as const, tweenIn: 0, tweenOut: 0 },
  ])("cuts exactly at zero-width or snap dividers: %j", (overrides) => {
    const timeline = [region("a", 0.05), region("b", 1, overrides)];
    const el = element({ keyframes: { a: { x: 10 }, b: { x: 20 } } });
    expect(regionTweenBounds(timeline, "b")).toEqual({ start: 1, end: 1 });
    expect(resolveState(el, 0.9999, timeline).x).toBe(10);
    expect(resolveState(el, 1, timeline).x).toBe(20);
    expect(resolveState(el, 1.0001, timeline).x).toBe(20);
  });

  it("supports one-sided tweens and never interpolates the first region", () => {
    const timeline = [region("a", 0.05, { tweenIn: 16, tweenOut: 16 }), region("b", 1, { tweenIn: 0, tweenOut: 1 })];
    const el = element({ keyframes: { a: { x: 10 }, b: { x: 20 } } });
    expect(resolveState(el, 0.05, timeline).x).toBe(10);
    expect(resolveState(el, 0.9, timeline).x).toBe(10);
    expect(resolveState(el, 1, timeline).x).toBe(10);
    expect(resolveState(el, Math.sqrt(2), timeline).x).toBeCloseTo(15);
    expect(resolveState(el, 2, timeline).x).toBe(20);
  });

  it("keeps the legacy below/base/above algorithm until explicit migration", () => {
    const timeline = [legacy("overview", 0.5), legacy("ignored", 1), legacy("detail", 2)];
    const el = element({ keyframes: { overview: { x: 10 }, ignored: { x: 999 }, detail: { x: 20 } } });
    expect(resolveStateDirect(el, 0.5, timeline).x).toBe(10);
    expect(resolveStateDirect(el, 0.51, timeline).x).toBe(0);
    expect(resolveStateDirect(el, 1, timeline).x).toBe(0);
    expect(resolveStateDirect(el, 2, timeline).x).toBe(20);
    expect(activeBreakpoint(1, timeline)).toBeUndefined();
  });
});

describe("region migration", () => {
  it("preserves independent below/base/above appearances, flattening variants and base overrides", () => {
    const original: Board = {
      breakpoints: [legacy("low", 0.25), legacy("near", 0.5), legacy("high", 2), legacy("highest", 4)],
      elements: [element({
        base: { ...DEFAULT_STATE, x: 3, width: 110 },
        keyframes: {
          __base__: { x: 7, fill: "#ff0000" },
          low: { x: 10 }, near: { y: 20 }, high: { x: 30 }, highest: { fill: DEFAULT_STATE.fill },
          dormant: { content: "Kept" },
        },
        variants: [
          { id: "baseVariant", name: "Base", patch: { fill: "#aa00aa", content: "Base content" } },
          { id: "lowVariant", name: "Low", patch: { fill: "#00ff00", width: 200 } },
          { id: "highVariant", name: "High", patch: { fill: "#0000ff", content: "Detail" } },
        ],
        variantAssignments: { __base__: "baseVariant", low: "lowVariant", high: "highVariant" },
      })],
    };
    const snapshot = structuredClone(original);
    const migrated = migrateToRegions(original);
    expect(original).toEqual(snapshot);
    expect(migrated.breakpoints.map((bp) => bp.zoom)).toEqual([0.05, 0.25, 0.5, 2, 4]);
    expect(migrated.breakpoints.map((bp) => bp.id)).toEqual(["low", "near", expect.any(String), "high", "highest"]);
    expect(migrated.breakpoints.every((bp) => bp.id !== BASE_KEYFRAME_ID)).toBe(true);
    const el = migrated.elements[0];
    expect(el.variants).toBeUndefined();
    expect(el.variantAssignments).toBeUndefined();
    expect(el.keyframes.__base__).toBeUndefined();
    expect(el.keyframes.dormant).toEqual({ content: "Kept" });
    expect(el.base).toEqual(original.elements[0].base);
    for (const zoom of [0.1, 0.35, 0.8, 1, 1.6, 2.5, 6]) {
      expect(resolveStateDirect(el, zoom, migrated.breakpoints))
        .toEqual(resolveStateDirect(original.elements[0], zoom, original.breakpoints));
    }
    expect(el.keyframes.low).toEqual({ x: 10, width: 200, fill: "#00ff00" });
    const baseRegion = migrated.breakpoints[2].id;
    expect(el.keyframes[baseRegion]).toEqual({ x: 7, fill: "#aa00aa", content: "Base content" });
    el.keyframes.low.fill = "#ffffff";
    expect(resolveStateDirect(el, 0.35, migrated.breakpoints).fill).toBe("#ff0000");
    expect(migrateToRegions(migrated)).toBe(migrated);
  });

  it("migrates an empty legacy timeline, including its base variant and base key", () => {
    const original: Board = {
      breakpoints: [],
      elements: [element({
        keyframes: { __base__: { x: 17, fill: "#ff0000" } },
        variants: [{ id: "v", name: "Base variant", patch: { fill: "#00ff00", content: "Hello" } }],
        variantAssignments: { __base__: "v" },
      })],
    };
    const migrated = migrateToRegions(original);
    expect(migrated.breakpoints).toHaveLength(1);
    expect(migrated.breakpoints[0].name).toBe("Region 1");
    expect(migrated.elements[0].keyframes.__base__).toBeUndefined();
    expect(migrated.elements[0].keyframes[migrated.breakpoints[0].id])
      .toEqual({ x: 17, fill: "#00ff00", content: "Hello" });
    expect(resolveStateDirect(migrated.elements[0], 4, migrated.breakpoints))
      .toEqual(presentationState(original.elements[0], BASE_KEYFRAME_ID));
  });

  it("compares sparse patches against defaulted base, not an implicit base key", () => {
    const base = { ...DEFAULT_STATE, x: 5 } as Partial<typeof DEFAULT_STATE>;
    delete base.fontFamily;
    const original: Board = {
      breakpoints: [],
      elements: [element({ base: base as typeof DEFAULT_STATE, keyframes: { __base__: { x: 20 } } })],
    };
    const migrated = migrateToRegions(original);
    expect(migrated.elements[0].keyframes[migrated.breakpoints[0].id]).toEqual({ x: 20 });
    expect(resolveStateDirect(migrated.elements[0], 1, migrated.breakpoints).fontFamily).toBe(DEFAULT_STATE.fontFamily);
  });

  it("moves legacy transition windows onto the right divider even below 1x", () => {
    const migrated = migrateToRegions({
      breakpoints: [legacy("overview", 0.5, 0.4), legacy("detail", 2, 0.2)], elements: [],
    });
    const baseRegion = migrated.breakpoints[1];
    expect(baseRegion.id).not.toBe("overview");
    expect(baseRegion.zoom).toBe(0.5);
    expect(baseRegion.tweenIn).toBeCloseTo(Math.log2(0.5 / 0.4));
    expect(baseRegion.tweenOut).toBeCloseTo(Math.log2(0.6 / 0.5));
    expect(migrated.breakpoints[2].tweenIn).toBeCloseTo(Math.log2(2 / 1.8));
    expect(migrated.breakpoints[2].tweenOut).toBeCloseTo(Math.log2(2.2 / 2));
    expect(regionTweenBounds(migrated.breakpoints, baseRegion.id).start).toBeCloseTo(0.4);
    expect(regionTweenBounds(migrated.breakpoints, baseRegion.id).end).toBeCloseTo(0.6);
    expect(migrated.breakpoints.every((bp) => bp.transitionRange === 0)).toBe(true);
  });

  it("preserves snap and zero-width legacy transitions", () => {
    const migrated = migrateToRegions({
      breakpoints: [{ ...legacy("low", 0.5, 0.4), transition: "snap" }, legacy("high", 2)], elements: [],
    });
    expect(migrated.breakpoints[1].transition).toBe("snap");
    expect(regionTweenBounds(migrated.breakpoints, migrated.breakpoints[1].id)).toEqual({ start: 0.5, end: 0.5 });
    expect(migrated.breakpoints[2]).toMatchObject({ tweenIn: 0, tweenOut: 0 });
  });

  it("ignores unsupported boundaries and the old 1x marker without mis-mapping states", () => {
    const original: Board = {
      breakpoints: [legacy("tiny", 0.01), legacy("minimum", 0.05), legacy("one", 1), legacy("maximum", 8), legacy("huge", 10)],
      elements: [element({ keyframes: { tiny: { x: 1 }, minimum: { x: 2 }, one: { x: 3 }, maximum: { x: 4 }, huge: { x: 5 } } })],
    };
    const migrated = migrateToRegions(original);
    expect(migrated.breakpoints.map((bp) => bp.zoom)).toEqual([0.05]);
    for (const zoom of [0.06, 0.2, 1, 2, 7.99]) {
      expect(resolveStateDirect(migrated.elements[0], zoom, migrated.breakpoints))
        .toEqual(resolveStateDirect(original.elements[0], zoom, original.breakpoints));
    }
  });
});
