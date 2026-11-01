import {
  bearingDegrees,
  haversineDistanceMeters,
  interpolateRoutePosition,
  resolveStepAtProgress,
  validateCalculatedRoute,
  type BackdropRoad,
  type CalculatedRoute,
  type Clock,
  type RouteFixture,
  type RoutePoint,
  type RouteStepModel,
  type SpeedLimitStatus,
  type TurnDirection,
  systemClock,
} from "@w-map/navigation-core";

export interface RouteStepSegment {
  turnDirection: TurnDirection;
  distanceMeters: number;
  headingDegrees: number | null;
  instruction?: string;
  /**
   * Verified speed limit in km/h, or null when unverified/unavailable.
   * Providers MUST NOT guess a speed limit; if the upstream service does not supply a verified limit,
   * set `speedLimitKmh: null` and `speedLimitStatus: "UNKNOWN"`.
   */
  speedLimitKmh: number | null;
  speedLimitStatus: SpeedLimitStatus;
}

export interface RouteGuidanceResult {
  providerId: string;
  /** True when the route comes from synthetic test fixtures rather than a real map service. */
  isSynthetic: boolean;
  /** Required attribution string (e.g., "© OpenStreetMap contributors, ODbL") when using real data. */
  attribution: string;
  routePoints: readonly RoutePoint[];
  steps: readonly RouteStepSegment[];
  backdropRoads?: readonly BackdropRoad[];
}

export interface RouteQuery {
  origin: RoutePoint;
  destination: RoutePoint;
  waypoints?: readonly RoutePoint[];
  signal?: AbortSignal;
}

/**
 * Provider interface for map geometry and route calculation.
 * Kept separate from `navigation-core` and display components so OpenStreetMap / OSRM / Valhalla
 * adapters or offline synthetic providers can be swapped without modifying the 240x240 SVG display.
 */
export interface MapRouteProvider {
  readonly id: string;
  readonly label: string;
  readonly isSynthetic: boolean;
  readonly attribution: string;
  /** Fetch or compute a route between origin and destination. */
  fetchRoute(query: RouteQuery): Promise<RouteGuidanceResult>;
  /** Calculate a full validated `CalculatedRoute` model for turn-by-turn progress tracking. */
  calculateRoute(query: RouteQuery): Promise<CalculatedRoute>;
}

/**
 * Map an OSRM step maneuver (`type`, `modifier`) to a W_MAP `TurnDirection`.
 */
export function parseOsrmManeuver(type: unknown, modifier: unknown): TurnDirection {
  const t = typeof type === "string" ? type.toLowerCase() : "";
  const m = typeof modifier === "string" ? modifier.toLowerCase() : "";
  if (t === "roundabout" || t === "rotary" || t === "roundabout turn" || t === "exit roundabout" || t === "exit rotary") {
    return "ROUNDABOUT";
  }
  if (m === "uturn") return "U_TURN";
  if (m.includes("left")) return "LEFT";
  if (m.includes("right")) return "RIGHT";
  return "STRAIGHT";
}

/**
 * Offline synthetic provider backed by validated local `RouteFixture` objects or a generated
 * synthetic multi-step urban grid path between any origin and destination.
 * Performs zero network calls and clearly marks all data as synthetic.
 */
export class SyntheticFixtureMapProvider implements MapRouteProvider {
  readonly id = "synthetic-vn-fixture";
  readonly label = "Offline Synthetic Vietnam Route Provider (No Internet Required)";
  readonly isSynthetic = true;
  readonly attribution = "Synthetic test data — not real Vietnamese map data";

  private activeFixture: RouteFixture;
  private readonly clock: Clock;

  constructor(initialFixture: RouteFixture, clock: Clock = systemClock) {
    this.activeFixture = initialFixture;
    this.clock = clock;
  }

  setFixture(fixture: RouteFixture): void {
    this.activeFixture = fixture;
  }

  getFixture(): RouteFixture {
    return this.activeFixture;
  }

