import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ManualClock, fromLocalMeters, type CalculatedRoute, type RoutePoint } from "@w-map/navigation-core";
import App from "../src/App";
import {
  NominatimGeocodingProvider,
  SyntheticVnGeocodingProvider,
} from "../src/services/GeocodingProvider";
import { LivePhoneProvider, type SocketLike } from "../src/services/LivePhoneProvider";
import {
  OsrmRouteProvider,
  SyntheticFixtureMapProvider,
  parseOsrmManeuver,
  type MapRouteProvider,
  type RouteQuery,
} from "../src/services/MapRouteProvider";
import { SimulatorService } from "../src/services/SimulatorService";
import { DEFAULT_VN_FIXTURE } from "../src/fixtures/vnFixtures";
import { instant } from "./helpers";

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {
    this.onclose?.();
  }
  open() {
    this.onopen?.();
  }
  receive(obj: unknown) {
    this.onmessage?.({ data: typeof obj === "string" ? obj : JSON.stringify(obj) });
  }
}

describe("GeocodingProvider (Offline Synthetic & Nominatim HTTP)", () => {
  it("finds ambiguous Vietnamese street names (e.g. 'Le Loi' in both Hanoi and HCMC) without diacritics", async () => {
    const geo = new SyntheticVnGeocodingProvider();
    const matches = await geo.search("le loi");
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches.some((m) => m.displayName.includes("Hà Nội"))).toBe(true);
    expect(matches.some((m) => m.displayName.includes("Hồ Chí Minh"))).toBe(true);
  });

  it("returns empty array for unmatched queries", async () => {
    const geo = new SyntheticVnGeocodingProvider();
    expect(await geo.search("nonexistent place xyz 999")).toEqual([]);
  });

  it("NominatimGeocodingProvider parses valid results and skips malformed entries", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          place_id: 101,
          name: "Chợ Bến Thành",
          display_name: "Chợ Bến Thành, Quận 1, TP.HCM, Việt Nam",
          type: "marketplace",
          lat: "10.7725",
          lon: "106.6980",
        },
        { place_id: 102, display_name: "Invalid Coords", lat: "999", lon: "0" },
      ],
    });
    const nom = new NominatimGeocodingProvider({ fetchFn: fakeFetch as unknown as typeof fetch });
    const res = await nom.search("Ben Thanh");
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      name: "Chợ Bến Thành",
      location: { latitude: 10.7725, longitude: 106.698 },
      isSynthetic: false,
    });
  });

  it("NominatimGeocodingProvider surfaces HTTP errors cleanly", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const nom = new NominatimGeocodingProvider({ fetchFn: fakeFetch as unknown as typeof fetch });
    await expect(nom.search("Hanoi")).rejects.toThrow(/503/);
  });
});

describe("OsrmRouteProvider & parseOsrmManeuver", () => {
  it("maps OSRM maneuver types and modifiers to W_MAP TurnDirection", () => {
    expect(parseOsrmManeuver("roundabout", "right")).toBe("ROUNDABOUT");
    expect(parseOsrmManeuver("rotary", "straight")).toBe("ROUNDABOUT");
    expect(parseOsrmManeuver("turn", "uturn")).toBe("U_TURN");
    expect(parseOsrmManeuver("turn", "sharp left")).toBe("LEFT");
    expect(parseOsrmManeuver("turn", "slight right")).toBe("RIGHT");
    expect(parseOsrmManeuver("depart", "straight")).toBe("STRAIGHT");
  });

  it("validates a well-formed OSRM route and keeps speed limits explicitly UNKNOWN", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: "Ok",
        routes: [
          {
            distance: 650,
            duration: 85,
            geometry: {
              type: "LineString",
              coordinates: [
                [105.8542, 21.0285],
                [105.8542, 21.0315],
                [105.8575, 21.0315],
              ],
            },
            legs: [
              {
                steps: [
                  {
                    name: "Phố Hàng Bài",
                    distance: 330,
                    duration: 40,
                    maneuver: { type: "turn", modifier: "right", bearing_after: 90, location: [105.8542, 21.0315] },
                  },
                  {
                    name: "Phố Tràng Tiền",
                    distance: 320,
                    duration: 45,
                    maneuver: { type: "arrive", modifier: "straight", bearing_after: 90, location: [105.8575, 21.0315] },
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    const osrm = new OsrmRouteProvider({
      clock: new ManualClock(2000),
      fetchFn: fakeFetch as unknown as typeof fetch,
    });
    const route = await osrm.calculateRoute({
      origin: { latitude: 21.0285, longitude: 105.8542 },
      destination: { latitude: 21.0315, longitude: 105.8575 },
    });
    expect(route.isSynthetic).toBe(false);
    expect(route.totalDistanceMeters).toBe(650);
    expect(route.steps).toHaveLength(2);
    expect(route.steps[0]?.turnDirection).toBe("RIGHT");
    expect(route.steps[0]?.speedLimitKmh).toBeNull();
    expect(route.steps[0]?.speedLimitStatus).toBe("UNKNOWN");
  });

  it("rejects malformed or empty OSRM route geometry", async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        code: "Ok",
        routes: [{ distance: 0, duration: 0, geometry: { type: "LineString", coordinates: [[105.85, 21.02]] } }],
      }),
    });
    const osrm = new OsrmRouteProvider({ fetchFn: fakeFetch as unknown as typeof fetch });
    await expect(
      osrm.calculateRoute({
        origin: { latitude: 21.02, longitude: 105.85 },
        destination: { latitude: 21.03, longitude: 105.86 },
      }),
    ).rejects.toThrow(/Invalid or empty route geometry/);
  });
});

