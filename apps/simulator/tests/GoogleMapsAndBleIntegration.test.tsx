import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  ManualClock,
  encodeGooglePolyline,
  type RoutePoint,
} from "@w-map/navigation-core";
import App from "../src/App";
import { createGoogleMapsProxyMiddleware } from "../relay/googleMapsProxy";
import { GooglePlacesGeocodingProvider } from "../src/services/GeocodingProvider";
import {
  GoogleRoutesProvider,
  parseGoogleManeuver,
} from "../src/services/MapRouteProvider";
import { SimulatorService } from "../src/services/SimulatorService";
import { instant } from "./helpers";

function createMockReqRes(method: string, url: string, bodyObj?: unknown) {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = url;

  let statusCode = 200;
  const headers: Record<string, string> = {};
  let responseBody = "";

  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(v: number) {
      statusCode = v;
    },
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
    },
    end(chunk?: string) {
      if (chunk) responseBody += chunk;
    },
  } as unknown as ServerResponse;

  const triggerBody = () => {
    if (bodyObj !== undefined) {
      req.emit("data", Buffer.from(JSON.stringify(bodyObj), "utf8"));
    }
    req.emit("end");
  };

  return { req, res, triggerBody, getResult: () => ({ statusCode, headers, body: JSON.parse(responseBody || "{}") }) };
}

describe("Google Maps Platform — Places API v1 & Routes API v2 Providers", () => {
  it("GooglePlacesGeocodingProvider parses valid places and skips invalid coordinates", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        places: [
          {
            id: "ChIJ-ben-thanh",
            displayName: { text: "Chợ Bến Thành" },
            formattedAddress: "Lê Lợi, Phường Bến Thành, Quận 1, Hồ Chí Minh, Việt Nam",
            location: { latitude: 10.7725, longitude: 106.698 },
            primaryType: "market",
          },
          {
            id: "bad-coords",
            displayName: { text: "Out of bounds" },
            location: { latitude: 190, longitude: 106 },
          },
        ],
      }),
    });

    const provider = new GooglePlacesGeocodingProvider({
      fetchFn: fakeFetch as unknown as typeof fetch,
    });
    const results = await provider.search("Ben Thanh");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "gplace-ChIJ-ben-thanh",
      name: "Chợ Bến Thành",
      location: { latitude: 10.7725, longitude: 106.698 },
      isSynthetic: false,
      attribution: "Google Maps",
    });
  });

  it("GooglePlacesGeocodingProvider returns empty array when places field is omitted", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    const provider = new GooglePlacesGeocodingProvider({
      fetchFn: fakeFetch as unknown as typeof fetch,
    });
    expect(await provider.search("xyznomatch")).toEqual([]);
  });

  it("maps Google Routes API v2 maneuvers to W_MAP TurnDirection", () => {
    expect(parseGoogleManeuver("TURN_LEFT")).toBe("LEFT");
    expect(parseGoogleManeuver("TURN_SHARP_LEFT")).toBe("LEFT");
    expect(parseGoogleManeuver("TURN_SLIGHT_RIGHT")).toBe("RIGHT");
    expect(parseGoogleManeuver("UTURN_LEFT")).toBe("U_TURN");
    expect(parseGoogleManeuver("ROUNDABOUT_RIGHT")).toBe("ROUNDABOUT");
    expect(parseGoogleManeuver("DEPART")).toBe("STRAIGHT");
  });

  it("GoogleRoutesProvider sends route preferences, decodes polyline, and keeps speed limits UNKNOWN", async () => {
    const pts: RoutePoint[] = [
      { latitude: 16.0611, longitude: 108.2272 },
      { latitude: 16.0635, longitude: 108.2272 },
      { latitude: 16.0635, longitude: 108.231 },
    ];
    const encodedPoly = encodeGooglePolyline(pts);

    let capturedBody: Record<string, unknown> | null = null;
    const fakeFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          routes: [
            {
              distanceMeters: 680,
              duration: "95s",
              polyline: { encodedPolyline: encodedPoly },
              legs: [
                {
                  distanceMeters: 680,
                  duration: "95s",
                  steps: [
                    {
                      distanceMeters: 270,
                      staticDuration: "38s",
                      startLocation: { latLng: pts[0] },
                      endLocation: { latLng: pts[1] },
                      navigationInstruction: {
                        maneuver: "TURN_RIGHT",
                        instructions: "Turn right onto Đường Bạch Đằng",
                      },
                    },
                    {
                      distanceMeters: 410,
                      staticDuration: "57s",
                      startLocation: { latLng: pts[1] },
                      endLocation: { latLng: pts[2] },
                      navigationInstruction: {
                        maneuver: "STRAIGHT",
                        instructions: "Arrive at Cầu Rồng",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      };
    });

    const router = new GoogleRoutesProvider({
      clock: new ManualClock(5000),
      fetchFn: fakeFetch as unknown as typeof fetch,
    });

    const route = await router.calculateRoute({
      origin: pts[0]!,
      destination: pts[2]!,
      preferences: {
        travelMode: "TWO_WHEELER",
        avoidHighways: true,
        avoidTolls: true,
        avoidFerries: false,
      },
    });

    expect(capturedBody).toMatchObject({
      preferences: {
        travelMode: "TWO_WHEELER",
        avoidHighways: true,
        avoidTolls: true,
        avoidFerries: false,
      },
    });
    expect(route.isSynthetic).toBe(false);
    expect(route.providerId).toBe("google-routes-v2");
    expect(route.totalDistanceMeters).toBe(680);
    expect(route.estimatedDurationSeconds).toBe(95);
    expect(route.steps).toHaveLength(2);
    expect(route.steps[0]?.turnDirection).toBe("RIGHT");
    expect(route.steps[0]?.instruction).toContain("Đường Bạch Đằng");
    expect(route.steps[0]?.speedLimitKmh).toBeNull();
    expect(route.steps[0]?.speedLimitStatus).toBe("UNKNOWN");
  });
});

describe("Server-Side Google Maps Proxy Middleware (API Key Security)", () => {
  it("reports configured=false and returns 503 when GOOGLE_MAPS_SERVER_API_KEY is missing", async () => {
    const middleware = createGoogleMapsProxyMiddleware({
      getApiKey: () => undefined,
    });

    const st = createMockReqRes("GET", "/api/google/status");
    await middleware(st.req, st.res, () => {});
    expect(st.getResult()).toMatchObject({
      statusCode: 200,
      body: { configured: false },
    });

    const pl = createMockReqRes("POST", "/api/google/places", { textQuery: "Da Nang" });
    const pPromise = middleware(pl.req, pl.res, () => {});
    pl.triggerBody();
    await pPromise;
    expect(pl.getResult().statusCode).toBe(503);
    expect(pl.getResult().body.error).toMatch(/GOOGLE_MAPS_SERVER_API_KEY is not configured/);
  });

  it("injects X-Goog-Api-Key and X-Goog-FieldMask on server side without leaking key to client", async () => {
    let upstreamHeaders: Record<string, string> = {};
    const fakeUpstream = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      upstreamHeaders = (init?.headers ?? {}) as Record<string, string>;
      return {
        status: 200,
        json: async () => ({ places: [] }),
      };
    });

    const middleware = createGoogleMapsProxyMiddleware({
      getApiKey: () => "test-server-secret-key-do-not-expose",
      fetchFn: fakeUpstream as unknown as typeof fetch,
    });

    const pl = createMockReqRes("POST", "/api/google/places", { textQuery: "Cầu Rồng" });
    const pPromise = middleware(pl.req, pl.res, () => {});
    pl.triggerBody();
    await pPromise;

    expect(upstreamHeaders["X-Goog-Api-Key"]).toBe("test-server-secret-key-do-not-expose");
    expect(upstreamHeaders["X-Goog-FieldMask"]).toContain("places.location");
    expect(JSON.stringify(pl.getResult().body)).not.toContain("test-server-secret-key-do-not-expose");
  });
});

