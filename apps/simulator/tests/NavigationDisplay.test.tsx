import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManualClock, TURN_DIRECTIONS, type NavigationData } from "@w-map/navigation-core";
import { NavigationDisplay } from "../src/components/NavigationDisplay";
import { DEMO_BACKDROP } from "../src/fixtures/demoRoute";
import { instant, makeData } from "./helpers";

const clock = new ManualClock(0);

const show = (d: NavigationData | null, mode: "TURN" | "MAP" = "TURN") =>
  render(<NavigationDisplay data={d} mode={mode} warningConfig={instant} clock={clock} backdropRoads={DEMO_BACKDROP} />);
const banner = () => screen.getByTestId("state-banner");

afterEach(() => {
  clock.set(0);
  vi.useRealTimers();
});

describe("NavigationDisplay – TURN mode", () => {
  it("has a square 240x240 viewBox and a simulated-data footer", () => {
    show(makeData());
    expect(screen.getByTestId("navigation-display")).toHaveAttribute("viewBox", "0 0 240 240");
    expect(screen.getByTestId("sim-footer")).toHaveTextContent(/SIMULATED/);
  });

  it("shows an explicit state when no data was received (missing navigation data)", () => {
    show(null);
    expect(screen.getByTestId("waiting")).toHaveTextContent("NO NAVIGATION DATA");
  });

  it("shows normal speed below the limit", () => {
    show(makeData());
    expect(screen.getByTestId("speed-value")).toHaveTextContent("45");
    expect(screen.getByTestId("limit-value")).toHaveTextContent("50");
    expect(banner()).toHaveAttribute("data-state", "NORMAL");
  });

  it("handles boundary values: zero speed and zero distance", () => {
    show(makeData({ currentSpeedKmh: 0, distanceToTurnMeters: 0 }));
    expect(screen.getByTestId("speed-value")).toHaveTextContent(/^0$/);
    expect(screen.getByTestId("distance-value")).toHaveTextContent("0 m");
    expect(banner()).toHaveAttribute("data-state", "NORMAL");
  });

  it("warns above the limit", () => {
    show(makeData({ currentSpeedKmh: 70 }));
    expect(banner()).toHaveAttribute("data-state", "WARNING");
    expect(banner()).toHaveTextContent("SLOW DOWN");
    expect(screen.getByTestId("display-border")).toHaveAttribute("stroke", "#ff3b3b");
  });

  it("unknown limit shows '--', never a number, and never warns", () => {
    show(makeData({ speedLimitKmh: null, speedLimitStatus: "UNKNOWN", currentSpeedKmh: 120 }));
    expect(screen.getByTestId("limit-value")).toHaveTextContent("--");
    expect(screen.getByTestId("limit-sign")).toHaveAttribute("data-status", "UNKNOWN");
    expect(banner()).toHaveAttribute("data-state", "UNKNOWN_LIMIT");
  });

  it("stale limit is marked OLD, distinct from unknown, and never warns", () => {
    show(makeData({ speedLimitStatus: "STALE", currentSpeedKmh: 120 }));
    expect(screen.getByTestId("limit-sign")).toHaveAttribute("data-status", "STALE");
    expect(screen.getByTestId("limit-tag")).toHaveTextContent("OLD");
    expect(screen.getByTestId("limit-value")).toHaveTextContent("50");
    expect(banner()).toHaveAttribute("data-state", "STALE_LIMIT");
  });

  it("stale packet: shows DATA STALE and suppresses warning", () => {
    clock.set(10_000);
    show(makeData({ currentSpeedKmh: 150, timestamp: 0 }));
    expect(banner()).toHaveAttribute("data-state", "DATA_STALE");
    expect(banner()).toHaveTextContent("DATA STALE");
  });

  it("a fresh packet becomes stale as time passes without new data", () => {
    vi.useFakeTimers();
    show(makeData({ timestamp: 0 }));
    expect(banner()).toHaveAttribute("data-state", "NORMAL");
    act(() => {
      clock.advance(5000);
      vi.advanceTimersByTime(600);
    });
    expect(banner()).toHaveAttribute("data-state", "DATA_STALE");
  });

  it("indicates GPS loss and suppresses overspeed warning", () => {
    show(makeData({ gpsStatus: "LOST", currentSpeedKmh: 150 }));
    expect(screen.getByTestId("gps-status")).toHaveAttribute("data-state", "LOST");
    expect(banner()).toHaveTextContent("GPS LOST");
    expect(banner()).toHaveAttribute("data-state", "GPS_LOST");
  });

  it("indicates simulated BLE disconnection and hides live speed", () => {
    show(makeData({ bleStatus: "DISCONNECTED" }));
    expect(screen.getByTestId("ble-status")).toHaveAttribute("data-state", "DISCONNECTED");
    expect(screen.getByTestId("ble-status")).toHaveTextContent("SIM BLE DISCONNECTED");
    expect(screen.getByTestId("speed-value")).toHaveTextContent("--");
    expect(banner()).toHaveAttribute("data-state", "DISCONNECTED");
  });

  it.each(TURN_DIRECTIONS)("renders turn direction %s", (d) => {
    show(makeData({ turnDirection: d }));
    expect(screen.getByTestId("turn-arrow")).toHaveAttribute("data-direction", d);
  });

  it("formats distances in m and km", () => {
    const { unmount } = show(makeData({ distanceToTurnMeters: 1500 }));
    expect(screen.getByTestId("distance-value")).toHaveTextContent("1.5 km");
    unmount();
    show(makeData({ distanceToTurnMeters: 350 }));
    expect(screen.getByTestId("distance-value")).toHaveTextContent("350 m");
  });

  it("inactive navigation shows NAV OFF and no distance", () => {
    show(makeData({ routeStatus: "INACTIVE", distanceToTurnMeters: null, routePoints: [] }));
    expect(screen.getByTestId("distance-value")).toHaveTextContent("--");
    expect(screen.getByTestId("route-status")).toHaveTextContent("NAV OFF");
  });
});

