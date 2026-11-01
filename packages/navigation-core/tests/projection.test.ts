import { describe, expect, it } from "vitest";
import { ManualClock, fromLocalMeters, isRouteUsable, projectPoint, projectPolyline, toLocalMeters, type ProjectionConfig } from "../src";

const center = { latitude: 21.0285, longitude: 105.8542 };
const cfg = (headingDegrees: number): ProjectionConfig => ({ center, headingDegrees, metersPerPixel: 2, anchor: [120, 150] });
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 3);

describe("local meters", () => {
  it("round-trips", () => {
    const p = fromLocalMeters(center, 123, -456);
    const back = toLocalMeters(center, p);
    near(back.east, 123);
    near(back.north, -456);
  });
});

describe("projectPoint", () => {
  it("puts the center at the anchor", () => {
    const [x, y] = projectPoint(center, cfg(0));
    near(x, 120);
    near(y, 150);
  });

  it("north is up when heading is 0", () => {
    const [x, y] = projectPoint(fromLocalMeters(center, 0, 100), cfg(0));
    near(x, 120);
    near(y, 100); // 100 m / 2 m per px
  });

  it("east is right when heading is 0", () => {
    const [x, y] = projectPoint(fromLocalMeters(center, 100, 0), cfg(0));
    near(x, 170);
    near(y, 150);
  });

  it("is heading-up: with heading 90 (east), a point to the east appears above", () => {
    const [x, y] = projectPoint(fromLocalMeters(center, 100, 0), cfg(90));
    near(x, 120);
    near(y, 100);
  });

  it("with heading 180, a point to the north appears below", () => {
    const [x, y] = projectPoint(fromLocalMeters(center, 0, 100), cfg(180));
    near(x, 120);
    near(y, 200);
  });

  it("projects polylines point by point", () => {
    expect(projectPolyline([center, center], cfg(0))).toHaveLength(2);
    expect(projectPolyline([], cfg(0))).toEqual([]);
  });
});

describe("isRouteUsable", () => {
  it("needs two points", () => {
    expect(isRouteUsable([])).toBe(false);
    expect(isRouteUsable([center])).toBe(false);
    expect(isRouteUsable([center, center])).toBe(true);
  });
});

describe("ManualClock", () => {
  it("advances deterministically", () => {
    const c = new ManualClock(10);
    c.advance(5);
    expect(c.nowMs()).toBe(15);
    c.set(1);
    expect(c.nowMs()).toBe(1);
  });
});
