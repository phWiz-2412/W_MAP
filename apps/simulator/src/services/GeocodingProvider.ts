import type { RoutePoint } from "@w-map/navigation-core";

export interface GeocodingCandidate {
  id: string;
  /** Short primary name (e.g., "Chợ Bến Thành"). */
  name: string;
  /** Full address / context string to disambiguate similar names. */
  displayName: string;
  /** Optional category / type (e.g., "marketplace", "landmark", "street"). */
  category?: string;
  location: RoutePoint;
  isSynthetic: boolean;
  attribution: string;
}

export interface GeocodingSearchOptions {
  signal?: AbortSignal;
  limit?: number;
  countryCode?: string;
}

/**
 * Separate geocoding provider interface: converts a place name, street address, or POI query
 * into candidate geographic coordinates. Does NOT calculate routes.
 */
export interface GeocodingProvider {
  readonly id: string;
  readonly label: string;
  readonly isSynthetic: boolean;
  readonly attribution: string;
  search(query: string, options?: GeocodingSearchOptions): Promise<GeocodingCandidate[]>;
}

/**
 * Deterministic offline catalog of Vietnamese landmarks, streets, and ambiguous place names
 * for local simulator testing without Internet access. Explicitly labeled as synthetic test data.
 */
export const SYNTHETIC_VN_PLACES: readonly GeocodingCandidate[] = [
  {
    id: "vn-poi-hoan-kiem",
    name: "Hồ Hoàn Kiếm (Hoan Kiem Lake)",
    displayName: "Hồ Hoàn Kiếm, Phường Hàng Trống, Quận Hoàn Kiếm, Hà Nội (Synthetic Test Data)",
    category: "landmark",
    location: { latitude: 21.0285, longitude: 105.8525 },
    isSynthetic: true,
    attribution: "Synthetic Vietnamese POI Fixture",
  },
  {
    id: "vn-poi-lang-bac",
    name: "Quảng trường Ba Đình (Ba Dinh Square)",
    displayName: "Số 2 Hùng Vương, Phường Điện Biên, Quận Ba Đình, Hà Nội (Synthetic Test Data)",
    category: "landmark",
    location: { latitude: 21.0368, longitude: 105.8346 },
    isSynthetic: true,
    attribution: "Synthetic Vietnamese POI Fixture",
  },
  {
    id: "vn-poi-nha-hat-lon-hn",
    name: "Nhà hát Lớn Hà Nội (Hanoi Opera House)",
    displayName: "Số 1 Tràng Tiền, Phường Tràng Tiền, Quận Hoàn Kiếm, Hà Nội (Synthetic Test Data)",
    category: "landmark",
    location: { latitude: 21.0244, longitude: 105.8576 },
    isSynthetic: true,
    attribution: "Synthetic Vietnamese POI Fixture",
  },
  {
    id: "vn-poi-le-loi-hn",
    name: "Phố Lê Lợi (Hà Nội)",
    displayName: "Phố Lê Lợi, Quận Hà Đông, Hà Nội (Synthetic Test Data)",
    category: "street",
    location: { latitude: 20.9718, longitude: 105.7785 },
    isSynthetic: true,
    attribution: "Synthetic Vietnamese POI Fixture",
  },
  {
    id: "vn-poi-le-loi-hcm",
    name: "Đường Lê Lợi (TP.HCM)",
    displayName: "Đường Lê Lợi, Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh (Synthetic Test Data)",
    category: "street",
    location: { latitude: 10.7731, longitude: 106.7003 },
    isSynthetic: true,
    attribution: "Synthetic Vietnamese POI Fixture",
  },
  {
    id: "vn-poi-ben-thanh",
    name: "Chợ Bến Thành (Ben Thanh Market)",
    displayName: "Chợ Bến Thành, Phường Bến Thành, Quận 1, TP. Hồ Chí Minh (Synthetic Test Data)",
    category: "marketplace",
    location: { latitude: 10.7725, longitude: 106.698 },
    isSynthetic: true,
    attribution: "Synthetic Vietnamese POI Fixture",
  },
  {
    id: "vn-poi-cau-rong",
    name: "Cầu Rồng (Dragon Bridge)",
    displayName: "Cầu Rồng, Phường Phước Ninh, Quận Hải Châu, Đà Nẵng (Synthetic Test Data)",
    category: "bridge",
    location: { latitude: 16.0611, longitude: 108.2272 },
    isSynthetic: true,
    attribution: "Synthetic Vietnamese POI Fixture",
  },
];

