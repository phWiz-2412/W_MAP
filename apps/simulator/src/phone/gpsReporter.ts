import type { GpsFixMessage } from "@w-map/navigation-core";

/** The subset of the browser GeolocationCoordinates we use (also easy to fake in tests). */
export interface CoordsLike {
  latitude: number;
  longitude: number;
  speed: number | null;
  heading: number | null;
  accuracy: number;
}

const finiteOrNull = (v: number | null): number | null => (v !== null && Number.isFinite(v) ? v : null);

/** Converts a browser position into the wire message. Platform "unknown" values become null. */
export function coordsToGpsMessage(c: CoordsLike): GpsFixMessage {
  const speed = finiteOrNull(c.speed);
  const heading = finiteOrNull(c.heading);
  return {
    type: "gps",
    latitude: c.latitude,
    longitude: c.longitude,
    speedMps: speed !== null && speed >= 0 ? speed : null,
    headingDegrees: heading !== null && heading >= 0 && heading < 360 ? heading : null,
    accuracyMeters: Number.isFinite(c.accuracy) && c.accuracy >= 0 ? c.accuracy : null,
  };
}

/** Human-readable explanation of a geolocation error code (1 denied, 2 unavailable, 3 timeout). */
export function describeGeoError(code: number): string {
  switch (code) {
    case 1:
      return "Location permission denied. Allow location for this site in iPhone Settings > Privacy > Location Services > Safari Websites.";
    case 2:
      return "Position unavailable (no GPS fix yet).";
    case 3:
      return "Timed out waiting for a GPS fix.";
    default:
      return "Unknown location error.";
  }
}