describe("UI Route Preferences & Non-Fallback Error Handling", () => {
  it("passes route preferences (Avoid Highways, Avoid Tolls, Travel Mode) and never silently falls back to synthetic routes on failure", async () => {
    const clock = new ManualClock(20_000);
    const sim = new SimulatorService({ clock });

    let receivedPrefs: unknown = null;
    const failingGoogleRouter = new GoogleRoutesProvider({
      clock,
      fetchFn: (async (_url: string, init?: RequestInit) => {
        receivedPrefs = JSON.parse(String(init?.body ?? "{}")).preferences;
        return {
          ok: false,
          status: 503,
          json: async () => ({
            error: "GOOGLE_MAPS_SERVER_API_KEY is not configured in server environment (.env).",
          }),
        } as Response;
      }) as unknown as typeof fetch,
    });

    render(
      <App
        simulator={sim}
        routingProvider={failingGoogleRouter}
        warningBase={instant}
        clock={clock}
      />,
    );

    // Toggle "Avoid toll roads" and switch travel mode to "DRIVE"
    fireEvent.click(screen.getByTestId("pref-avoid-tolls"));
    fireEvent.change(screen.getByTestId("pref-travel-mode"), { target: { value: "DRIVE" } });

    // Click map to request route
    fireEvent.click(screen.getByTestId("planning-map-svg"), { clientX: 240, clientY: 120 });

    await waitFor(() => {
      expect(screen.getByTestId("planner-route-status")).toHaveTextContent("ERROR");
    });

    expect(receivedPrefs).toEqual({
      travelMode: "DRIVE",
      avoidHighways: true,
      avoidTolls: true,
      avoidFerries: false,
    });
    expect(screen.getByTestId("route-error")).toHaveTextContent(/GOOGLE_MAPS_SERVER_API_KEY/i);
    // Verify no fabricated route polyline was drawn on the planning map
    expect(screen.queryByTestId("planning-map-route")).not.toBeInTheDocument();
  });
});
