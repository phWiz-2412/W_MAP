import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ManualClock, parseNavigationPacketJson, type NavigationData } from "@w-map/navigation-core";
import App from "../src/App";
import { LivePhoneProvider, type SocketLike } from "../src/services/LivePhoneProvider";
import { SimulatorService } from "../src/services/SimulatorService";
import { instant } from "./helpers";

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
    this.onclose?.();
  }
  open() { this.onopen?.(); }
  receive(obj: unknown) { this.onmessage?.({ data: typeof obj === "string" ? obj : JSON.stringify(obj) }); }
}

const setup = () => {
  const clock = new ManualClock(10_000);
  const sockets: FakeSocket[] = [];
  const provider = new LivePhoneProvider({
    url: "ws://test/ws",
    clock,
    heartbeatMs: 0,
    reconnectMs: 0,
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  });
  const packets: NavigationData[] = [];
  provider.subscribe((raw) => {
    const r = parseNavigationPacketJson(raw);
    expect(r.ok).toBe(true); // every emitted packet must be valid
    if (r.ok) packets.push(r.value.data);
  });
  return { clock, sockets, provider, packets, last: () => packets.at(-1)! };
};
const fix = { type: "gps", latitude: 21.03, longitude: 105.85, speedMps: 10, headingDegrees: 90, accuracyMeters: 5 };

describe("LivePhoneProvider", () => {
  it("starts disconnected with no fix, no invented data", () => {
    const { last } = setup();
    expect(last()).toMatchObject({ bleStatus: "DISCONNECTED", gpsStatus: "LOST", currentSpeedKmh: null, speedLimitKmh: null, speedLimitStatus: "UNKNOWN" });
  });

  it("reports real speed from a validated fix when the phone is present", () => {
    const { sockets, last } = setup();
    sockets[0]!.open();
    sockets[0]!.receive({ type: "presence", phones: 1 });
    sockets[0]!.receive(fix);
    expect(last()).toMatchObject({ bleStatus: "CONNECTED", gpsStatus: "ACTIVE", currentSpeedKmh: 36, headingDegrees: 90 });
  });

  it("socket open without a phone is still DISCONNECTED", () => {
    const { sockets, last } = setup();
    sockets[0]!.open();
    expect(last().bleStatus).toBe("DISCONNECTED");
  });

  it("ignores invalid fixes and malformed messages (counted)", () => {
    const { sockets, provider, last } = setup();
    sockets[0]!.open();
    sockets[0]!.receive({ ...fix, latitude: 999 });
    sockets[0]!.receive("not json");
    expect(provider.invalidMessages).toBe(2);
    expect(last().latitude).toBeNull();
  });

  it("GPS becomes LOST when fixes stop, and recovers when they resume", () => {
    const { clock, sockets, provider, last } = setup();
    sockets[0]!.open();
    sockets[0]!.receive({ type: "presence", phones: 1 });
    sockets[0]!.receive(fix);
    clock.advance(5000);
    provider.emitCurrentForTest();
    expect(last().gpsStatus).toBe("LOST");
    sockets[0]!.receive({ ...fix, speedMps: 20 });
    expect(last()).toMatchObject({ gpsStatus: "ACTIVE", currentSpeedKmh: 72 });
  });

  it("phone leaving is reported as link DISCONNECTED", () => {
    const { sockets, last } = setup();
    sockets[0]!.open();
    sockets[0]!.receive({ type: "presence", phones: 1 });
    sockets[0]!.receive({ type: "presence", phones: 0 });
    expect(last().bleStatus).toBe("DISCONNECTED");
  });

  it("sequence numbers strictly increase", () => {
    const { sockets, packets } = setup();
    sockets[0]!.open();
    sockets[0]!.receive(fix);
    const seq = packets.map((p) => p.sequenceNumber);
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
    expect(new Set(seq).size).toBe(seq.length);
  });
});

describe("App live mode", () => {
  it("switches to live GPS, labels it LIVE, shows real speed and unknown limit", () => {
    const clock = new ManualClock(10_000);
    let socket: FakeSocket | null = null;
    const factory = () =>
      new LivePhoneProvider({
        url: "ws://test/ws",
        clock,
        heartbeatMs: 0,
        reconnectMs: 0,
        socketFactory: () => (socket = new FakeSocket()),
      });
    render(<App simulator={new SimulatorService({ clock })} liveProviderFactory={factory} warningBase={instant} clock={clock} />);
    act(() => void fireEvent.click(screen.getByRole("button", { name: "Live phone GPS" })));
    expect(screen.getByTestId("source-badge")).toHaveTextContent(/LIVE phone GPS/);
    expect(screen.getByTestId("source-badge")).not.toHaveTextContent(/no real GPS/);
    expect(screen.getByTestId("live-panel")).toBeInTheDocument();
    expect(screen.getByTestId("ble-status")).toHaveTextContent("PHONE LINK DISCONNECTED");
    act(() => {
      socket!.open();
      socket!.onmessage?.({ data: JSON.stringify({ type: "presence", phones: 1 }) });
      socket!.onmessage?.({ data: JSON.stringify(fix) });
    });
    expect(screen.getByTestId("speed-value")).toHaveTextContent("36");
    expect(screen.getByTestId("limit-value")).toHaveTextContent("--");
    expect(screen.getByTestId("route-status")).toHaveTextContent("NAV OFF");
    expect(screen.getByTestId("navigation-display")).toHaveAttribute("data-speed-state", "UNKNOWN_LIMIT");
    act(() => void fireEvent.click(screen.getByRole("button", { name: "Simulator" })));
    expect(screen.getByTestId("source-badge")).toHaveTextContent(/SIMULATED/);
    expect(socket!.closed).toBe(true);
  });
});