describe("App Destination Search, Map Selection, Live Progress & Off-Route Rerouting", () => {
  it("searches for a destination, selects a match, calculates a route, and updates TURN and MAP displays", async () => {
    const clock = new ManualClock(50_000);
    const sim = new SimulatorService({ clock });
    const geocoder = new SyntheticVnGeocodingProvider();
    const router = new SyntheticFixtureMapProvider(DEFAULT_VN_FIXTURE, clock);

    render(
      <App
        simulator={sim}
        geocodingProvider={geocoder}
        routingProvider={router}
        warningBase={instant}
        clock={clock}
      />,
    );

    // Search for "Le Loi" -> returns ambiguous Hanoi & HCMC matches
    const input = screen.getByLabelText(/Search destination/i);
    fireEvent.change(input, { target: { value: "Le Loi" } });
    fireEvent.click(screen.getByTestId("dest-search-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("search-results")).toBeInTheDocument();
    });
    expect(screen.getByTestId("search-result-vn-poi-le-loi-hn")).toBeInTheDocument();
    expect(screen.getByTestId("search-result-vn-poi-le-loi-hcm")).toBeInTheDocument();

    // Select Hanoi Le Loi street
    fireEvent.click(screen.getByTestId("search-result-vn-poi-le-loi-hn"));

    await waitFor(() => {
      expect(screen.getByTestId("planner-route-status")).toHaveTextContent("ACTIVE");
    });

    // Planning map renders route & destination marker
    expect(screen.getByTestId("planning-map-route")).toBeInTheDocument();
    expect(screen.getByTestId("planning-map-destination")).toBeInTheDocument();

    // Compact 240x240 display shows UNKNOWN speed limit (never inferred from routing)
    expect(screen.getByTestId("limit-value")).toHaveTextContent("--");
    expect(screen.getByTestId("navigation-display")).toHaveAttribute("data-speed-state", "UNKNOWN_LIMIT");

    // Switch to MAP mode and verify compact route is rendered
    fireEvent.change(screen.getByLabelText("Navigation mode"), { target: { value: "MAP" } });
    expect(screen.getByTestId("map-route")).toBeInTheDocument();

    // Clear destination
    fireEvent.click(screen.getByTestId("clear-destination-btn"));
    expect(screen.getByTestId("planner-route-status")).toHaveTextContent("IDLE");
    expect(screen.queryByTestId("planning-map-destination")).not.toBeInTheDocument();
  });

  it("selects a destination by clicking the planning map, tracks live GPS progress, and reroutes only when off-route", async () => {
    const clock = new ManualClock(100_000);
    let socket: FakeSocket | null = null;
    const liveFactory = () =>
      new LivePhoneProvider({
        url: "ws://test/ws",
        clock,
        heartbeatMs: 0,
        reconnectMs: 0,
        socketFactory: () => (socket = new FakeSocket()),
      });

    const origin: RoutePoint = { latitude: 21.0285, longitude: 105.8542 };
    const turn1 = fromLocalMeters(origin, 0, 200);
    const dest = fromLocalMeters(origin, 200, 200);

    let calcCount = 0;
    const mockRouter: MapRouteProvider = {
      id: "mock-router",
      label: "Mock Router",
      isSynthetic: true,
      attribution: "Mock Attribution",
      fetchRoute: async () => ({
        providerId: "mock-router",
        isSynthetic: true,
        attribution: "Mock",
        routePoints: [origin, turn1, dest],
        steps: [],
      }),
      calculateRoute: async (q: RouteQuery): Promise<CalculatedRoute> => {
        calcCount += 1;
        return {
          routeId: `r-${calcCount}`,
          providerId: "mock-router",
          isSynthetic: true,
          attribution: "Mock Attribution",
          calculatedAtMs: clock.nowMs(),
          origin: q.origin,
          destination: q.destination,
          totalDistanceMeters: 400,
          estimatedDurationSeconds: 40,
          geometry: [q.origin, turn1, q.destination],
          steps: [
            {
              turnDirection: "RIGHT",
              maneuverLocation: turn1,
              distanceMeters: 200,
              durationSeconds: 20,
              headingDegrees: 0,
              instruction: "Turn right at junction",
              speedLimitKmh: null,
              speedLimitStatus: "UNKNOWN",
            },
            {
              turnDirection: "STRAIGHT",
              maneuverLocation: q.destination,
              distanceMeters: 200,
              durationSeconds: 20,
              headingDegrees: 90,
              instruction: "Arrive at destination",
              speedLimitKmh: null,
              speedLimitStatus: "UNKNOWN",
            },
          ],
        };
      },
    };

    render(
      <App
        simulator={new SimulatorService({ clock })}
        liveProviderFactory={liveFactory}
        geocodingProvider={new SyntheticVnGeocodingProvider()}
        routingProvider={mockRouter}
        warningBase={instant}
        clock={clock}
        initialSource="LIVE_PHONE"
      />,
    );

    // Connect live phone and send initial origin GPS fix
    act(() => {
      socket!.open();
      socket!.receive({ type: "presence", phones: 1 });
      socket!.receive({
        type: "gps",
        latitude: origin.latitude,
        longitude: origin.longitude,
        speedMps: 10,
        headingDegrees: 0,
        accuracyMeters: 5,
        phoneSessionId: "s1",
        phoneSeq: 1,
      });
    });

    // Click interactive planning map to select a destination
    fireEvent.click(screen.getByTestId("planning-map-svg"), { clientX: 220, clientY: 80 });

    await waitFor(() => {
      expect(screen.getByTestId("planner-route-status")).toHaveTextContent("ACTIVE");
    });
    expect(calcCount).toBe(1);
    expect(screen.getByTestId("route-status")).toHaveTextContent("NAV ACTIVE");
    expect(screen.getByTestId("turn-arrow")).toHaveAttribute("data-direction", "RIGHT");

    // Normal on-route GPS movement (100m north) updates distance without making a new routing request
    const onRoute100m = fromLocalMeters(origin, 0, 100);
    act(() => {
      clock.advance(1000);
      socket!.receive({
        type: "gps",
        latitude: onRoute100m.latitude,
        longitude: onRoute100m.longitude,
        speedMps: 11,
        headingDegrees: 0,
        accuracyMeters: 5,
        phoneSessionId: "s1",
        phoneSeq: 2,
      });
    });
    expect(calcCount).toBe(1); // No redundant route request!
    expect(screen.getByTestId("distance-value")).toHaveTextContent(/^10[01] m$/);

    // 3 consecutive off-route samples (150m west of route) trigger automatic reroute
    const offRouteWest = fromLocalMeters(origin, -150, 100);
    for (let i = 0; i < 3; i++) {
      act(() => {
        clock.advance(1000);
        socket!.receive({
          type: "gps",
          latitude: offRouteWest.latitude + i * 0.00001,
          longitude: offRouteWest.longitude,
          speedMps: 10,
          headingDegrees: 270,
          accuracyMeters: 5,
          phoneSessionId: "s1",
          phoneSeq: 3 + i,
        });
      });
    }

    await waitFor(() => {
      expect(calcCount).toBe(2);
    });
  });

  it("handles routing provider failure gracefully without crashing", async () => {
    const clock = new ManualClock(10_000);
    const failingRouter: MapRouteProvider = {
      id: "fail-router",
      label: "Failing Router",
      isSynthetic: false,
      attribution: "Test",
      fetchRoute: async () => {
        throw new Error("Routing service unreachable");
      },
      calculateRoute: async () => {
        throw new Error("Routing service unreachable");
      },
    };

    render(
      <App
        simulator={new SimulatorService({ clock })}
        geocodingProvider={new SyntheticVnGeocodingProvider()}
        routingProvider={failingRouter}
        warningBase={instant}
        clock={clock}
      />,
    );

    fireEvent.click(screen.getByTestId("planning-map-svg"), { clientX: 200, clientY: 100 });

    await waitFor(() => {
      expect(screen.getByTestId("planner-route-status")).toHaveTextContent("ERROR");
    });
    expect(screen.getByTestId("route-error")).toHaveTextContent(/Routing service unreachable/i);
  });
});
