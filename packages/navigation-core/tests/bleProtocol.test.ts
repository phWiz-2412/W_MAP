import { describe, expect, it } from "vitest";
import {
  BLE_GOLDEN_VECTORS,
  BLE_MSG_TYPE_DEVICE_STATUS,
  BLE_MSG_TYPE_TELEMETRY,
  BleLatestStateTxQueue,
  BleReceiverStateMachine,
  WMAP_BLE_TELEMETRY_FRAME_BYTES,
  bytesToHex,
  decodeBleDeviceStatus,
  decodeBleTelemetryFrame,
  decodeGooglePolyline,
  encodeBleDeviceStatus,
  encodeBleTelemetryFrame,
  encodeGooglePolyline,
  evaluateRouteProgress,
  evaluateSpeed,
  DEFAULT_WARNING_CONFIG,
  hexToBytes,
  type BleTelemetryFrame,
  type CalculatedRoute,
} from "../src/index";

describe("BLE v1 Binary Telemetry Protocol & Golden Test Vectors", () => {
  it("encodes and decodes shared golden test vectors deterministically", () => {
    for (const vec of BLE_GOLDEN_VECTORS) {
      const encoded = encodeBleTelemetryFrame(vec.frame);
      expect(encoded.byteLength).toBe(WMAP_BLE_TELEMETRY_FRAME_BYTES);
      const hex = bytesToHex(encoded);
      expect(hex).toBe(vec.expectedHex);

      const decoded = decodeBleTelemetryFrame(hexToBytes(vec.expectedHex));
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value).toEqual(vec.frame);
      }
    }
  });

  it("rejects truncated, oversized, or CRC-corrupted payloads", () => {
    const valid = encodeBleTelemetryFrame(BLE_GOLDEN_VECTORS[0]!.frame);
    expect(decodeBleTelemetryFrame(valid.slice(0, 20)).ok).toBe(false);

    const corrupted = new Uint8Array(valid);
    corrupted[12]! ^= 0x01; // flip 1 bit in speed
    const res = decodeBleTelemetryFrame(corrupted);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]).toMatch(/CRC-16 mismatch/i);
    }
  });

  it("rejects unsupported protocol version, invalid enum indices, and invalid speed-limit combinations", () => {
    const raw = new Uint8Array(encodeBleTelemetryFrame(BLE_GOLDEN_VECTORS[0]!.frame));
    const view = new DataView(raw.buffer);

    // Unsupported version = 2
    raw[0] = 2;
    // Recompute CRC so we test semantic validation after CRC check
    const fixCrc = (arr: Uint8Array) => {
      let crc = 0xffff;
      for (let i = 0; i < 36; i++) {
        crc ^= (arr[i]! & 0xff) << 8;
        for (let b = 0; b < 8; b++) {
          crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
        }
      }
      new DataView(arr.buffer).setUint16(36, crc, true);
    };

    fixCrc(raw);
    const vRes = decodeBleTelemetryFrame(raw);
    expect(vRes.ok).toBe(false);
    if (!vRes.ok) expect(vRes.errors.join(" ")).toMatch(/Unsupported BLE protocol version/);

    // Invalid turnDirection index = 99
    raw[0] = 1;
    raw[11] = 99;
    fixCrc(raw);
    const tRes = decodeBleTelemetryFrame(raw);
    expect(tRes.ok).toBe(false);
    if (!tRes.ok) expect(tRes.errors.join(" ")).toMatch(/Invalid turnDirection/);

    // UNKNOWN speedLimitStatus with non-zero speedLimitKmh = 50
    raw[11] = 1;
    raw[10] = 0b0000_0011; // speedLimitStatus bits = 0 (UNKNOWN)
    raw[14] = 50;
    fixCrc(raw);
    const sRes = decodeBleTelemetryFrame(raw);
    expect(sRes.ok).toBe(false);
    if (!sRes.ok) expect(sRes.errors.join(" ")).toMatch(/UNKNOWN speedLimitStatus requires speedLimitKmh/);

    // Out-of-range latitude (> 90 deg)
    raw[14] = 0;
    view.setInt32(28, 95_000_000, true);
    fixCrc(raw);
    const cRes = decodeBleTelemetryFrame(raw);
    expect(cRes.ok).toBe(false);
    if (!cRes.ok) expect(cRes.errors.join(" ")).toMatch(/Coordinate out of range/);
  });

  it("encodes and decodes 16-byte Device Status / Ack frames", () => {
    const status = {
      version: 1,
      msgType: BLE_MSG_TYPE_DEVICE_STATUS,
      lastSessionId: 0x1024,
      lastAcceptedSequence: 42,
      lastPhoneTimestampMs: 99_500,
      deviceUptimeMs: 120_000,
      rxErrorCount: 0,
    } as const;
    const bytes = encodeBleDeviceStatus(status);
    const decoded = decodeBleDeviceStatus(bytes);
    expect(decoded).toEqual({ ok: true, value: status });
  });
});