  async fetchRoute(_query: RouteQuery): Promise<RouteGuidanceResult> {
    const f = this.activeFixture;
    return {
      providerId: this.id,
      isSynthetic: true,
      attribution: this.attribution,
      routePoints: f.routePoints,
      steps: f.steps.map((s) => ({
        turnDirection: s.turnDirection,
        distanceMeters: s.distanceToTurnMeters ?? 0,
        headingDegrees: s.headingDegrees,
        ...(s.instruction !== undefined ? { instruction: s.instruction } : {}),
        speedLimitKmh: s.speedLimitKmh,
        speedLimitStatus: s.speedLimitStatus,
      })),
      ...(f.backdropRoads !== undefined ? { backdropRoads: f.backdropRoads } : {}),
    };
  }

  /**
   * Generate a deterministic synthetic L-shaped or multi-step route between `query.origin` and `query.destination`.
   * Speed limits are explicitly kept `UNKNOWN` (`null`) unless a fixture step with a verified test limit is used.
   */
  async calculateRoute(query: RouteQuery): Promise<CalculatedRoute> {
    if (query.signal?.aborted) {
      throw new DOMException("Route request aborted", "AbortError");
    }
    const { origin, destination } = query;
    const corner1: RoutePoint = {
      latitude: origin.latitude + (destination.latitude - origin.latitude) * 0.5,
      longitude: origin.longitude,
    };
    const corner2: RoutePoint = {
      latitude: corner1.latitude,
      longitude: destination.longitude,
    };
    const geometry: RoutePoint[] = [origin, corner1, corner2, destination];
    const d1 = Math.round(haversineDistanceMeters(origin.latitude, origin.longitude, corner1.latitude, corner1.longitude));
    const d2 = Math.round(haversineDistanceMeters(corner1.latitude, corner1.longitude, corner2.latitude, corner2.longitude));
    const d3 = Math.round(haversineDistanceMeters(corner2.latitude, corner2.longitude, destination.latitude, destination.longitude));
    const total = d1 + d2 + d3;

    const h1 = Math.round(bearingDegrees(origin.latitude, origin.longitude, corner1.latitude, corner1.longitude)) % 360;
    const h2 = Math.round(bearingDegrees(corner1.latitude, corner1.longitude, corner2.latitude, corner2.longitude)) % 360;
    const h3 = Math.round(bearingDegrees(corner2.latitude, corner2.longitude, destination.latitude, destination.longitude)) % 360;
    const turn1: TurnDirection = destination.longitude >= origin.longitude ? "RIGHT" : "LEFT";
    const turn2: TurnDirection = destination.latitude >= origin.latitude ? "LEFT" : "RIGHT";

    const steps: RouteStepModel[] = [
      {
        turnDirection: turn1,
        maneuverLocation: corner1,
        distanceMeters: d1,
        durationSeconds: Math.round(d1 / 10),
        headingDegrees: h1,
        instruction: `Proceed ${d1} m then turn ${turn1.toLowerCase()} (synthetic route)`,
        speedLimitKmh: null,
        speedLimitStatus: "UNKNOWN",
      },
      {
        turnDirection: turn2,
        maneuverLocation: corner2,
        distanceMeters: d2,
        durationSeconds: Math.round(d2 / 10),
        headingDegrees: h2,
        instruction: `Continue ${d2} m then turn ${turn2.toLowerCase()} toward destination (synthetic route)`,
        speedLimitKmh: null,
        speedLimitStatus: "UNKNOWN",
      },
      {
        turnDirection: "STRAIGHT",
        maneuverLocation: destination,
        distanceMeters: d3,
        durationSeconds: Math.round(d3 / 10),
        headingDegrees: h3,
        instruction: "Arrive at destination (synthetic route)",
        speedLimitKmh: null,
        speedLimitStatus: "UNKNOWN",
      },
    ];

    const candidate: CalculatedRoute = {
      routeId: `syn-${this.clock.nowMs()}`,
      providerId: this.id,
      isSynthetic: true,
      attribution: this.attribution,
      calculatedAtMs: this.clock.nowMs(),
      origin,
      destination,
      totalDistanceMeters: total,
      estimatedDurationSeconds: Math.round(total / 10),
      geometry,
      steps,
    };

    const validated = validateCalculatedRoute(candidate);
    if (!validated.ok) {
      throw new Error(`Synthetic route validation failed: ${validated.errors.join("; ")}`);
    }
    return validated.value;
  }

