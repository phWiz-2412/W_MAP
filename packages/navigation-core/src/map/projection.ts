import type { RoutePoint } from "../domain/types";

/** A point in the 240x240 logical display space. */
export type ScreenPoint = readonly [number, number];

export interface ProjectionConfig {
  /** Geographic point drawn at `anchor`. */
  center: RoutePoint;
  /** Heading drawn "up", degrees clockwise from north. */
  headingDegrees: number;
  metersPerPixel: number;
  /** Where `center` appears on the display. */
  anchor: ScreenPoint;
}

const METERS_PER_DEG_LAT = 110_540;
const METERS_PER_DEG_LON_EQUATOR = 111_320;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Local flat-earth offset in meters (east, north). Adequate for the few-km scale of a display. */
export function toLocalMeters(origin: RoutePoint, p: RoutePoint): { east: number; north: number } {
  return {
    east: (p.longitude - origin.longitude) * Math.cos(toRad(origin.latitude)) * METERS_PER_DEG_LON_EQUATOR,
    north: (p.latitude - origin.latitude) * METERS_PER_DEG_LAT,
  };
}

/** Inverse of toLocalMeters. */
export function fromLocalMeters(origin: RoutePoint, east: number, north: number): RoutePoint {
  return {
    latitude: origin.latitude + north / METERS_PER_DEG_LAT,
    longitude: origin.longitude + east / (Math.cos(toRad(origin.latitude)) * METERS_PER_DEG_LON_EQUATOR),
  };
}

/** Project a geographic point into display space, heading-up. */
export function projectPoint(p: RoutePoint, cfg: ProjectionConfig): ScreenPoint {
  const { east, north } = toLocalMeters(cfg.center, p);
  const h = toRad(cfg.headingDegrees);
  const forward = north * Math.cos(h) + east * Math.sin(h);
  const right = east * Math.cos(h) - north * Math.sin(h);
  return [cfg.anchor[0] + right / cfg.metersPerPixel, cfg.anchor[1] - forward / cfg.metersPerPixel];
}

export function projectPolyline(points: readonly RoutePoint[], cfg: ProjectionConfig): ScreenPoint[] {
  return points.map((p) => projectPoint(p, cfg));
}

/** A route needs at least two points to be drawn. */
export function isRouteUsable(points: readonly RoutePoint[]): boolean {
  return points.length >= 2;
}
