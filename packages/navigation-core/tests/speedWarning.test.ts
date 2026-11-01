import { describe, expect, it } from "vitest";
import {
  DEFAULT_WARNING_CONFIG,
  INITIAL_TRACKER,
  evaluateSpeed,
  pendingDelayMs,
  type SpeedInput,
  type WarningConfig,
} from "../src";

const cfg: WarningConfig = { thresholdKmh: 5, hysteresisKmh: 3, persistenceMs: 1000, maxPacketAgeMs: 3000 };
const instant: WarningConfig = { ...cfg, persistenceMs: 0 };
const base: SpeedInput = {
  currentSpeedKmh: 40,
  speedLimitKmh: 50,
  speedLimitStatus: "VALID",
  gpsStatus: "ACTIVE",
  bleStatus: "CONNECTED",
  packetAgeMs: 0,
};
const ev = (patch: Partial<SpeedInput>, c = instant, t = INITIAL_TRACKER, now = 0) => evaluateSpeed({ ...base, ...patch }, c, t, now);

describe("evaluateSpeed", () => {
  it("is NORMAL below the limit and at zero speed", () => {
    expect(ev({}).state).toBe("NORMAL");
    expect(ev({ currentSpeedKmh: 0 }).state).toBe("NORMAL");
  });

  it("is NORMAL at exactly limit + threshold, WARNING one above", () => {
    expect(ev({ currentSpeedKmh: 55 }).state).toBe("NORMAL");
    expect(ev({ currentSpeedKmh: 56 }).state).toBe("WARNING");
  });

  it("requires persistence before warning", () => {
    const over = { currentSpeedKmh: 70 };
    const a = ev(over, cfg, INITIAL_TRACKER, 1000);
    expect(a.state).toBe("NORMAL");
    expect(pendingDelayMs(a.tracker, cfg, 1000)).toBe(1000);
    const b = ev(over, cfg, a.tracker, 1999);
    expect(b.state).toBe("NORMAL");
    const c = ev(over, cfg, b.tracker, 2000);
    expect(c.state).toBe("WARNING");
    expect(pendingDelayMs(c.tracker, cfg, 2000)).toBeNull();
  });

  it("a brief spike (GPS noise) does not warn", () => {
    const a = ev({ currentSpeedKmh: 70 }, cfg, INITIAL_TRACKER, 0);
    const b = ev({ currentSpeedKmh: 50 }, cfg, a.tracker, 400);
    expect(b.tracker.overSinceMs).toBeNull();
    const c = ev({ currentSpeedKmh: 70 }, cfg, b.tracker, 600);
    expect(ev({ currentSpeedKmh: 70 }, cfg, c.tracker, 1200).state).toBe("NORMAL");
  });

  it("uses hysteresis when clearing (on 55, off 52)", () => {
    const on = ev({ currentSpeedKmh: 60 });
    expect(on.state).toBe("WARNING");
    const s54 = ev({ currentSpeedKmh: 54 }, instant, on.tracker, 1);
    const s53 = ev({ currentSpeedKmh: 53 }, instant, s54.tracker, 2);
    expect([s54.state, s53.state]).toEqual(["WARNING", "WARNING"]);
    expect(ev({ currentSpeedKmh: 52 }, instant, s53.tracker, 3).state).toBe("NORMAL");
  });

  it("respects a configurable threshold", () => {
    expect(ev({ currentSpeedKmh: 51 }, { ...instant, thresholdKmh: 0 }).state).toBe("WARNING");
  });

  it("unknown limit: UNKNOWN_LIMIT, never a warning, never treated as zero", () => {
    expect(ev({ currentSpeedKmh: 150, speedLimitKmh: null, speedLimitStatus: "UNKNOWN" }).state).toBe("UNKNOWN_LIMIT");
  });

  it("stale limit: STALE_LIMIT and no warning (not verified)", () => {
    expect(ev({ currentSpeedKmh: 150, speedLimitStatus: "STALE" }).state).toBe("STALE_LIMIT");
  });

  it("stale packet: DATA_STALE suppresses warnings", () => {
    expect(ev({ currentSpeedKmh: 150, packetAgeMs: 3001 }).state).toBe("DATA_STALE");
    expect(ev({ currentSpeedKmh: 150, packetAgeMs: 3000 }).state).toBe("WARNING");
  });

  it("treats negative packet age (clock skew) as fresh", () => {
    expect(ev({ packetAgeMs: -9999 }).state).toBe("NORMAL");
  });

  it("GPS loss suppresses warnings", () => {
    expect(ev({ gpsStatus: "LOST", currentSpeedKmh: 150 }).state).toBe("GPS_LOST");
  });

  it("BLE disconnection has the highest priority", () => {
    expect(ev({ bleStatus: "DISCONNECTED", gpsStatus: "LOST", packetAgeMs: 99999 }).state).toBe("DISCONNECTED");
  });

  it("reports missing speed", () => {
    expect(ev({ currentSpeedKmh: null }).state).toBe("NO_SPEED");
  });

  it("resets an active warning on GPS loss and recovers cleanly afterwards", () => {
    const on = ev({ currentSpeedKmh: 90 });
    const lost = ev({ currentSpeedKmh: 90, gpsStatus: "LOST" }, instant, on.tracker, 1);
    expect(lost.tracker).toEqual(INITIAL_TRACKER);
    expect(ev({ currentSpeedKmh: 90 }, instant, lost.tracker, 2).state).toBe("WARNING");
  });

  it("has sane defaults", () => {
    expect(DEFAULT_WARNING_CONFIG.hysteresisKmh).toBeGreaterThan(0);
    expect(DEFAULT_WARNING_CONFIG.persistenceMs).toBeGreaterThan(0);
  });
});