function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

/**
 * Offline geocoding provider backed by `SYNTHETIC_VN_PLACES`.
 * Supports Vietnamese diacritic-insensitive matching and ambiguous street queries (e.g., "Le Loi").
 */
export class SyntheticVnGeocodingProvider implements GeocodingProvider {
  readonly id = "synthetic-vn-geocoder";
  readonly label = "Offline Synthetic Vietnam Catalog (No Internet Required)";
  readonly isSynthetic = true;
  readonly attribution = "Synthetic test catalog — not live geocoding data";

  constructor(private readonly catalog: readonly GeocodingCandidate[] = SYNTHETIC_VN_PLACES) {}

  async search(query: string, options: GeocodingSearchOptions = {}): Promise<GeocodingCandidate[]> {
    if (options.signal?.aborted) {
      throw new DOMException("Search aborted", "AbortError");
    }
    const q = normalizeText(query);
    if (!q) return [];
    const limit = options.limit ?? 8;
    return this.catalog
      .filter((item) => normalizeText(item.name).includes(q) || normalizeText(item.displayName).includes(q))
      .slice(0, limit);
  }
}

export interface NominatimProviderOptions {
  baseUrl?: string;
  timeoutMs?: number;
  countryCode?: string;
  fetchFn?: typeof fetch;
}

/**
 * OpenStreetMap Nominatim geocoding provider for real place/address lookup in Vietnam.
 * - Enforces a timeout and AbortSignal cancellation.
 * - Requires visible `© OpenStreetMap contributors` attribution.
 * - Subject to OSM Nominatim Usage Policy (max 1 request/sec, interactive user-triggered searches only).
 */
