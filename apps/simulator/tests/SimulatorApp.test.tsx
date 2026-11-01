import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ManualClock } from "@w-map/navigation-core";
import App from "../src/App";
import { useNavigationData } from "../src/hooks/useNavigationData";
import { SimulatorService } from "../src/services/SimulatorService";
import { instant, packetJson } from "./helpers";

const setup = () => {
  const clock = new ManualClock(1_000_000);
  const sim = new SimulatorService({ clock });
  render(<App simulator={sim} warningBase={instant} clock={clock} />);
  return { sim, clock };
};
const controls = () => within(screen.getByLabelText("Simulator controls"));
const change = (label: string, value: string) =>
  act(() => void fireEvent.change(controls().getByLabelText(label), { target: { value } }));
const display = () => screen.getByTestId("navigation-display");
const banner = () => screen.getByTestId("state-banner");

describe("App + simulator controls", () => {
  it("starts with the default scenario, labelled as simulated", () => {
    setup();
    expect(screen.getByTestId("speed-value")).toHaveTextContent("45");
    expect(screen.getByRole("note")).toHaveTextContent(/not a substitute for road signs/i);
    expect(screen.getByTestId("source-badge")).toHaveTextContent(/SIMULATED/);
  });

  it("switches between TURN and MAP", () => {
    setup();
    expect(screen.getByTestId("turn-display")).toBeInTheDocument();
    change("Navigation mode", "MAP");
    expect(display()).toHaveAttribute("data-mode", "MAP");
    expect(screen.getByTestId("map-display")).toBeInTheDocument();
    change("Navigation mode", "TURN");
    expect(screen.getByTestId("turn-display")).toBeInTheDocument();
  });

  it("updates speed, triggers and clears the overspeed warning", () => {
    setup();
    change("Current GPS speed", "90");
    expect(screen.getByTestId("speed-value")).toHaveTextContent("90");
    expect(display()).toHaveAttribute("data-speed-state", "WARNING");
    change("Current GPS speed", "20");
    expect(display()).toHaveAttribute("data-speed-state", "NORMAL");
  });

  it("changes the speed limit, including unknown", () => {
    setup();
    change("Speed limit", "30");
    expect(screen.getByTestId("limit-value")).toHaveTextContent("30");
    expect(display()).toHaveAttribute("data-speed-state", "WARNING"); // 45 > 35
    change("Speed limit", "unknown");
    expect(screen.getByTestId("limit-value")).toHaveTextContent("--");
    expect(display()).toHaveAttribute("data-speed-state", "UNKNOWN_LIMIT");
  });

  it("speed-limit freshness: stale is distinct from unknown", () => {
    setup();
    change("Speed-limit data freshness", "STALE");
    expect(screen.getByTestId("limit-sign")).toHaveAttribute("data-status", "STALE");
    expect(display()).toHaveAttribute("data-speed-state", "STALE_LIMIT");
  });

  it("packet freshness: stale packets show DATA_STALE and recover", () => {
    setup();
    change("Navigation packet freshness", "STALE");
    expect(display()).toHaveAttribute("data-speed-state", "DATA_STALE");
    change("Navigation packet freshness", "LIVE");
    expect(display()).toHaveAttribute("data-speed-state", "NORMAL");
  });

  it("updates turn direction and distance", () => {
    setup();
    change("Next turn", "U_TURN");
    expect(screen.getByTestId("turn-arrow")).toHaveAttribute("data-direction", "U_TURN");
    change("Distance to next turn", "1200");
    expect(screen.getByTestId("distance-value")).toHaveTextContent("1.2 km");
    change("Distance to next turn", "0");
    expect(screen.getByTestId("distance-value")).toHaveTextContent("0 m");
  });

  it("navigation inactive and route availability", () => {
    setup();
    change("Navigation mode", "MAP");
    act(() => void fireEvent.click(controls().getByLabelText("Route geometry available")));
    expect(screen.getByTestId("map-no-route")).toBeInTheDocument();
    expect(screen.queryByTestId("map-route")).not.toBeInTheDocument();
    act(() => void fireEvent.click(controls().getByLabelText("Route geometry available")));
    expect(screen.getByTestId("map-route")).toBeInTheDocument();
    change("Navigation", "INACTIVE");
    expect(screen.getByTestId("route-status")).toHaveTextContent("NAV OFF");
    expect(screen.queryByTestId("map-route")).not.toBeInTheDocument();
  });

  it("heading and map position controls change the map", () => {
    setup();
    change("Navigation mode", "MAP");
    const d0 = screen.getByTestId("map-route").getAttribute("d");
    change("Heading", "135");
    expect(screen.getByTestId("position-marker")).toHaveAttribute("data-heading", "135");
    const d1 = screen.getByTestId("map-route").getAttribute("d");
    expect(d1).not.toBe(d0);
    change("Map position along demo route", "60");
    expect(screen.getByTestId("map-route").getAttribute("d")).not.toBe(d1);
  });

  it("shows GPS loss", () => {
    setup();
    change("GPS status", "LOST");
    expect(screen.getByTestId("gps-status")).toHaveAttribute("data-state", "LOST");
    expect(display()).toHaveAttribute("data-speed-state", "GPS_LOST");
  });

  it("recovers after simulated BLE connection loss", () => {
    setup();
    change("Current GPS speed", "90");
    expect(display()).toHaveAttribute("data-speed-state", "WARNING");
    change("Simulated BLE connection", "DISCONNECTED");
    expect(screen.getByTestId("ble-status")).toHaveAttribute("data-state", "DISCONNECTED");
    expect(display()).toHaveAttribute("data-speed-state", "DISCONNECTED");
    expect(screen.getByTestId("speed-value")).toHaveTextContent("--");
    change("Simulated BLE connection", "CONNECTED");
    expect(screen.getByTestId("ble-status")).toHaveAttribute("data-state", "CONNECTED");
    expect(screen.getByTestId("speed-value")).toHaveTextContent("90");
    expect(display()).toHaveAttribute("data-speed-state", "WARNING");
  });

  it("configurable threshold changes the outcome", () => {
    setup();
    change("Current GPS speed", "53"); // limit 50, threshold 5 -> normal
    expect(display()).toHaveAttribute("data-speed-state", "NORMAL");
    change("Warning threshold", "0");
    expect(display()).toHaveAttribute("data-speed-state", "WARNING");
  });

  it("resets to the default scenario", () => {
    setup();
    change("Current GPS speed", "120");
    change("Navigation mode", "MAP");
    change("Speed limit", "unknown");
    change("Simulated BLE connection", "DISCONNECTED");
    change("Heading", "200");
    act(() => void fireEvent.click(screen.getByRole("button", { name: /reset/i })));
    expect(screen.getByTestId("turn-display")).toBeInTheDocument();
    expect(screen.getByTestId("speed-value")).toHaveTextContent("45");
    expect(screen.getByTestId("limit-value")).toHaveTextContent("50");
    expect(screen.getByTestId("ble-status")).toHaveAttribute("data-state", "CONNECTED");
    expect(controls().getByLabelText("Navigation mode")).toHaveValue("TURN");
    expect(controls().getByLabelText("Heading")).toHaveValue("0");
  });

  it("automatic speed is deterministic when driven by tick()", () => {
    const { sim } = setup();
    act(() => void fireEvent.click(controls().getByLabelText("Automatic speed simulation")));
    act(() => sim.tick(2000)); // quarter period: sin = 1 -> 130
    expect(screen.getByTestId("speed-value")).toHaveTextContent("130");
    act(() => sim.update({ autoSpeed: false }));
    expect(controls().getByLabelText("Current GPS speed")).not.toBeDisabled();
  });

  it("rejects invalid packets, drops old sequence numbers and keeps the last good state", () => {
    const { sim } = setup();
    act(() => sim.update({ speedKmh: 60 }));
    act(() => sim.emitRaw("{bad json"));
    act(() => sim.emitRaw(packetJson({ sequenceNumber: 1, currentSpeedKmh: 5 }))); // old
    act(() => sim.emitRaw(packetJson({ sequenceNumber: 999, currentSpeedKmh: -3 }))); // invalid
    act(() => sim.emitRaw(packetJson({ sequenceNumber: 1000, headingDegrees: 400 }))); // invalid
    act(() => sim.emitRaw(JSON.stringify({ version: 9, data: {} }))); // unsupported version
    expect(screen.getByTestId("speed-value")).toHaveTextContent("60");
    expect(screen.getByTestId("feed-info")).toHaveTextContent("rejected: 4");
    expect(screen.getByTestId("feed-info")).toHaveTextContent("dropped old: 1");
    expect(screen.getByTestId("feed-error")).toBeInTheDocument();
    expect(banner()).toHaveAttribute("data-state", "WARNING"); // 60 > 50 + 5, state from last good packet
  });
});

