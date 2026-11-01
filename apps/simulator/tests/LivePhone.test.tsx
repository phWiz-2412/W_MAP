import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
  open() {
    this.onopen?.();
  }
  receive(obj: unknown) {
    this.onmessage?.({ data: typeof obj === "string" ? obj : JSON.stringify(obj) });
  }
  fail() {
    this.onerror?.();
  }
}

const setup = () => {
  const clock = new ManualClock(10_000);
  const sockets: FakeSocket[] = [];
  const provider = new LivePhoneProvider({
    url: "wss://192.168.1.10:5173/ws?role=display",
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
    const { last, provider } = setup();
    expect(last()).toMatchObject({
      bleStatus: "DISCONNECTED",
      gpsStatus: "LOST",
      currentSpeedKmh: null,
      speedLimitKmh: null,
      speedLimitStatus: "UNKNOWN",
    });
    expect(provider.getMetrics().diagnosticStatus).toBe("DISCONNECTED_FROM_RELAY");
  });

  it("reports real speed and computes latency metrics within valid clock domains", () => {
    const { sockets, provider, last } = setup();
    sockets[0]!.open();
    sockets[0]!.receive({ type: "presence", phones: 1 });
    sockets[0]!.receive(fix);
    expect(last()).toMatchObject({
      bleStatus: "CONNECTED",
      gpsStatus: "ACTIVE",
      currentSpeedKmh: 36,
      headingDegrees: 90,
    });

    const m = provider.getMetrics();
    expect(m.phoneSampleAgeMs).toBe(25); // 9975 - 9950 (phone clock)
    expect(m.phoneProcessingDelayMs).toBe(2); // 9977 - 9975 (phone clock)
    expect(m.relayToSimulatorMs).toBe(4); // 10000 - 9996 (PC clock)
    expect(m.acceptedFixes).toBe(1);
    expect(m.speedSource).toBe("native");
    expect(m.diagnosticStatus).toBe("HEALTHY_LIVE_GPS");
    expect(m.relayPhoneCount).toBe(1);
  });

  it("measures WebSocket RTT without mistaking ping/pong or presence for GPS packets", () => {
    const { clock, sockets, provider, last } = setup();
    sockets[0]!.open(); // sends initial ping at t=10000
    sockets[0]!.receive({ type: "presence", phones: 0 });
    clock.advance(14);
    sockets[0]!.receive({ type: "pong", sentAtMs: 10_000, relayAtMs: 10_007, phones: 0 });
    const m = provider.getMetrics();
    expect(m.roundTripPingMs).toBe(14);
    // Neither presence nor pong counts as a GPS packet arrival
    expect(m.timeSinceLastPacketMs).toBeNull();
    expect(m.timeSinceLastFixMs).toBeNull();
    expect(m.acceptedFixes).toBe(0);
    expect(m.diagnosticStatus).toBe("PHONE_ABSENT_FROM_RELAY");
    expect(last().bleStatus).toBe("DISCONNECTED");
    expect(last().gpsStatus).toBe("LOST");
  });

  it("drops duplicate or out-of-order phoneSeq and older sampleTimestampMs packets, and resets on new phoneSessionId", () => {
    const { sockets, provider, last } = setup();
    sockets[0]!.open();
    sockets[0]!.receive({ type: "presence", phones: 1 });
    sockets[0]!.receive({
      ...fix,
      phoneSessionId: "sess-a",
      phoneSeq: 5,
      sampleTimestampMs: 9950,
      speedMps: 10,
    });
    expect(last().currentSpeedKmh).toBe(36);

    // Duplicate seq 5 and older seq 3 are dropped
    sockets[0]!.receive({ ...fix, phoneSessionId: "sess-a", phoneSeq: 5, sampleTimestampMs: 9960, speedMps: 20 });
    sockets[0]!.receive({ ...fix, phoneSessionId: "sess-a", phoneSeq: 3, sampleTimestampMs: 9970, speedMps: 25 });
    // Newer seq 6 but older sampleTimestampMs (9000 < 9950) is also dropped
    sockets[0]!.receive({ ...fix, phoneSessionId: "sess-a", phoneSeq: 6, sampleTimestampMs: 9000, speedMps: 30 });

    expect(provider.droppedOutOfOrder).toBe(3);
    expect(last().currentSpeedKmh).toBe(36);

    // Phone restarts watcher -> new phoneSessionId "sess-b" with phoneSeq: 1 is accepted
    sockets[0]!.receive({
      ...fix,
      phoneSessionId: "sess-b",
      phoneSeq: 1,
      sampleTimestampMs: 10_100,
      speedMps: 20,
    });
    expect(last().currentSpeedKmh).toBe(72);
  });

  it("socket open without a phone is still DISCONNECTED and reports PHONE_ABSENT_FROM_RELAY", () => {
    const { sockets, last, provider } = setup();
    sockets[0]!.open();
    expect(last().bleStatus).toBe("DISCONNECTED");
    expect(provider.getMetrics().diagnosticStatus).toBe("PHONE_ABSENT_FROM_RELAY");
  });

  it("ignores invalid fixes and malformed messages (counted separately from out-of-order)", () => {
    const { sockets, provider, last } = setup();
    sockets[0]!.open();
    sockets[0]!.receive({ type: "presence", phones: 1 });
    sockets[0]!.receive({ ...fix, latitude: 999 });
    sockets[0]!.receive("not json");
    expect(provider.invalidMessages).toBe(2);
    expect(provider.droppedOutOfOrder).toBe(0);
    expect(provider.acceptedFixes).toBe(0);
    expect(last().latitude).toBeNull();
    expect(provider.getMetrics().diagnosticStatus).toBe("GPS_PACKET_REJECTED");
  });

  it("detects stale GPS data both when fixes stop arriving and when phone sampleTimestampMs is already stale", () => {
    const { clock, sockets, provider, last } = setup();
    sockets[0]!.open();
    sockets[0]!.receive({ type: "presence", phones: 1 });
    sockets[0]!.receive(fix);
    expect(last().gpsStatus).toBe("ACTIVE");

    // 5 seconds pass with transport still open and pongs still arriving -> GPS becomes LOST
    clock.advance(5000);
    sockets[0]!.receive({ type: "pong", sentAtMs: 14_990, relayAtMs: 14_995, phones: 1 });
    provider.emitCurrentForTest();
    expect(last().gpsStatus).toBe("LOST");
    expect(provider.getMetrics().diagnosticStatus).toBe("GPS_DATA_STALE");

    // A packet arrives immediately, but its sampleTimestampMs is 5000 ms older than phoneReceivedAtMs -> still LOST
    sockets[0]!.receive({
      ...fix,
      phoneSeq: 2,
      sampleTimestampMs: 10_000,
      phoneReceivedAtMs: 15_000,
      phoneSentAtMs: 15_001,
      speedMps: 15,
    });
    expect(last().gpsStatus).toBe("LOST");

    // A fresh sample arrives -> recovers to ACTIVE
    sockets[0]!.receive({
      ...fix,
      phoneSeq: 3,
      sampleTimestampMs: 15_980,
      phoneReceivedAtMs: 16_000,
      phoneSentAtMs: 16_001,
      speedMps: 20,
    });
    expect(last()).toMatchObject({ gpsStatus: "ACTIVE", currentSpeedKmh: 72 });
    expect(provider.getMetrics().diagnosticStatus).toBe("HEALTHY_LIVE_GPS");
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

  it("reconnects with bounded backoff, avoids duplicate sockets, and surfaces connection errors", () => {
    vi.useFakeTimers();
    try {
      const clock = new ManualClock(10_000);
      const sockets: FakeSocket[] = [];
      const provider = new LivePhoneProvider({
        url: "wss://192.168.1.10:5173/ws?role=display",
        clock,
        heartbeatMs: 0,
        reconnectMs: 1000,
        random: () => 0.5,
        socketFactory: () => {
          const s = new FakeSocket();
          sockets.push(s);
          return s;
        },
      });
      provider.subscribe(() => undefined);
      expect(sockets).toHaveLength(1);

      // Simulate connection error on socket 0
      sockets[0]!.fail();
      expect(provider.getMetrics().lastError).toMatch(/WebSocket error/i);
      expect(provider.getMetrics().displaySocketState).toBe("reconnecting");

      // Advance timer to reconnect -> opens socket 1
      vi.advanceTimersByTime(1100);
      expect(sockets).toHaveLength(2);
      sockets[1]!.open();
      sockets[1]!.receive({ type: "presence", phones: 1 });

      // Delayed event on old socket[0] does not overwrite socket[1]
      sockets[0]!.onclose?.();
      expect(provider.getMetrics().displaySocketState).toBe("connected");
      expect(provider.getMetrics().relayPhoneCount).toBe(1);

      provider.dispose();
    } finally {
      vi.useRealTimers();
    }
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
  it("switches to live GPS, labels it LIVE, shows real speed, unknown limit, and latency/connection diagnostics", () => {
    const clock = new ManualClock(10_000);
    let socket: FakeSocket | null = null;
    const factory = () =>
      new LivePhoneProvider({
        url: "wss://192.168.1.10:5173/ws?role=display",
        clock,
        heartbeatMs: 0,
        reconnectMs: 0,
        socketFactory: () => (socket = new FakeSocket()),
      });
    render(
      <App
        simulator={new SimulatorService({ clock })}
        liveProviderFactory={factory}
        warningBase={instant}
        clock={clock}
      />,
    );
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
    expect(screen.getByTestId("metric-diagnostic-status")).toHaveTextContent(/HEALTHY_LIVE_GPS/);
    expect(screen.getByTestId("metric-relay-phones")).toHaveTextContent("1");

    // Phone Brain sends route guidance + remote displayMode switch to HUD
    act(() => {
      socket!.onmessage?.({
        data: JSON.stringify({
          ...fix,
          phoneSeq: 2,
          sampleTimestampMs: 10_950,
          phoneReceivedAtMs: 10_975,
          phoneSentAtMs: 10_976,
          routeStatus: "ACTIVE",
          turnDirection: "LEFT",
          distanceToTurnMeters: 140,
          destinationName: "Cho Ben Thanh",
          instruction: "Turn left onto Le Loi",
          remainingDistanceMeters: 420,
          displayMode: "MAP",
          routePoints: [
            { latitude: 21.03, longitude: 105.85 },
            { latitude: 21.032, longitude: 105.85 },
          ],
        }),
      });
    });
    expect(screen.getByTestId("metric-phone-route")).toHaveTextContent(/Cho Ben Thanh/);
    expect(screen.getByTestId("map-display")).toBeInTheDocument();

    act(() => void fireEvent.click(screen.getByRole("button", { name: "Simulator" })));
    expect(screen.getByTestId("source-badge")).toHaveTextContent(/SIMULATED/);
    expect(socket!.closed).toBe(true);
  });
});
