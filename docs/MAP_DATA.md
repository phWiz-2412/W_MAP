# Map, Geocoding & Google Maps Platform Integration Guide (Vietnam)

This document details the verified capabilities, regional limitations, route preferences, and API security configuration for **Google Maps Platform** and **OpenStreetMap / OSRM** in W_MAP.

---

## 1. Implemented Providers

| Layer | Google Maps Platform (Real Online) | OpenStreetMap (Real Online) | Synthetic Offline (Test / Demo) |
|---|---|---|---|
| **Geocoding (`GeocodingProvider`)** | [`GooglePlacesGeocodingProvider`](file:///f:/W_MAP/apps/simulator/src/services/GeocodingProvider.ts) (`POST /api/google/places` → `places.googleapis.com/v1/places:searchText`) | [`NominatimGeocodingProvider`](file:///f:/W_MAP/apps/simulator/src/services/GeocodingProvider.ts) (`nominatim.openstreetmap.org/search`) | [`SyntheticVnGeocodingProvider`](file:///f:/W_MAP/apps/simulator/src/services/GeocodingProvider.ts) |
| **Routing (`MapRouteProvider`)** | [`GoogleRoutesProvider`](file:///f:/W_MAP/apps/simulator/src/services/MapRouteProvider.ts) (`POST /api/google/routes` → `routes.googleapis.com/directions/v2:computeRoutes`) | [`OsrmRouteProvider`](file:///f:/W_MAP/apps/simulator/src/services/MapRouteProvider.ts) (`router.project-osrm.org/route/v1/driving`) | [`SyntheticFixtureMapProvider`](file:///f:/W_MAP/apps/simulator/src/services/MapRouteProvider.ts) |

> **Strict Non-Fallback Policy:** When a real provider (`GoogleRoutesProvider` or `OsrmRouteProvider`) fails due to network loss, invalid key, or quota exhaustion, W_MAP surfaces an explicit `ERROR` state and **never** silently substitutes a synthetic route.

---

## 2. Verified Google Maps Platform Capabilities & Vietnam Limitations

### Supported Features (`Routes API v2` & `Places API (New)`)
- **Places Text Search (`places:searchText`):** Supports Vietnamese diacritics, street addresses, landmarks, and `regionCode: "VN"`, `languageCode: "vi"`.
- **Routes Computation (`directions/v2:computeRoutes`):**
  - Returns encoded polyline (`routes.polyline.encodedPolyline`), total distance (`distanceMeters`), duration (`duration`), and ordered turn-by-turn steps (`legs.steps.navigationInstruction`, `distanceMeters`, `staticDuration`, `startLocation`, `endLocation`).
  - Supports `travelMode: "TWO_WHEELER" | "DRIVE"` and `routeModifiers`:
    - `avoidHighways: boolean`
    - `avoidTolls: boolean`
    - `avoidFerries: boolean`

### Critical Regional & Motorcycle Limitations in Vietnam
1. **No "Avoid Car-Only Lanes" API Modifier:**
   - Neither Google Routes API v2 nor OSRM provides a parameter to avoid car-only lanes on mixed Vietnamese urban arterials (such as parallel car/motorcycle carriageways on `Phạm Văn Đồng`, `Võ Văn Kiệt`, or `Quốc lộ 1A`).
2. **Expressways (`Cao tốc`):**
   - In Vietnam, motorcycles are prohibited on expressways (`Đường cao tốc`). Riders should keep **`Avoid highways / expressways (Cao tốc)` (`avoidHighways: true`)** enabled and must always obey physical road signs (`Biển báo cấm mô tô / xe máy`).
3. **Speed Limits:**
   - Standard Google Routes API v2 and OSRM responses do not provide verified legal motorcycle speed limits in Vietnam. All route steps set `speedLimitKmh: null` and `speedLimitStatus: "UNKNOWN"`.

---

## 3. API Key Setup, Restrictions, Billing & Security

1. **Enable APIs in Google Cloud Console:**
   - Enable **Places API (New)** and **Routes API** on a billed Google Cloud project.
2. **Create Restricted Keys:**
   - **Server Proxy Key (`GOOGLE_MAPS_SERVER_API_KEY`):**
     - Application restriction: **IP addresses** (restrict to your server/development IP).
     - API restriction: Restrict strictly to **Places API (New)** and **Routes API**.
   - **Native iOS Key (when building `ios/WMap` on macOS):**
     - Application restriction: **iOS apps** (restrict to your bundle identifier, e.g. `com.wmap.companion`).
     - API restriction: Restrict to **Places API (New)**, **Routes API**, and **Maps SDK for iOS**.
3. **Configure Local `.env` (Git-Ignored):**
   - Copy [`.env.example`](file:///f:/W_MAP/.env.example) to `.env` in the repository root:
     ```ini
     GOOGLE_MAPS_SERVER_API_KEY=your_restricted_server_key
     ```
   - `.env` is excluded by [`.gitignore`](file:///f:/W_MAP/.gitignore) and is read only by the server-side middleware in [`apps/simulator/relay/googleMapsProxy.ts`](file:///f:/W_MAP/apps/simulator/relay/googleMapsProxy.ts).
