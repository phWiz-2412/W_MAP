import { describe, expect, it } from "vitest";
import { DEFAULT_LIVE_GPS_CONFIG, buildLiveNavigationData, mpsToKmh, validateGpsFix, validateNavigationData, type GpsFixMessage, type LiveGpsState } from "../src";

const fix: GpsFixMessage = { type: "gps", latitude: 21.03, longitude: 105.85, speedMps: 10, headingDegrees: 90, accuracyMeters: 5 };
const state = (patch: Partial<LiveGpsState> = {}): LiveGpsState => ({ fix, fixReceivedAtMs: 1000, linkConnected: true, ...patch });

describe("mpsToKmh", () => {
  it("converts and rounds", () => {
    expect(mpsToKmh(10)).toBe(36);
    expect(mpsToKmh(0)).toBe(0);
    expect(mpsToKmh(13.9)).toBe(50);
  });
  it("returns null for unknown, negative, NaN and implausible values", () => {
    for (const v of [null, -1, NaN, Infinity, 1000]) expect(mpsToKmh(v)).toBeNull();
  });
});

describe("validateGpsFix", () => {
  it("accepts a valid fix and normalises missing optionals to null", () => {
    const r = validateGpsFix({ type: "gps", latitude: 1, longitude: 2 });
    expect(r.ok && r.value).toEqual({ type: "gps", latitude: 1, longitude: 2, speedMps: null, headingDegrees: null, accuracyMeters: null });
  });
  it("rejects malformed fixes", () => {
    for (const v of [null, [], { type: "x", latitude: 1, longitude: 1 }, { type: "gps", latitude: 91, longitude: 1 }, { type: "gps", latitude: 1, longitude: NaN }, { type: "gps", latitude: 1, longitude: 1, speedMps: "5" }, { type: "gps", latitude: 1, longitude: 1, accuracyMeters: -3 }]) {
      expect(validateGpsFix(v).ok).toBe(false);
    }
  });
});

describe("buildLiveNavigationData", () => {
  it("uses the real fix speed and produces valid NavigationData", () => {
    const d = buildLiveNavigationData(state(), 1500, 7);
    expect(d.currentSpeedKmh).toBe(36);
    expect(d.gpsStatus).toBe("ACTIVE");
    expect(d.bleStatus).toBe("CONNECTED");
    expect(d.headingDegrees).toBe(90);
    expect(validateNavigationData(d).ok).toBe(true);
  });
  it("never invents a speed limit or navigation", () => {
    const d = buildLiveNavigationData(state(), 1500, 1);
    expect(d.speedLimitKmh).toBeNull();
    expect(d.speedLimitStatus).toBe("UNKNOWN");
    expect(d.routeStatus).toBe("INACTIVE");
    expect(d.routePoints).toEqual([]);
  });
  it("GPS is LOST after the timeout but keeps the last known position", () => {
    const d = buildLiveNavigationData(state(), 1000 + DEFAULT_LIVE_GPS_CONFIG.gpsTimeoutMs + 1, 1);
    expect(d.gpsStatus).toBe("LOST");
    expect(d.latitude).toBe(21.03);
  });
  it("is still ACTIVE exactly at the timeout", () => {
    expect(buildLiveNavigationData(state(), 1000 + DEFAULT_LIVE_GPS_CONFIG.gpsTimeoutMs, 1).gpsStatus).toBe("ACTIVE");
  });
  it("poor accuracy is not trusted", () => {
    expect(buildLiveNavigationData(state({ fix: { ...fix, accuracyMeters: 500 } }), 1100, 1).gpsStatus).toBe("LOST");
  });
  it("no fix yet: LOST, no position, no speed", () => {
    const d = buildLiveNavigationData(state({ fix: null, fixReceivedAtMs: null }), 0, 1);
    expect(d).toMatchObject({ gpsStatus: "LOST", latitude: null, longitude: null, currentSpeedKmh: null });
    expect(validateNavigationData(d).ok).toBe(true);
  });
  it("unknown speed from the platform is null, not 0", () => {
    expect(buildLiveNavigationData(state({ fix: { ...fix, speedMps: null } }), 1100, 1).currentSpeedKmh).toBeNull();
  });
  it("drops invalid heading", () => {
    expect(buildLiveNavigationData(state({ fix: { ...fix, headingDegrees: -1 } }), 1100, 1).headingDegrees).toBeNull();
    expect(buildLiveNavigationData(state({ fix: { ...fix, headingDegrees: 360 } }), 1100, 1).headingDegrees).toBeNull();
  });
  it("link down is reported as DISCONNECTED", () => {
    expect(buildLiveNavigationData(state({ linkConnected: false }), 1100, 1).bleStatus).toBe("DISCONNECTED");
  });
});
