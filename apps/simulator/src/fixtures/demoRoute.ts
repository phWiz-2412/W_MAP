import { fromLocalMeters, type RoutePoint } from "@w-map/navigation-core";

/**
 * Deterministic SIMULATED fixtures. The coordinates are arbitrary test values:
 * this is not real road data and not a real route.
 */
export const DEMO_ORIGIN: RoutePoint = { latitude: 21.0285, longitude: 105.8542 };

type Offset = readonly [east: number, north: number];

const toPoints = (offsets: readonly Offset[]): RoutePoint[] =>
  offsets.map(([e, n]) => fromLocalMeters(DEMO_ORIGIN, e, n));

const ROUTE_OFFSETS: readonly Offset[] = [
  [0, 0],
  [0, 300],
  [0, 600],
  [250, 600],
  [500, 600],
  [500, 900],
];

export const DEMO_ROUTE: readonly RoutePoint[] = toPoints(ROUTE_OFFSETS);

export interface BackdropRoad {
  id: string;
  name?: string;
  kind: "MAJOR" | "MINOR";
  points: readonly RoutePoint[];
}

/** Context roads drawn behind the route in MAP mode (simulated). */
export const DEMO_BACKDROP: readonly BackdropRoad[] = [
  { id: "b1", name: "Main St", kind: "MAJOR", points: toPoints([[0, -300], [0, 0], [0, 600], [0, 1000]]) },
  { id: "b2", name: "Ring Rd", kind: "MAJOR", points: toPoints([[-500, 600], [0, 600], [500, 600], [900, 600]]) },
  { id: "b3", kind: "MINOR", points: toPoints([[-250, 0], [-250, 600], [-250, 1000]]) },
  { id: "b4", kind: "MINOR", points: toPoints([[250, 200], [250, 600], [250, 900]]) },
  { id: "b5", name: "Park Ln", kind: "MINOR", points: toPoints([[-400, 300], [0, 300], [400, 300]]) },
  { id: "b6", kind: "MINOR", points: toPoints([[500, 300], [500, 600], [500, 1000]]) },
];

/** Position `percent` (0..100) along the demo route. */
export function positionAtProgress(percent: number): RoutePoint {
  const p = Math.min(100, Math.max(0, percent)) / 100;
  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < ROUTE_OFFSETS.length; i++) {
    const [e0, n0] = ROUTE_OFFSETS[i - 1]!;
    const [e1, n1] = ROUTE_OFFSETS[i]!;
    const len = Math.hypot(e1 - e0, n1 - n0);
    lens.push(len);
    total += len;
  }
  let remaining = p * total;
  for (let i = 0; i < lens.length; i++) {
    const len = lens[i]!;
    if (remaining <= len || i === lens.length - 1) {
      const [e0, n0] = ROUTE_OFFSETS[i]!;
      const [e1, n1] = ROUTE_OFFSETS[i + 1]!;
      const t = len === 0 ? 0 : Math.min(1, remaining / len);
      return fromLocalMeters(DEMO_ORIGIN, e0 + (e1 - e0) * t, n0 + (n1 - n0) * t);
    }
    remaining -= len;
  }
  return DEMO_ORIGIN;
}