  /** Evaluate position and active step along the currently loaded fixture at `progressPercent` (0..100). */
  evaluateAtProgress(progressPercent: number) {
    const f = this.activeFixture;
    const step = resolveStepAtProgress(f.steps, progressPercent);
    const position = interpolateRoutePosition(f.routePoints, progressPercent, f.initialState.fallbackPosition);
    return { step, position };
  }
}

export interface OsrmRouteProviderOptions {
  /** Base OSRM URL (e.g. a local Docker OSRM instance or public demo endpoint for low-volume testing). */
  baseUrl?: string;
  profile?: string;
  timeoutMs?: number;
  clock?: Clock;
  fetchFn?: typeof fetch;
}

/**
 * OSRM-compatible HTTP routing provider (`geometries=geojson&steps=true`).
 * - Validates all external route geometry and step coordinates via `validateCalculatedRoute`.
 * - Never infers or fabricates speed limits (`speedLimitKmh: null`, `speedLimitStatus: "UNKNOWN"`).
 * - Uses timeouts and `AbortSignal` cancellation; never called on every GPS tick.
 */
export class OsrmRouteProvider implements MapRouteProvider {
  readonly id = "osrm-http";
  readonly label = "OSRM Routing Service (OpenStreetMap)";
  readonly isSynthetic = false;
  readonly attribution = "© OpenStreetMap contributors (ODbL) — Routing via OSRM";

  private readonly baseUrl: string;
  private readonly profile: string;
  private readonly timeoutMs: number;
  private readonly clock: Clock;
  private readonly fetchFn: typeof fetch;

  constructor(options: OsrmRouteProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://router.project-osrm.org").replace(/\/$/, "");
    this.profile = options.profile ?? "driving";
    this.timeoutMs = options.timeoutMs ?? 7000;
    this.clock = options.clock ?? systemClock;
    this.fetchFn = options.fetchFn ?? ((...args) => fetch(...args));
  }

  async fetchRoute(query: RouteQuery): Promise<RouteGuidanceResult> {
    const route = await this.calculateRoute(query);
    return {
      providerId: route.providerId,
      isSynthetic: route.isSynthetic,
      attribution: route.attribution,
      routePoints: route.geometry,
      steps: route.steps.map((s) => ({
        turnDirection: s.turnDirection,
        distanceMeters: s.distanceMeters,
        headingDegrees: s.headingDegrees,
        instruction: s.instruction,
        speedLimitKmh: s.speedLimitKmh,
        speedLimitStatus: s.speedLimitStatus,
      })),
    };
  }