export class NominatimGeocodingProvider implements GeocodingProvider {
  readonly id = "osm-nominatim";
  readonly label = "OpenStreetMap Nominatim (Online)";
  readonly isSynthetic = false;
  readonly attribution = "© OpenStreetMap contributors (ODbL)";

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly countryCode: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: NominatimProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://nominatim.openstreetmap.org").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 6000;
    this.countryCode = options.countryCode ?? "vn";
    this.fetchFn = options.fetchFn ?? ((...args) => fetch(...args));
  }

  async search(query: string, options: GeocodingSearchOptions = {}): Promise<GeocodingCandidate[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const limit = Math.min(10, Math.max(1, options.limit ?? 6));
    const cc = options.countryCode ?? this.countryCode;
    const params = new URLSearchParams({
      q: trimmed,
      format: "jsonv2",
      addressdetails: "1",
      limit: String(limit),
      ...(cc ? { countrycodes: cc } : {}),
    });

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(`${this.baseUrl}/search?${params.toString()}`, {
        method: "GET",
        headers: { Accept: "application/json", "Accept-Language": "vi,en" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Geocoding HTTP ${response.status}`);
      }
      const data: unknown = await response.json();
      if (!Array.isArray(data)) {
        throw new Error("Malformed geocoding response (expected array)");
      }
      const out: GeocodingCandidate[] = [];
      for (const raw of data) {
        if (typeof raw !== "object" || raw === null) continue;
        const item = raw as Record<string, unknown>;
        const lat = Number(item.lat);
        const lon = Number(item.lon);
        const displayName = typeof item.display_name === "string" ? item.display_name.trim() : "";
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180 || !displayName) {
          continue;
        }
        const primary =
          typeof item.name === "string" && item.name.trim().length > 0
            ? item.name.trim()
            : displayName.split(",")[0]!.trim();
        out.push({
          id: `nom-${String(item.place_id ?? `${lat},${lon}`)}`,
          name: primary,
          displayName,
          ...(typeof item.type === "string" ? { category: item.type } : {}),
          location: { latitude: lat, longitude: lon },
          isSynthetic: false,
          attribution: this.attribution,
        });
      }
      return out;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

export interface GooglePlacesProviderOptions {
  /** Proxy endpoint (default `/api/google/places` so private server keys never reach the browser). */
  endpointUrl?: string;
  timeoutMs?: number;
  countryCode?: string;
  fetchFn?: typeof fetch;
}

/**
 * Google Maps Platform Places API (New) Text Search provider (`places:searchText` via `/api/google/places`).
 * - Validates coordinates, place IDs, and display names before returning candidates.
 * - Surfaces quota/billing/HTTP errors explicitly and never falls back to synthetic data silently.
 */
export class GooglePlacesGeocodingProvider implements GeocodingProvider {
  readonly id = "google-places-v1";
  readonly label = "Google Maps Platform — Places API (New)";
  readonly isSynthetic = false;
  readonly attribution = "Google Maps";

  private readonly endpointUrl: string;
  private readonly timeoutMs: number;
  private readonly countryCode: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: GooglePlacesProviderOptions = {}) {
    this.endpointUrl = options.endpointUrl ?? "/api/google/places";
    this.timeoutMs = options.timeoutMs ?? 6000;
    this.countryCode = options.countryCode ?? "VN";
    this.fetchFn = options.fetchFn ?? ((...args) => fetch(...args));
  }

  async search(query: string, options: GeocodingSearchOptions = {}): Promise<GeocodingCandidate[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const limit = Math.min(10, Math.max(1, options.limit ?? 6));
    const regionCode = (options.countryCode ?? this.countryCode).toUpperCase();

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(this.endpointUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          textQuery: trimmed,
          maxResultCount: limit,
          regionCode,
          languageCode: "vi",
        }),
        signal: controller.signal,
      });

      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const msg =
          typeof body === "object" &&
          body !== null &&
          typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : typeof body === "object" &&
                body !== null &&
                typeof (body as { error?: { message?: unknown } }).error?.message === "string"
              ? (body as { error: { message: string } }).error.message
              : `Google Places HTTP ${response.status}`;
        throw new Error(msg);
      }

      if (typeof body !== "object" || body === null) {
        throw new Error("Malformed Google Places response");
      }
      const placesRaw = (body as { places?: unknown }).places;
      if (placesRaw === undefined) {
        return []; // Google Places returns `{}` when zero places match
      }
      if (!Array.isArray(placesRaw)) {
        throw new Error("Malformed Google Places response (expected places array)");
      }

      const out: GeocodingCandidate[] = [];
      for (const raw of placesRaw) {
        if (typeof raw !== "object" || raw === null) continue;
        const item = raw as Record<string, unknown>;
        const loc = item.location as { latitude?: unknown; longitude?: unknown } | undefined;
        const lat = Number(loc?.latitude);
        const lon = Number(loc?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
          continue;
        }
        const displayObj = item.displayName as { text?: unknown } | undefined;
        const primaryName =
          typeof displayObj?.text === "string" && displayObj.text.trim().length > 0
            ? displayObj.text.trim()
            : "";
        const formattedAddress =
          typeof item.formattedAddress === "string" && item.formattedAddress.trim().length > 0
            ? item.formattedAddress.trim()
            : primaryName;
        if (!primaryName && !formattedAddress) continue;

        out.push({
          id: `gplace-${String(item.id ?? `${lat},${lon}`)}`,
          name: primaryName || formattedAddress.split(",")[0]!.trim(),
          displayName: formattedAddress,
          ...(typeof item.primaryType === "string" ? { category: item.primaryType } : {}),
          location: { latitude: lat, longitude: lon },
          isSynthetic: false,
          attribution: this.attribution,
        });
      }
      return out;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
