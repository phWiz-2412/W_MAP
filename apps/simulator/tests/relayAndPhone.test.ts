import { describe, expect, it, vi } from "vitest";
import { Relay, parseRelayUpgradeRequest } from "../relay/relay";
import {
  coordsToGpsMessage,
  deriveSpeedAndHeadingFromSamples,
  describeGeoError,
  type CoordsLike,
} from "../src/phone/gpsReporter";
import {
  PhoneGpsClient,
  type GeolocationLike,
  type PhoneSocketLike,
} from "../src/phone/phoneClient";

const sock = () => {
  const sent: string[] = [];
  let closed = false;
  return {
    sent,
    get closed() {
      return closed;
    },
    send: (d: string) => void sent.push(d),
    close: () => {
      closed = true;
    },
  };
};

describe("Relay", () => {
  it("forwards phone messages to displays only, stamps relayReceivedAtMs, and echoes display pings", () => {
    let now = 5000;
    const relay = new Relay({ clock: () => now });
    const display = sock();
    const phone = sock();
    relay.addClient(display, "display");
    expect(JSON.parse(display.sent[0]!)).toEqual({ type: "presence", phones: 0 });
    const remove = relay.addClient(phone, "phone");
    expect(JSON.parse(display.sent[1]!)).toEqual({ type: "presence", phones: 1 });
    expect(JSON.parse(phone.sent[0]!)).toEqual({ type: "presence", phones: 1, displays: 1 });

    now = 5123;
    relay.onMessage("phone", JSON.stringify({ type: "gps", latitude: 21, longitude: 105 }));
    expect(JSON.parse(display.sent[2]!)).toEqual({
      type: "gps",
      latitude: 21,
      longitude: 105,
      relayReceivedAtMs: 5123,
    });
    // Phones receive presence updates, never echoed GPS payloads
    expect(phone.sent).toHaveLength(1);

    // Display RTT ping is echoed back as pong with authoritative presence counts
    now = 5200;
    relay.onMessage("display", JSON.stringify({ type: "ping", sentAtMs: 5190 }), display);
    expect(JSON.parse(display.sent[3]!)).toEqual({
      type: "pong",
      sentAtMs: 5190,
      relayAtMs: 5200,
      phones: 1,
      displays: 1,
    });

    remove();
    expect(JSON.parse(display.sent.at(-1)!)).toEqual({ type: "presence", phones: 0 });
    expect(relay.phoneCount).toBe(0);
  });

  it("delivers current phone presence to a display that connects after the phone", () => {
    const relay = new Relay();
    const phone = sock();
    const display = sock();

    relay.addClient(phone, "phone");
    expect(relay.phoneCount).toBe(1);
    expect(JSON.parse(phone.sent.at(-1)!)).toEqual({ type: "presence", phones: 1, displays: 0 });

    relay.addClient(display, "display");
    expect(JSON.parse(display.sent[0]!)).toEqual({ type: "presence", phones: 1 });
    // Phone is also notified that a display joined the relay
    expect(JSON.parse(phone.sent.at(-1)!)).toEqual({ type: "presence", phones: 1, displays: 1 });
  });

  it("handles phone disconnect and reconnect without stale counts, duplicate inflation, or old-socket erasure", () => {
    const relay = new Relay();
    const display = sock();
    relay.addClient(display, "display");

    const phone1 = sock();
    const removePhone1 = relay.addClient(phone1, "phone");
    expect(relay.phoneCount).toBe(1);

    // Duplicate addClient for the same socket does not inflate phoneCount
    const removePhone1Dup = relay.addClient(phone1, "phone");
    expect(relay.phoneCount).toBe(1);
    void removePhone1Dup;

    // Phone reconnects with a new socket before the old socket's close handler fires
    const phone2 = sock();
    const removePhone2 = relay.addClient(phone2, "phone");
    expect(relay.phoneCount).toBe(2);

    // Closing old socket phone1 must NOT remove active session phone2
    removePhone1();
    removePhone1(); // Idempotent second call (e.g., error + close)
    expect(relay.phoneCount).toBe(1);
    expect(JSON.parse(display.sent.at(-1)!)).toEqual({ type: "presence", phones: 1 });

    // Disconnecting phone2 brings presence to 0
    removePhone2();
    expect(relay.phoneCount).toBe(0);
    expect(JSON.parse(display.sent.at(-1)!)).toEqual({ type: "presence", phones: 0 });

    // Reconnecting phone3 recovers presence to 1
    const phone3 = sock();
    relay.addClient(phone3, "phone");
    expect(relay.phoneCount).toBe(1);
    expect(JSON.parse(display.sent.at(-1)!)).toEqual({ type: "presence", phones: 1 });
  });

  it("keeps independent relay instances isolated (demonstrating why phone and PC must share one server)", () => {
    const relayA = new Relay();
    const relayB = new Relay();
    const phoneOnA = sock();
    const displayOnB = sock();

    relayA.addClient(phoneOnA, "phone");
    relayB.addClient(displayOnB, "display");

    expect(relayA.phoneCount).toBe(1);
    expect(relayA.displayCount).toBe(0);
    expect(relayB.phoneCount).toBe(0);
    expect(relayB.displayCount).toBe(1);
    expect(JSON.parse(displayOnB.sent[0]!)).toEqual({ type: "presence", phones: 0 });
    expect(JSON.parse(phoneOnA.sent[0]!)).toEqual({ type: "presence", phones: 1, displays: 0 });
  });

  it("validates upgrade path and role query parameters strictly", () => {
    expect(parseRelayUpgradeRequest("/ws?role=phone")).toEqual({
      ok: true,
      isRelayPath: true,
      role: "phone",
    });
    expect(parseRelayUpgradeRequest("/ws?role=display")).toEqual({
      ok: true,
      isRelayPath: true,
      role: "display",
    });
    // Non-relay paths (e.g. Vite HMR) are flagged as isRelayPath: false
    expect(parseRelayUpgradeRequest("/?token=abc")).toEqual({
      ok: false,
      isRelayPath: false,
      reason: "Not a relay WebSocket path",
    });
    // Missing or unknown roles on /ws are rejected
    expect(parseRelayUpgradeRequest("/ws")).toMatchObject({
      ok: false,
      isRelayPath: true,
    });
    expect(parseRelayUpgradeRequest("/ws?role=unknown")).toMatchObject({
      ok: false,
      isRelayPath: true,
    });
  });

  it("cleans up and closes all clients on shutdown()", () => {
    const relay = new Relay();
    const phone = sock();
    const display = sock();
    relay.addClient(phone, "phone");
    relay.addClient(display, "display");
    expect(relay.phoneCount).toBe(1);
    expect(relay.displayCount).toBe(1);

    relay.shutdown();
    expect(relay.phoneCount).toBe(0);
    expect(relay.displayCount).toBe(0);
    expect(phone.closed).toBe(true);
    expect(display.closed).toBe(true);
  });

  it("a failing display does not block others", () => {
    const relay = new Relay();
    const good = sock();
    relay.addClient({ send: () => { throw new Error("dead"); } }, "display");
    relay.addClient(good, "display");
    relay.onMessage("phone", "x");
    expect(good.sent.at(-1)).toBe("x");
  });
});

