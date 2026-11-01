import { PROTOCOL_VERSION, type NavigationData, type WarningConfig } from "@w-map/navigation-core";
import { DEMO_ROUTE } from "../src/fixtures/demoRoute";

export const instant: WarningConfig = { thresholdKmh: 5, hysteresisKmh: 3, persistenceMs: 0, maxPacketAgeMs: 3000 };

export const makeData = (patch: Partial<NavigationData> = {}): NavigationData => ({
  sequenceNumber: 1,
  timestamp: 0,
  currentSpeedKmh: 45,
  speedLimitKmh: 50,
  turnDirection: "RIGHT",
  distanceToTurnMeters: 350,
  latitude: DEMO_ROUTE[0]!.latitude,
  longitude: DEMO_ROUTE[0]!.longitude,
  headingDegrees: 0,
  gpsStatus: "ACTIVE",
  bleStatus: "CONNECTED",
  routeStatus: "ACTIVE",
  speedLimitStatus: "VALID",
  routePoints: [...DEMO_ROUTE],
  ...patch,
});

export const packetJson = (patch: Partial<NavigationData> = {}): string =>
  JSON.stringify({ version: PROTOCOL_VERSION, data: makeData(patch) });
