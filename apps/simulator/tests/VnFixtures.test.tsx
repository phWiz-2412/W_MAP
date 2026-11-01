import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ManualClock } from "@w-map/navigation-core";
import App from "../src/App";
import { VN_ROUTE_FIXTURES, getBuiltInFixtureById, loadRouteFixtureFromJson } from "../src/fixtures/vnFixtures";
import { SyntheticFixtureMapProvider } from "../src/services/MapRouteProvider";
import { SimulatorService } from "../src/services/SimulatorService";
import { instant } from "./helpers";

const setup = () => {
  const clock = new ManualClock(1_000_000);
  const sim = new SimulatorService({ clock });
  render(<App simulator={sim} warningBase={instant} clock={clock} />);
  return { sim, clock };
};
const controls = () => within(screen.getByLabelText("Simulator controls"));
const display = () => screen.getByTestId("navigation-display");

describe("Vietnamese synthetic route fixtures & MapRouteProvider", () => {
  it("validates all 7 built-in Vietnamese scenario fixtures and marks them synthetic", () => {
    expect(VN_ROUTE_FIXTURES).toHaveLength(7);
    const ids = VN_ROUTE_FIXTURES.map((f) => f.id);
    expect(ids).toEqual([
      "vn-left-right-turns",
      "vn-urban-straight",
      "vn-roundabout",
      "vn-missing-route",
      "vn-gps-loss",
      "vn-stale-data",
      "vn-unknown-speed-limit",
    ]);
    for (const f of VN_ROUTE_FIXTURES) {
      expect(f.isSynthetic).toBe(true);
      expect(f.description).toMatch(/SYNTHETIC TEST DATA/i);
    }
  });

  it("loads each Vietnamese scenario preset and updates display state & maneuvers", () => {
    const { sim } = setup();
    const selectPreset = (id: string) =>
      act(() => void fireEvent.change(controls().getByLabelText("Synthetic route scenario"), { target: { value: id } }));

    // 1. Straight urban road
    selectPreset("vn-urban-straight");
    expect(screen.getByTestId("turn-arrow")).toHaveAttribute("data-direction", "STRAIGHT");
    expect(screen.getByTestId("limit-value")).toHaveTextContent("50");
    expect(display()).toHaveAttribute("data-speed-state", "NORMAL");

    // 2. Roundabout
    selectPreset("vn-roundabout");
    expect(screen.getByTestId("turn-arrow")).toHaveAttribute("data-direction", "ROUNDABOUT");
    expect(screen.getByTestId("limit-value")).toHaveTextContent("40");

    // Advance progress along roundabout fixture -> maneuver changes to RIGHT exit
    act(() => sim.update({ routeProgressPercent: 75 }));
    expect(screen.getByTestId("turn-arrow")).toHaveAttribute("data-direction", "RIGHT");
    expect(screen.getByTestId("limit-value")).toHaveTextContent("50");

    // 3. Missing route in MAP mode
    act(() => sim.update({ mode: "MAP" }));
    selectPreset("vn-missing-route");
    expect(screen.queryByTestId("map-route")).not.toBeInTheDocument();
    expect(screen.getByTestId("map-no-route")).toHaveTextContent("ROUTE UNAVAILABLE");

    // 4. GPS loss
    selectPreset("vn-gps-loss");
    expect(screen.getByTestId("gps-status")).toHaveAttribute("data-state", "LOST");
    expect(display()).toHaveAttribute("data-speed-state", "GPS_LOST");

    // 5. Stale navigation data
    selectPreset("vn-stale-data");
    expect(display()).toHaveAttribute("data-speed-state", "DATA_STALE");
    expect(screen.getByTestId("limit-sign")).toHaveAttribute("data-status", "STALE");

    // 6. Unknown speed limit
    selectPreset("vn-unknown-speed-limit");
    expect(screen.getByTestId("limit-value")).toHaveTextContent("--");
    expect(display()).toHaveAttribute("data-speed-state", "UNKNOWN_LIMIT");
  });

  it("rejects invalid custom fixture JSON without corrupting current state", () => {
    const { sim } = setup();
    const res = sim.loadFixtureJson('{"schemaVersion":1,"isSynthetic":false}');
    expect(res.ok).toBe(false);
    expect(screen.getByTestId("speed-value")).toHaveTextContent("45");
    expect(loadRouteFixtureFromJson("not-json").ok).toBe(false);
  });

  it("SyntheticFixtureMapProvider returns synthetic route guidance and evaluates steps", async () => {
    const roundabout = getBuiltInFixtureById("vn-roundabout")!;
    const provider = new SyntheticFixtureMapProvider(roundabout);
    expect(provider.isSynthetic).toBe(true);
    const route = await provider.fetchRoute({
      origin: { latitude: 10.77, longitude: 106.69 },
      destination: { latitude: 10.78, longitude: 106.7 },
    });
    expect(route.isSynthetic).toBe(true);
    expect(route.steps[0]?.turnDirection).toBe("ROUNDABOUT");
    expect(provider.evaluateAtProgress(10).step.turnDirection).toBe("ROUNDABOUT");
    expect(provider.evaluateAtProgress(80).step.turnDirection).toBe("RIGHT");
  });
});