class FakePhoneSocket implements PhoneSocketLike {
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  closed = false;

  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }
  receive(obj: unknown) {
    this.onmessage?.({ data: typeof obj === "string" ? obj : JSON.stringify(obj) });
  }
  fail() {
    this.onerror?.();
  }
}

class FakeGeo implements GeolocationLike {
  nextId = 1;
  activeWatches = new Map<
    number,
    {
      success: (pos: { coords: CoordsLike; timestamp: number }) => void;
      error?: (err: { code: number; message?: string }) => void;
    }
  >();

  watchPosition(
    success: (pos: { coords: CoordsLike; timestamp: number }) => void,
    error?: (err: { code: number; message?: string }) => void,
  ): number {
    const id = this.nextId++;
    this.activeWatches.set(id, { success, error });
    return id;
  }

  clearWatch(watchId: number): void {
    this.activeWatches.delete(watchId);
  }

  emitFix(coords: CoordsLike, timestamp: number) {
    for (const w of this.activeWatches.values()) {
      w.success({ coords, timestamp });
    }
  }

  emitError(code: number) {
    for (const w of this.activeWatches.values()) {
      w.error?.({ code });
    }
  }
}

describe("PhoneGpsClient", () => {
  it("does not mistake socket onopen for GPS delivery or PC display presence", () => {
    const sockets: FakePhoneSocket[] = [];
    const geo = new FakeGeo();
    const client = new PhoneGpsClient({
      url: "wss://192.168.1.10:5173/ws?role=phone",
      geolocation: geo,
      reconnectBaseMs: 0,
      socketFactory: () => {
        const s = new FakePhoneSocket();
        sockets.push(s);
        return s;
      },
    });

    client.start();
    expect(client.getSnapshot().statusLabel).toBe("Connecting");
    expect(client.getSnapshot().packetsSent).toBe(0);

    // WebSocket opens, but 0 displays are on the relay and no GPS fix has arrived yet
    sockets[0]!.open();
    sockets[0]!.receive({ type: "presence", phones: 1, displays: 0 });
    expect(client.getSnapshot().wsState).toBe("connected");
    expect(client.getSnapshot().statusLabel).toBe("Waiting for GPS fix");
    expect(client.getSnapshot().linkLabel).toMatch(/0 PC displays on this relay/i);
    expect(client.getSnapshot().packetsSent).toBe(0);

    // Local GPS fix arrives while 0 displays are on the relay -> sent to relay, but 0 delivered to display
    geo.emitFix(
      { latitude: 10.77, longitude: 106.69, speed: 8, heading: 90, accuracy: 5 },
      2000,
    );
    expect(client.getSnapshot().fixesAcquired).toBe(1);
    expect(client.getSnapshot().packetsSent).toBe(1);
    expect(client.getSnapshot().packetsDeliveredToDisplay).toBe(0);
    expect(client.getSnapshot().statusLabel).toBe("GPS active");
    expect(client.getSnapshot().infoLabel).toMatch(/no PC display linked/i);

    // Now a PC display joins the relay -> next GPS fix transitions to "Sending GPS"
    sockets[0]!.receive({ type: "presence", phones: 1, displays: 1 });
    geo.emitFix(
      { latitude: 10.771, longitude: 106.69, speed: 10, heading: 90, accuracy: 5 },
      3000,
    );
    expect(client.getSnapshot().statusLabel).toBe("Sending GPS");
    expect(client.getSnapshot().packetsSent).toBe(2);
    expect(client.getSnapshot().packetsDeliveredToDisplay).toBe(1);
    expect(client.getSnapshot().linkLabel).toMatch(/1 PC display linked/i);
  });

  it("starts and stops GPS watcher without leaking and does not count local fixes as sent when disconnected", () => {
    const sockets: FakePhoneSocket[] = [];
    const geo = new FakeGeo();
    const client = new PhoneGpsClient({
      url: "wss://192.168.1.10:5173/ws?role=phone",
      geolocation: geo,
      reconnectBaseMs: 0,
      socketFactory: () => {
        const s = new FakePhoneSocket();
        sockets.push(s);
        return s;
      },
    });

    client.start();
    expect(geo.activeWatches.size).toBe(1);
    // Calling start() again clears the previous watcher rather than leaking
    client.start();
    expect(geo.activeWatches.size).toBe(1);

    // Fix arrives while socket is still CONNECTING -> fixesAcquired = 1, packetsSent = 0
    geo.emitFix(
      { latitude: 10.77, longitude: 106.69, speed: 5, heading: 0, accuracy: 6 },
      1000,
    );
    expect(client.getSnapshot().fixesAcquired).toBe(1);
    expect(client.getSnapshot().packetsSent).toBe(0);
    expect(client.getSnapshot().infoLabel).toMatch(/not sent/i);

    client.stop();
    expect(geo.activeWatches.size).toBe(0);
    expect(client.getSnapshot().statusLabel).toBe("Stopped");
  });

  it("reconnects without creating duplicate sockets and shows actionable errors on failure", () => {
    vi.useFakeTimers();
    try {
      const sockets: FakePhoneSocket[] = [];
      const geo = new FakeGeo();
      const client = new PhoneGpsClient({
        url: "wss://192.168.1.10:5173/ws?role=phone",
        geolocation: geo,
        reconnectBaseMs: 1000,
        random: () => 0.5,
        socketFactory: () => {
          const s = new FakePhoneSocket();
          sockets.push(s);
          return s;
        },
      });

      client.start();
      expect(sockets).toHaveLength(1);

      // Simulate connection error on socket 0
      sockets[0]!.fail();
      expect(client.getSnapshot().errorMessage).toMatch(/Relay WebSocket connection failed/i);
      expect(client.getSnapshot().statusLabel).toBe("Reconnecting");

      // Watcher remains active (1 watcher, no leak) across WebSocket reconnects
      expect(geo.activeWatches.size).toBe(1);

      // Advance timer to trigger reconnect -> creates socket 1
      vi.advanceTimersByTime(1200);
      expect(sockets).toHaveLength(2);

      // Delayed close event on old socket[0] does not clobber socket[1]
      sockets[1]!.open();
      sockets[0]!.onclose?.();
      expect(client.getSnapshot().wsState).toBe("connected");

      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("evaluates turn-by-turn routes on the phone (SteedPilot Brain) and sends guidance & displayMode to HUD", () => {
    const sockets: FakePhoneSocket[] = [];
    const geo = new FakeGeo();
    let rerouteCalls = 0;
    const client = new PhoneGpsClient({
      url: "wss://192.168.1.10:5173/ws?role=phone",
      geolocation: geo,
      reconnectBaseMs: 0,
      socketFactory: () => {
        const s = new FakePhoneSocket();
        sockets.push(s);
        return s;
      },
      onAutoRerouteRequested: () => {
        rerouteCalls += 1;
      },
    });

    client.start();
    sockets[0]!.open();
    sockets[0]!.receive({ type: "presence", phones: 1, displays: 1 });

    client.setCalculatedRoute(
      {
        routeId: "r-phone-1",
        providerId: "test",
        isSynthetic: true,
        attribution: "Test",
        calculatedAtMs: 1000,
        origin: { latitude: 10.77, longitude: 106.69 },
        destination: { latitude: 10.772, longitude: 106.692 },
        totalDistanceMeters: 500,
        estimatedDurationSeconds: 60,
        geometry: [
          { latitude: 10.77, longitude: 106.69 },
          { latitude: 10.772, longitude: 106.69 },
          { latitude: 10.772, longitude: 106.692 },
        ],
        steps: [
          {
            maneuverLocation: { latitude: 10.772, longitude: 106.69 },
            turnDirection: "RIGHT",
            distanceMeters: 220,
            durationSeconds: 30,
            headingDegrees: 0,
            instruction: "Turn right onto Le Loi",
            speedLimitKmh: null,
            speedLimitStatus: "UNKNOWN",
          },
          {
            maneuverLocation: { latitude: 10.772, longitude: 106.692 },
            turnDirection: "STRAIGHT",
            distanceMeters: 0,
            durationSeconds: 0,
            headingDegrees: 90,
            instruction: "Arrive at Cho Ben Thanh",
            speedLimitKmh: null,
            speedLimitStatus: "UNKNOWN",
          },
        ],
      },
      "Cho Ben Thanh",
    );

    client.setDisplayMode("MAP");

    geo.emitFix(
      { latitude: 10.771, longitude: 106.69, speed: 10, heading: 0, accuracy: 5 },
      2000,
    );
    const lastSent = JSON.parse(sockets[0]!.sent.at(-1)!);
    expect(lastSent).toMatchObject({
      type: "gps",
      routeStatus: "ACTIVE",
      turnDirection: "RIGHT",
      destinationName: "Cho Ben Thanh",
      displayMode: "MAP",
    });
    expect(lastSent.distanceToTurnMeters).toBeGreaterThan(100);
    expect(rerouteCalls).toBe(0);
  });
});

describe("coordsToGpsMessage & Haversine speed fallback", () => {
  const base = { latitude: 21.0285, longitude: 105.8542, speed: 10, heading: 45, accuracy: 5 };
  it("maps native speed and heading when provided", () => {
    expect(coordsToGpsMessage(base)).toEqual({
      type: "gps",
      latitude: 21.0285,
      longitude: 105.8542,
      speedMps: 10,
      headingDegrees: 45,
      accuracyMeters: 5,
    });
  });

  it("turns platform 'unknown' values into null (never 0) when no previous sample exists", () => {
    expect(coordsToGpsMessage({ ...base, speed: null }).speedMps).toBeNull();
    expect(coordsToGpsMessage({ ...base, speed: -1 }).speedMps).toBeNull();
    expect(coordsToGpsMessage({ ...base, heading: NaN }).headingDegrees).toBeNull();
    expect(coordsToGpsMessage({ ...base, heading: -1 }).headingDegrees).toBeNull();
    expect(coordsToGpsMessage({ ...base, speed: 0 }).speedMps).toBe(0);
  });

  it("derives speed and heading from consecutive samples when iOS Safari reports speed === null", () => {
    const prev = {
      coords: { latitude: 21.0285, longitude: 105.8542, speed: null, heading: null, accuracy: 5 },
      timestamp: 1000,
    };
    const currCoords = { latitude: 21.0286, longitude: 105.8542, speed: null, heading: null, accuracy: 5 };
    const msg = coordsToGpsMessage(currCoords, {
      sampleTimestampMs: 2000,
      phoneReceivedAtMs: 2005,
      phoneSentAtMs: 2006,
      phoneSessionId: "s-1",
      phoneSeq: 2,
      previousSample: prev,
    });
    expect(msg.speedSource).toBe("derived");
    expect(msg.speedMps).toBeGreaterThan(10);
    expect(msg.speedMps).toBeLessThan(12);
    expect(msg.headingDegrees).toBeCloseTo(0, 0);
  });

  it("suppresses GPS jitter below noise floor and rejects poor accuracy in derived speed", () => {
    const prev = {
      coords: { latitude: 21.0285, longitude: 105.8542, speed: null, heading: null, accuracy: 8 },
      timestamp: 1000,
    };
    const jitter = deriveSpeedAndHeadingFromSamples(prev, {
      coords: { ...prev.coords, latitude: 21.028502 },
      timestamp: 2000,
    });
    expect(jitter.speedMps).toBe(0);

    const poor = deriveSpeedAndHeadingFromSamples(
      { ...prev, coords: { ...prev.coords, accuracy: 80 } },
      { coords: { ...prev.coords, latitude: 21.029, accuracy: 80 }, timestamp: 2000 },
    );
    expect(poor.speedMps).toBeNull();
  });
});

describe("describeGeoError", () => {
  it("explains permission denial", () => {
    expect(describeGeoError(1)).toMatch(/permission denied/i);
    expect(describeGeoError(2)).toMatch(/unavailable/i);
    expect(describeGeoError(3)).toMatch(/timed out/i);
    expect(describeGeoError(99)).toMatch(/unknown/i);
  });
});
