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
  sent: string[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(data);
  }
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
const fix = {
  type: "gps",
  latitude: 21.03,
  longitude: 105.85,
  speedMps: 10,
  headingDegrees: 90,
  accuracyMeters: 5,
  sampleTimestampMs: 9950,
  phoneReceivedAtMs: 9975,
  phoneSentAtMs: 9977,
  relayReceivedAtMs: 9996,
  phoneSessionId: "sess-1",
  phoneSeq: 1,
  speedSource: "native" as const,
};

describe("LivePhoneProvider", () => {
  it("starts disconnected with no fix, no invented data", () => {
    const { last } = setup();
    expect(last()).toMatchObject({ bleStatus: "DISCONNECTED", gpsStatus: "LOST", currentSpeedKmh: null, speedLimitKmh: null, speedLimitStatus: "UNKNOWN" });
  });

  it("reports real speed and computes latency metrics within valid clock domains", () => {
    const { sockets, provider, last } = setup();
    sockets[0]!.open();
    sockets[0]!.receive({ type: "presence", phones: 1 });
    sockets[0]!.receive(fix);
    expect(last()).toMatchObject({ bleStatus: "CONNECTED", gpsStatus: "ACTIVE", currentSpeedKmh: 36, headingDegrees: 90 });

    const m = provider.getMetrics();
    expect(m.phoneSampleAgeMs).toBe(25); // 9975 - 9950 (phone clock)
    expect(m.phoneProcessingDelayMs).toBe(2); // 9977 - 9975 (phone clock)
    expect(m.relayToSimulatorMs).toBe(4); // 10000 - 9996 (PC clock)
    expect(m.acceptedFixes).toBe(1);
    expect(m.speedSource).toBe("native");
  });

  it("measures WebSocket round-trip ping (RTT) in the PC clock domain", () => {
    const { clock, sockets, provider } = setup();
    sockets[0]!.open(); // sends initial ping at t=10000
    clock.advance(14);
    sockets[0]!.receive({ type: "pong", sentAtMs: 10_000, relayAtMs: 10_007 });
    expect(provider.getMetrics().roundTripPingMs).toBe(14);
  });

  it("drops duplicate or out-of-order phoneSeq packets within the same session, and resets on new phoneSessionId", () => {
    const { sockets, provider, last } = setup();
    sockets[0]!.open();
    sockets[0]!.receive({ type: "presence", phones: 1 });
    sockets[0]!.receive({ ...fix, phoneSessionId: "sess-a", phoneSeq: 5, speedMps: 10 });
    expect(last().currentSpeedKmh).toBe(36);

    // Duplicate seq 5 and older seq 3 are dropped
    sockets[0]!.receive({ ...fix, phoneSessionId: "sess-a", phoneSeq: 5, speedMps: 20 });
    sockets[0]!.receive({ ...fix, phoneSessionId: "sess-a", phoneSeq: 3, speedMps: 25 });
    expect(provider.droppedOutOfOrder).toBe(2);
    expect(last().currentSpeedKmh).toBe(36);

    // Phone restarts watcher -> new phoneSessionId "sess-b" with phoneSeq: 1 is accepted
    sockets[0]!.receive({ ...fix, phoneSessionId: "sess-b", phoneSeq: 1, speedMps: 20 });
    expect(last().currentSpeedKmh).toBe(72);
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
    sockets[0]!.receive({ ...fix, phoneSeq: 2, speedMps: 20 });
    expect(last()).toMatchObject({ gpsStatus: "ACTIVE", currentSpeedKmh: 72 });
  });

  it("phone leaving is reported as link DISCONNECTED and resets session sequence gate", () => {
    const { sockets, last } = setup();
    sockets[0]!.open();
    sockets[0]!.receive({ type: "presence", phones: 1 });
    sockets[0]!.receive({ ...fix, phoneSeq: 10, speedMps: 10 });
    sockets[0]!.receive({ type: "presence", phones: 0 });
    expect(last().bleStatus).toBe("DISCONNECTED");

    // Reconnect starting at seq 1 is accepted
    sockets[0]!.receive({ type: "presence", phones: 1 });
    sockets[0]!.receive({ ...fix, phoneSeq: 1, speedMps: 15 });
    expect(last().currentSpeedKmh).toBe(54);
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
  it("switches to live GPS, labels it LIVE, shows real speed, unknown limit, and latency metrics", () => {
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
    expect(screen.getByTestId("metric-sample-age")).toHaveTextContent("25 ms");
    expect(screen.getByTestId("metric-relay-sim")).toHaveTextContent("4 ms");
    act(() => void fireEvent.click(screen.getByRole("button", { name: "Simulator" })));
    expect(screen.getByTestId("source-badge")).toHaveTextContent(/SIMULATED/);
    expect(socket!.closed).toBe(true);
  });
});