describe("BleLatestStateTxQueue & BleReceiverStateMachine (End-to-End Pipeline)", () => {
  const baseFrame: BleTelemetryFrame = {
    ...BLE_GOLDEN_VECTORS[0]!.frame,
    sessionId: 100,
    sequenceNumber: 1,
    timestampMs: 1000,
  };

  it("suppresses redundant frames within heartbeat window and coalesces backlog when BLE channel is busy", () => {
    const tx = new BleLatestStateTxQueue(1000);

    // First frame transmits immediately
    const p1 = tx.enqueue(baseFrame, 1000);
    expect(p1).not.toBeNull();
    expect(tx.sentCount).toBe(1);

    // Identical state 200ms later is skipped as redundant
    const p2 = tx.enqueue({ ...baseFrame, sequenceNumber: 2, timestampMs: 1200 }, 1200);
    expect(p2).toBeNull();
    expect(tx.redundantSkips).toBe(1);

    // Identical state 1000ms later is sent as a freshness heartbeat
    const p3 = tx.enqueue({ ...baseFrame, sequenceNumber: 3, timestampMs: 2000 }, 2000);
    expect(p3).not.toBeNull();
    expect(tx.sentCount).toBe(2);

    // When channel is busy, multiple rapid maneuver/speed updates coalesce to the latest frame
    tx.setChannelBusy(true);
    expect(tx.enqueue({ ...baseFrame, sequenceNumber: 4, currentSpeedKmh: 50 }, 2100)).toBeNull();
    expect(tx.enqueue({ ...baseFrame, sequenceNumber: 5, currentSpeedKmh: 55 }, 2200)).toBeNull();
    expect(tx.coalescedDrops).toBe(1);

    tx.setChannelBusy(false);
    const flushed = tx.flushPending(2250);
    expect(flushed).not.toBeNull();
    const decoded = decodeBleTelemetryFrame(flushed!);
    expect(decoded.ok && decoded.value.sequenceNumber).toBe(5);
    expect(decoded.ok && decoded.value.currentSpeedKmh).toBe(55);
  });

  it("simulates full pipeline: GPS -> route progress -> BLE encoding -> transport -> receiver -> display state", () => {
    const route: CalculatedRoute = {
      routeId: "vn-trip-1",
      providerId: "google-routes",
      isSynthetic: false,
      attribution: "Google Maps",
      calculatedAtMs: 1000,
      origin: { latitude: 16.06, longitude: 108.22 },
      destination: { latitude: 16.065, longitude: 108.225 },
      totalDistanceMeters: 800,
      estimatedDurationSeconds: 120,
      geometry: [
        { latitude: 16.06, longitude: 108.22 },
        { latitude: 16.0625, longitude: 108.22 },
        { latitude: 16.0625, longitude: 108.225 },
        { latitude: 16.065, longitude: 108.225 },
      ],
      steps: [
        {
          turnDirection: "RIGHT",
          maneuverLocation: { latitude: 16.0625, longitude: 108.22 },
          distanceMeters: 280,
          durationSeconds: 40,
          headingDegrees: 0,
          instruction: "Turn right onto Đường Bạch Đằng",
          speedLimitKmh: null,
          speedLimitStatus: "UNKNOWN",
        },
        {
          turnDirection: "LEFT",
          maneuverLocation: { latitude: 16.0625, longitude: 108.225 },
          distanceMeters: 520,
          durationSeconds: 80,
          headingDegrees: 90,
          instruction: "Turn left onto Cầu Rồng",
          speedLimitKmh: null,
          speedLimitStatus: "UNKNOWN",
        },
      ],
    };

    const rx = new BleReceiverStateMachine(3000);
    const eval1 = evaluateRouteProgress(route, { latitude: 16.061, longitude: 108.22 }, 5, "ACTIVE");

    const frame1: BleTelemetryFrame = {
      version: 1,
      msgType: BLE_MSG_TYPE_TELEMETRY,
      sessionId: 500,
      sequenceNumber: 10,
      timestampMs: 5000,
      gpsStatus: "ACTIVE",
      routeStatus: "ACTIVE",
      speedLimitStatus: eval1.activeStep.speedLimitStatus,
      isOffRoute: eval1.isOffRoute,
      hasArrived: eval1.hasArrived,
      turnDirection: eval1.activeStep.turnDirection,
      currentSpeedKmh: 42,
      speedLimitKmh: eval1.activeStep.speedLimitKmh,
      gpsAccuracyMeters: 5,
      distanceToTurnMeters: eval1.distanceToNextTurnMeters,
      remainingDistanceMeters: eval1.remainingDistanceMeters,
      etaDurationMinutes: 2,
      headingDegrees: 0,
      latitude: 16.061,
      longitude: 108.22,
    };

    const wire1 = encodeBleTelemetryFrame(frame1);
    expect(rx.receiveTelemetryBytes(wire1, 5020).ok).toBe(true);

    // Duplicate packet #10 is rejected
    expect(rx.receiveTelemetryBytes(wire1, 5050).ok).toBe(false);
    expect(rx.getSnapshot(5050).duplicateOrOldFrames).toBe(1);

    // Snapshot at t=5100ms is fresh and produces valid NavigationData with UNKNOWN_LIMIT speed state
    const snapFresh = rx.getSnapshot(5100);
    expect(snapFresh.isStale).toBe(false);
    expect(snapFresh.navigationData?.currentSpeedKmh).toBe(42);
    expect(snapFresh.navigationData?.turnDirection).toBe("RIGHT");
    const speedEvalFresh = evaluateSpeed(
      { ...snapFresh.navigationData!, packetAgeMs: 5100 - snapFresh.navigationData!.timestamp },
      DEFAULT_WARNING_CONFIG,
      { warning: false, overSinceMs: null },
      5100,
    );
    expect(speedEvalFresh.state).toBe("UNKNOWN_LIMIT");

    // Advance receiver clock by 4000ms without new BLE packets -> DATA_STALE
    const snapStale = rx.getSnapshot(9100);
    expect(snapStale.isStale).toBe(true);
    expect(snapStale.navigationData?.currentSpeedKmh).toBeNull();
    const speedEvalStale = evaluateSpeed(
      { ...snapStale.navigationData!, packetAgeMs: 9100 - snapStale.navigationData!.timestamp },
      DEFAULT_WARNING_CONFIG,
      { warning: false, overSinceMs: null },
      9100,
    );
    expect(speedEvalStale.state).toBe("DATA_STALE");

    // Reconnect with a new sessionId (501) resets sequence gate cleanly so seq #1 is accepted
    const frameReconnect: BleTelemetryFrame = {
      ...frame1,
      sessionId: 501,
      sequenceNumber: 1,
      timestampMs: 9500,
    };
    expect(rx.receiveTelemetryBytes(encodeBleTelemetryFrame(frameReconnect), 9520).ok).toBe(true);
    expect(rx.getSnapshot(9550).sessionResets).toBe(1);
    expect(rx.getSnapshot(9550).isStale).toBe(false);
  });
});

describe("Google Maps Encoded Polyline Codec", () => {
  it("encodes and decodes route coordinates accurately", () => {
    const pts = [
      { latitude: 16.0611, longitude: 108.2272 },
      { latitude: 16.0655, longitude: 108.2315 },
      { latitude: 16.0712, longitude: 108.2241 },
    ];
    const encoded = encodeGooglePolyline(pts);
    const decoded = decodeGooglePolyline(encoded);
    expect(decoded).toHaveLength(3);
    expect(decoded[0]?.latitude).toBeCloseTo(16.0611, 4);
    expect(decoded[0]?.longitude).toBeCloseTo(108.2272, 4);
    expect(decoded[2]?.latitude).toBeCloseTo(16.0712, 4);
  });

  it("rejects empty or corrupted encoded polylines", () => {
    expect(() => decodeGooglePolyline("")).toThrow(/non-empty/);
    expect(() => decodeGooglePolyline("???")).toThrow();
  });
});
