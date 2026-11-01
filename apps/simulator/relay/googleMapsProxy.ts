import type { IncomingMessage, ServerResponse } from "node:http";

export interface GoogleMapsProxyOptions {
  /** Overrides `process.env.GOOGLE_MAPS_SERVER_API_KEY` for deterministic unit testing. */
  getApiKey?: () => string | undefined;
  /** Overrides `fetch` for deterministic unit testing without hitting external Google endpoints. */
  fetchFn?: typeof fetch;
}

const PLACES_FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.location,places.primaryType";
const ROUTES_FIELD_MASK =
  "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.distanceMeters,routes.legs.duration,routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration,routes.legs.steps.polyline.encodedPolyline,routes.legs.steps.startLocation,routes.legs.steps.endLocation,routes.legs.steps.navigationInstruction";

function readJsonBody(req: IncomingMessage, maxBytes = 16_384): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Request body exceeds maximum size"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed: unknown = JSON.parse(raw || "{}");
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          reject(new Error("Request body must be a JSON object"));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error("Malformed JSON request body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function isValidCoord(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/**
 * Server-side HTTP proxy handler for Google Maps Platform Places API (New) and Routes API v2.
 * Keeps `GOOGLE_MAPS_SERVER_API_KEY` strictly on the Node.js backend so private server keys
 * are never exposed to the browser bundle or ESP32-S3 firmware.
 */
export function createGoogleMapsProxyMiddleware(options: GoogleMapsProxyOptions = {}) {
  const getKey =
    options.getApiKey ??
    (() => {
      const k = process.env.GOOGLE_MAPS_SERVER_API_KEY?.trim();
      return k && k.length > 0 && !k.startsWith("YOUR_") ? k : undefined;
    });
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  return async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
    const urlPath = (req.url ?? "").split("?")[0];
    if (!urlPath || !urlPath.startsWith("/api/google/")) {
      next();
      return;
    }

    if (req.method === "GET" && urlPath === "/api/google/status") {
      sendJson(res, 200, { configured: Boolean(getKey()) });
      return;
    }

    const apiKey = getKey();
    if (!apiKey) {
      sendJson(res, 503, {
        error:
          "GOOGLE_MAPS_SERVER_API_KEY is not configured in server environment (.env). Set GOOGLE_MAPS_SERVER_API_KEY or switch to OpenStreetMap / Synthetic provider.",
      });
      return;
    }

    if (req.method === "POST" && urlPath === "/api/google/places") {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : "Invalid request" });
        return;
      }

      const textQuery = typeof body.textQuery === "string" ? body.textQuery.trim() : "";
      if (!textQuery) {
        sendJson(res, 400, { error: "textQuery must be a non-empty string" });
        return;
      }
      const maxResultCount =
        typeof body.maxResultCount === "number" && Number.isFinite(body.maxResultCount)
          ? Math.min(10, Math.max(1, Math.floor(body.maxResultCount)))
          : 6;
      const regionCode = typeof body.regionCode === "string" ? body.regionCode : "VN";
      const languageCode = typeof body.languageCode === "string" ? body.languageCode : "vi";

      try {
        const upstream = await fetchFn("https://places.googleapis.com/v1/places:searchText", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": PLACES_FIELD_MASK,
          },
          body: JSON.stringify({
            textQuery,
            maxResultCount,
            regionCode,
            languageCode,
          }),
        });
        const data: unknown = await upstream.json().catch(() => ({}));
        sendJson(res, upstream.status, data);
      } catch (err) {
        sendJson(res, 502, {
          error: err instanceof Error ? err.message : "Upstream Google Places request failed",
        });
      }
      return;
    }

    if (req.method === "POST" && urlPath === "/api/google/routes") {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : "Invalid request" });
        return;
      }

      const orig = body.origin as { latitude?: unknown; longitude?: unknown } | undefined;
      const dest = body.destination as { latitude?: unknown; longitude?: unknown } | undefined;
      if (!orig || !dest || !isValidCoord(orig.latitude, orig.longitude) || !isValidCoord(dest.latitude, dest.longitude)) {
        sendJson(res, 400, { error: "Valid origin and destination coordinates are required" });
        return;
      }

      const prefs = (body.preferences ?? {}) as Record<string, unknown>;
      const travelMode = prefs.travelMode === "DRIVE" ? "DRIVE" : "TWO_WHEELER";
      const routeModifiers = {
        avoidHighways: Boolean(prefs.avoidHighways),
        avoidTolls: Boolean(prefs.avoidTolls),
        avoidFerries: Boolean(prefs.avoidFerries),
      };

      try {
        const upstream = await fetchFn("https://routes.googleapis.com/directions/v2:computeRoutes", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": ROUTES_FIELD_MASK,
          },
          body: JSON.stringify({
            origin: {
              location: {
                latLng: { latitude: orig.latitude, longitude: orig.longitude },
              },
            },
            destination: {
              location: {
                latLng: { latitude: dest.latitude, longitude: dest.longitude },
              },
            },
            travelMode,
            routeModifiers,
            computeAlternativeRoutes: false,
            languageCode: "vi",
            units: "METRIC",
          }),
        });
        const data: unknown = await upstream.json().catch(() => ({}));
        sendJson(res, upstream.status, data);
      } catch (err) {
        sendJson(res, 502, {
          error: err instanceof Error ? err.message : "Upstream Google Routes request failed",
        });
      }
      return;
    }

    sendJson(res, 404, { error: `Unknown Google Maps proxy endpoint: ${urlPath}` });
  };
}