  async calculateRoute(query: RouteQuery): Promise<CalculatedRoute> {
    const { origin, destination } = query;
    const coordsStr = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
    const url = `${this.baseUrl}/route/v1/${this.profile}/${coordsStr}?overview=full&geometries=geojson&steps=true`;

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    query.signal?.addEventListener("abort", onExternalAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Routing HTTP ${response.status}`);
      }
      const raw: unknown = await response.json();
      if (typeof raw !== "object" || raw === null) {
        throw new Error("Malformed OSRM response");
      }
      const body = raw as Record<string, unknown>;
      if (body.code !== "Ok" || !Array.isArray(body.routes) || body.routes.length === 0) {
        throw new Error(`Route unavailable (${String(body.code ?? "no routes")})`);
      }
      const primary = body.routes[0] as Record<string, unknown>;
      const geomObj = primary.geometry as { type?: unknown; coordinates?: unknown } | undefined;
      if (!geomObj || geomObj.type !== "LineString" || !Array.isArray(geomObj.coordinates) || geomObj.coordinates.length < 2) {
        throw new Error("Invalid or empty route geometry in OSRM response");
      }

      const geometry: RoutePoint[] = [];
      for (const pair of geomObj.coordinates) {
        if (!Array.isArray(pair) || pair.length < 2) {
          throw new Error("Malformed coordinate pair in OSRM geometry");
        }
        const lon = Number(pair[0]);
        const lat = Number(pair[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          throw new Error("Non-finite coordinate in OSRM geometry");
        }
        geometry.push({ latitude: lat, longitude: lon });
      }

      const legs = Array.isArray(primary.legs) ? (primary.legs as Record<string, unknown>[]) : [];
      const rawSteps = legs[0] && Array.isArray(legs[0].steps) ? (legs[0].steps as Record<string, unknown>[]) : [];
      const steps: RouteStepModel[] = [];

      for (const rs of rawSteps) {
        const man = (rs.maneuver ?? {}) as Record<string, unknown>;
        const loc = Array.isArray(man.location) ? man.location : null;
        const lon = loc ? Number(loc[0]) : NaN;
        const lat = loc ? Number(loc[1]) : NaN;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        const turnDirection = parseOsrmManeuver(man.type, man.modifier);
        const roadName = typeof rs.name === "string" && rs.name.trim().length > 0 ? rs.name.trim() : "road";
        const manType = typeof man.type === "string" ? man.type : "continue";
        const modifier = typeof man.modifier === "string" ? ` (${man.modifier})` : "";
        const dist = typeof rs.distance === "number" && Number.isFinite(rs.distance) && rs.distance >= 0 ? Math.round(rs.distance) : 0;
        const dur = typeof rs.duration === "number" && Number.isFinite(rs.duration) && rs.duration >= 0 ? Math.round(rs.duration) : null;
        const bearingAfter =
          typeof man.bearing_after === "number" && Number.isFinite(man.bearing_after) && man.bearing_after >= 0 && man.bearing_after < 360
            ? Math.round(man.bearing_after)
            : null;

        steps.push({
          turnDirection,
          maneuverLocation: { latitude: lat, longitude: lon },
          distanceMeters: dist,
          durationSeconds: dur,
          headingDegrees: bearingAfter,
          instruction: `${manType}${modifier} onto ${roadName}`,
          // OSRM does not provide verified legal speed limits; keep explicitly UNKNOWN.
          speedLimitKmh: null,
          speedLimitStatus: "UNKNOWN",
        });
      }

      if (steps.length === 0) {
        steps.push({
          turnDirection: "STRAIGHT",
          maneuverLocation: destination,
          distanceMeters: typeof primary.distance === "number" ? Math.round(primary.distance) : 0,
          durationSeconds: typeof primary.duration === "number" ? Math.round(primary.duration) : null,
          headingDegrees: null,
          instruction: "Proceed to destination",
          speedLimitKmh: null,
          speedLimitStatus: "UNKNOWN",
        });
      }

      const candidate: CalculatedRoute = {
        routeId: `osrm-${this.clock.nowMs()}`,
        providerId: this.id,
        isSynthetic: false,
        attribution: this.attribution,
        calculatedAtMs: this.clock.nowMs(),
        origin,
        destination,
        totalDistanceMeters: typeof primary.distance === "number" && primary.distance >= 0 ? Math.round(primary.distance) : 0,
        estimatedDurationSeconds: typeof primary.duration === "number" && primary.duration >= 0 ? Math.round(primary.duration) : null,
        geometry,
        steps,
      };

      const validated = validateCalculatedRoute(candidate);
      if (!validated.ok) {
        throw new Error(`Invalid OSRM route: ${validated.errors.join("; ")}`);
      }
      return validated.value;
    } finally {
      clearTimeout(timer);
      query.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
