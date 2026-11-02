import { describe, expect, it } from "vitest";
import {
  BLE_MSG_TYPE_DEVICE_STATUS,
  WMAP_BLE_SERVICE_UUID,
  WMAP_BLE_TELEMETRY_CHAR_UUID,
  decodeBleTelemetryFrame,
  encodeBleDeviceStatus,
  type BleTelemetryFrame,
} from "@w-map/navigation-core";
import {
  WebBleLink,
  type BluetoothDeviceLike,
  type GattCharacteristicLike,
  type GattServerLike,
} from "../src/ble/WebBleLink";

const frame = (seq: number): BleTelemetryFrame => ({
  version: 1,
  msgType: 0x01,
  sessionId: 7,
  sequenceNumber: seq,
  timestampMs: 1000 + seq,
  gpsStatus: "ACTIVE",
  routeStatus: "ACTIVE",
  speedLimitStatus: "UNKNOWN",
  isOffRoute: false,
  hasArrived: false,
  turnDirection: "LEFT",
  currentSpeedKmh: 42,
  speedLimitKmh: null,
  gpsAccuracyMeters: 5,
  distanceToTurnMeters: 177,
  remainingDistanceMeters: 1200,
  etaDurationMinutes: 4,
  headingDegrees: 215,
  latitude: 15.9786,
  longitude: 108.2526,
});

function makeFakeBluetooth(opts: { failFirstConnects?: number; missingService?: boolean } = {}) {
  const writes: Uint8Array[] = [];
  let statusCb: ((ev: { target: { value?: DataView } }) => void) | null = null;
  let disconnectCb: (() => void) | null = null;
  let connectCalls = 0;
  let releaseWrite: (() => void) | null = null;
  let holdWrites = false;

  const telemetry: GattCharacteristicLike = {
    writeValueWithoutResponse: (v) => {
      writes.push(new Uint8Array(v as ArrayBuffer));
      if (!holdWrites) return Promise.resolve();
      return new Promise<void>((res) => {
        releaseWrite = res;
      });
    },
  };
  const status: GattCharacteristicLike = {
    writeValueWithoutResponse: () => Promise.resolve(),
    startNotifications: () => Promise.resolve(),
    addEventListener: (_t, cb) => {
      statusCb = cb;
    },
  };
  const server: GattServerLike = {
    connected: true,
    disconnect: () => {
      server.connected = false;
    },
    getPrimaryService: async (uuid) => {
      if (opts.missingService || uuid !== WMAP_BLE_SERVICE_UUID) throw new Error("Service not found");
      return {
        getCharacteristic: async (c) => (c === WMAP_BLE_TELEMETRY_CHAR_UUID ? telemetry : status),
      };
    },
  };
  const device: BluetoothDeviceLike = {
    name: "W_MAP Display",
    gatt: {
      connect: async () => {
        connectCalls += 1;
        if (connectCalls <= (opts.failFirstConnects ?? 0)) throw new Error("GATT connect failed");
        server.connected = true;
        return server;
      },
    },
    addEventListener: (_t, cb) => {
      disconnectCb = cb;
    },
  };
  return {
    bluetooth: { requestDevice: async () => device },
    writes,
    holdWrites: (v: boolean) => (holdWrites = v),
    release: () => releaseWrite?.(),
    notifyStatus: (bytes: Uint8Array) =>
      statusCb?.({ target: { value: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) } }),
    dropLink: () => {
      server.connected = false;
      disconnectCb?.();
    },
    connectCalls: () => connectCalls,
  };
}