describe("NavigationDisplay – MAP mode", () => {
  it("renders route, roads, OpenStreetMap street tiles, position marker, north indicator and simulated-map label", () => {
    show(makeData(), "MAP");
    expect(screen.getByTestId("map-display")).toBeInTheDocument();
    expect(screen.queryByTestId("turn-display")).not.toBeInTheDocument();
    expect(screen.getByTestId("map-osm-tiles")).toBeInTheDocument();
    expect(screen.getByTestId("map-osm-tiles").querySelectorAll("image").length).toBeGreaterThanOrEqual(4);
    expect(screen.getByTestId("map-route")).toBeInTheDocument();
    expect(screen.getByTestId("map-roads")).toBeInTheDocument();
    expect(screen.getByTestId("position-marker")).toHaveAttribute("data-gps", "ACTIVE");
    expect(screen.getByTestId("north-indicator")).toBeInTheDocument();
    expect(screen.getByTestId("map-disclaimer")).toHaveTextContent(/SIMULATED MAP/);
  });

  it("shows turn, speed and limit overlays", () => {
    show(makeData({ turnDirection: "LEFT" }), "MAP");
    expect(screen.getByTestId("turn-arrow")).toHaveAttribute("data-direction", "LEFT");
    expect(screen.getByTestId("speed-value")).toHaveTextContent("45");
    expect(screen.getByTestId("limit-value")).toHaveTextContent("50");
    expect(screen.getByTestId("distance-value")).toHaveTextContent("350 m");
  });

  it("missing route geometry: no route line, explicit message, turn info still shown", () => {
    show(makeData({ routePoints: [] }), "MAP");
    expect(screen.queryByTestId("map-route")).not.toBeInTheDocument();
    expect(screen.getByTestId("map-no-route")).toHaveTextContent("ROUTE UNAVAILABLE");
    expect(screen.getByTestId("distance-value")).toHaveTextContent("350 m");
  });

  it("incomplete route (single point) is treated as unavailable", () => {
    show(makeData({ routePoints: [makeData().routePoints[0]!] }), "MAP");
    expect(screen.queryByTestId("map-route")).not.toBeInTheDocument();
    expect(screen.getByTestId("map-no-route")).toBeInTheDocument();
  });

  it("inactive navigation hides the route without an 'unavailable' message", () => {
    show(makeData({ routeStatus: "INACTIVE", distanceToTurnMeters: null, routePoints: [] }), "MAP");
    expect(screen.queryByTestId("map-route")).not.toBeInTheDocument();
    expect(screen.queryByTestId("map-no-route")).not.toBeInTheDocument();
    expect(screen.getByTestId("route-status")).toHaveTextContent("NAV OFF");
  });

  it("without a position there is no marker and an explicit message", () => {
    show(makeData({ latitude: null, longitude: null }), "MAP");
    expect(screen.queryByTestId("position-marker")).not.toBeInTheDocument();
    expect(screen.getByTestId("map-no-position")).toBeInTheDocument();
  });

  it("GPS loss marks the marker and banner", () => {
    show(makeData({ gpsStatus: "LOST" }), "MAP");
    expect(screen.getByTestId("position-marker")).toHaveAttribute("data-gps", "LOST");
    expect(banner()).toHaveAttribute("data-state", "GPS_LOST");
  });

  it("reflects BLE disconnection", () => {
    show(makeData({ bleStatus: "DISCONNECTED" }), "MAP");
    expect(banner()).toHaveAttribute("data-state", "DISCONNECTED");
    expect(screen.getByTestId("speed-value")).toHaveTextContent("--");
  });

  it("rotates the map heading-up (route path differs by heading)", () => {
    const { unmount } = show(makeData({ headingDegrees: 0 }), "MAP");
    const d0 = screen.getByTestId("map-route").getAttribute("d");
    unmount();
    show(makeData({ headingDegrees: 90 }), "MAP");
    expect(screen.getByTestId("map-route").getAttribute("d")).not.toBe(d0);
    expect(screen.getByTestId("position-marker")).toHaveAttribute("data-heading", "90");
  });
});