describe("useNavigationData", () => {
  it("accepts newer packets and drops duplicates / out-of-order ones", () => {
    const sim = new SimulatorService({ clock: new ManualClock(0) });
    const { result } = renderHook(() => useNavigationData(sim));
    const seq0 = result.current.data!.sequenceNumber;
    act(() => sim.emitRaw(packetJson({ sequenceNumber: seq0 + 10, currentSpeedKmh: 77 })));
    expect(result.current.data?.currentSpeedKmh).toBe(77);
    act(() => sim.emitRaw(packetJson({ sequenceNumber: seq0 + 10, currentSpeedKmh: 1 })));
    act(() => sim.emitRaw(packetJson({ sequenceNumber: seq0 + 5, currentSpeedKmh: 2 })));
    expect(result.current.data?.currentSpeedKmh).toBe(77);
    expect(result.current.droppedStaleCount).toBe(2);
  });
});

describe("SimulatorService", () => {
  it("clamps out-of-range values and ignores NaN", () => {
    const sim = new SimulatorService({ clock: new ManualClock(0) });
    sim.update({ speedKmh: 999, distanceToTurnMeters: -5, headingDegrees: 720 });
    expect(sim.getControls()).toMatchObject({ speedKmh: 160, distanceToTurnMeters: 0, headingDegrees: 359 });
    sim.update({ speedKmh: NaN });
    expect(sim.getControls().speedKmh).toBe(160);
  });

  it("emits strictly increasing sequence numbers, also across reset", () => {
    const sim = new SimulatorService({ clock: new ManualClock(0) });
    const seqs: number[] = [];
    sim.subscribe((raw) => seqs.push(JSON.parse(raw).data.sequenceNumber));
    sim.update({ speedKmh: 10 });
    sim.reset();
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