describe("WebBleLink", () => {
  it("is READY only after the telemetry characteristic is discovered, and sends decodable frames", async () => {
    const fake = makeFakeBluetooth();
    const link = new WebBleLink({ bluetooth: fake.bluetooth });
    expect(await link.sendTelemetry(frame(1))).toBe(false); // nothing sent before connect
    await link.connect();
    expect(link.getSnapshot().state).toBe("ready");
    expect(await link.sendTelemetry(frame(2))).toBe(true);
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]!.byteLength).toBe(38);
    const decoded = decodeBleTelemetryFrame(fake.writes[0]!);
    expect(decoded.ok && decoded.value.sequenceNumber).toBe(2);
    expect(decoded.ok && decoded.value.distanceToTurnMeters).toBe(177);
  });

  it("fails visibly (not silently 'connected') when the W_MAP service is missing", async () => {
    const link = new WebBleLink({ bluetooth: makeFakeBluetooth({ missingService: true }).bluetooth });
    await link.connect();
    expect(link.getSnapshot().state).toBe("failed");
    expect(link.getSnapshot().lastError).toMatch(/service/i);
    expect(await link.sendTelemetry(frame(1))).toBe(false);
  });

  it("reports unsupported browsers (e.g. iPhone Safari) explicitly", async () => {
    const link = new WebBleLink({ bluetooth: null });
    expect(link.isSupported).toBe(false);
    await link.connect();
    expect(link.getSnapshot().state).toBe("failed");
    expect(link.getSnapshot().lastError).toMatch(/not supported/i);
  });

  it("coalesces to the newest frame while a write is in flight (no growing backlog)", async () => {
    const fake = makeFakeBluetooth();
    const link = new WebBleLink({ bluetooth: fake.bluetooth });
    await link.connect();
    fake.holdWrites(true);
    const first = link.sendTelemetry(frame(1));
    await link.sendTelemetry(frame(2)); // replaced by 3
    await link.sendTelemetry(frame(3));
    fake.holdWrites(false);
    fake.release();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    const seqs = fake.writes.map((w) => {
      const d = decodeBleTelemetryFrame(w);
      return d.ok ? d.value.sequenceNumber : -1;
    });
    expect(seqs).toEqual([1, 3]); // frame 2 was never sent: stale
    expect(link.getSnapshot().framesDropped).toBe(2);
  });

  it("uses device status notifications as end-to-end acknowledgement", async () => {
    const fake = makeFakeBluetooth();
    const link = new WebBleLink({ bluetooth: fake.bluetooth });
    await link.connect();
    await link.sendTelemetry(frame(10));
    fake.notifyStatus(
      encodeBleDeviceStatus({
        version: 1,
        msgType: BLE_MSG_TYPE_DEVICE_STATUS,
        lastSessionId: 7,
        lastAcceptedSequence: 9,
        lastPhoneTimestampMs: 1009,
        deviceUptimeMs: 5000,
        rxErrorCount: 0,
      }),
    );
    expect(link.getSnapshot().deviceAckSequence).toBe(9);
    expect(link.getSnapshot().unackedFrames).toBe(1);
  });

  it("auto-reconnects after the link drops and stops sending while down", async () => {
    const fake = makeFakeBluetooth();
    const link = new WebBleLink({ bluetooth: fake.bluetooth, reconnectDelayMs: 5 });
    await link.connect();
    fake.dropLink();
    expect(await link.sendTelemetry(frame(1))).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(link.getSnapshot().state).toBe("ready");
    expect(fake.connectCalls()).toBe(2);
    expect(await link.sendTelemetry(frame(2))).toBe(true);
  });

  it("gives up with a clear error after max reconnect attempts", async () => {
    const fake = makeFakeBluetooth({ failFirstConnects: 99 });
    const link = new WebBleLink({ bluetooth: fake.bluetooth, reconnectDelayMs: 1, maxReconnectAttempts: 3 });
    await link.connect(); // first openGatt fails -> failed
    expect(link.getSnapshot().state).toBe("failed");
  });

  it("does not auto-reconnect after a user disconnect", async () => {
    const fake = makeFakeBluetooth();
    const link = new WebBleLink({ bluetooth: fake.bluetooth, reconnectDelayMs: 5 });
    await link.connect();
    link.disconnect();
    fake.dropLink();
    await new Promise((r) => setTimeout(r, 30));
    expect(link.getSnapshot().state).toBe("idle");
    expect(fake.connectCalls()).toBe(1);
  });
});
