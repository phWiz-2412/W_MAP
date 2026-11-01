# Map & Routing Integration Guide (Vietnam Evaluation)

> **Current Status:** W_MAP includes both **synthetic offline providers** (`SyntheticVnGeocodingProvider` + `SyntheticFixtureMapProvider`, default for deterministic testing with zero network calls) and **optional online OpenStreetMap providers** (`NominatimGeocodingProvider` + `OsrmRouteProvider`) behind strict provider interfaces.

This document defines the architecture, data contracts, and legal/technical constraints for geocoding, route calculation, and turn-by-turn navigation in Vietnam.

---

## 1. Provider Architecture & Separation of Concerns

To keep the 240 × 240 display and `navigation-core` domain independent of specific map vendors:

- **`packages/navigation-core`**:
  - Defines pure data structures (`RoutePoint`, `BackdropRoad`, `RouteFixture`, `CalculatedRoute`, `RouteStepModel`, `NavigationData`), local coordinate projection (`projectPoint`, `projectPolyline` in `src/map/projection.ts`), and pure turn-by-turn route tracking (`evaluateRouteProgress` in `src/routing/routeTracker.ts`).
  - Contains **zero** HTTP clients or vendor-specific parsers.
- **`apps/simulator/src/services/GeocodingProvider.ts`**:
  - Defines `GeocodingProvider` (`search(query, options): Promise<GeocodingCandidate[]>`).
  - Implemented offline by `SyntheticVnGeocodingProvider` (Vietnamese POI & address catalog with diacritic-insensitive matching and ambiguous street disambiguation) and online by `NominatimGeocodingProvider` (OSM Nominatim).
- **`apps/simulator/src/services/MapRouteProvider.ts`**:
  - Defines `MapRouteProvider` (`fetchRoute(query)` for fixtures and `calculateRoute(query): Promise<CalculatedRoute>` for origin→destination routing).
  - Implemented offline by `SyntheticFixtureMapProvider` and online by `OsrmRouteProvider` (`parseOsrmRouteResponse`, `parseOsrmManeuver`).
- **Display Components (`NavigationDisplay`, `MapDisplay`, `TurnDisplay`)**:
  - Consume only validated `NavigationData` and projected `BackdropRoad` polylines. Interactive destination picking and route overview live in `InteractivePlanningMap` and `DestinationNavigationPanel`.

---

## 2. Turn-by-Turn Route Progress & Rerouting (`routeTracker.ts`)

`evaluateRouteProgress(route, position, state, config)` in `@w-map/navigation-core` updates navigation state on each GPS sample without querying any external routing server:

1. **Nearest-Segment Projection:** Projects the current WGS84 position onto each segment of `route.routePoints` (`pointToSegmentDistanceMeters`) to determine distance from the route polyline and distance along the route.
2. **Step Progression:** Advances `activeStepIndex` monotonically (with small backtrack tolerance) and computes remaining distance to the next maneuver (`distanceToTurnMeters`), `nextTurn`, and `headingDegrees`.
3. **GPS Loss Guard:** When `gpsStatus !== "ACTIVE"` or coordinates are missing, route progression and off-route counters pause immediately so stale or invalid fixes never trigger false arrivals or reroutes.
4. **Off-Route Detection & Rerouting:** Requires `offRouteConsecutiveSamples` (default `3`) consecutive GPS fixes exceeding `offRouteThresholdMeters` (default `45 m`) before setting `isOffRoute: true` and requesting a single recalculation from `MapRouteProvider.calculateRoute`.
5. **Arrival Detection:** Requires `arrivalConsecutiveSamples` (default `2`) consecutive fixes within `arrivalThresholdMeters` (default `25 m`) of the final route vertex before transitioning `routeStatus` to `"ARRIVED"`.

---

## 3. Evaluating OpenStreetMap & Routing Services for Vietnam

### A. Road Geometry & Map Data (OpenStreetMap Vietnam)
- **Coverage in Vietnam:** Major cities (Hanoi, Ho Chi Minh City, Da Nang, Hai Phong, Can Tho) and national highways (`Quốc lộ`, `Tỉnh lộ`) have strong geometry coverage, including roundabouts (`junction=roundabout`), one-way streets, and alleys (`ngõ` / `hẻm`).
- **Two-Wheeler Constraints:** In Vietnam, motorbikes are prohibited on most expressways (`Cao tốc`, e.g., `motorroad=yes` or `motorcycle=no`). Any production routing profile used for W_MAP **must** filter out expressways and roads tagged `motorcycle=no` or `access=no`.

### B. Routing Engines (OSRM, Valhalla, GraphHopper)
- **OSRM (`OsrmRouteProvider`):**
  - Requests `steps=true&geometries=geojson&overview=full` and maps maneuvers (`turn`, `roundabout`, `rotary`, `uturn`, `continue`, `arrive`) into `TurnDirection`.
  - **Crucial Limitation — Speed Limits:** Standard OSRM responses provide duration/distance estimates and step instructions, **not** verified legal speed limits. `OsrmRouteProvider` always sets `speedLimitKmh: null` and `speedLimitStatus: "UNKNOWN"`.

---

## 4. Attribution, API Usage Limits, and Licensing Obligations

1. **OpenStreetMap Licensing (ODbL):**
   - Map data derived from OpenStreetMap is licensed under the **Open Data Commons Open Database License (ODbL)**.
   - When using `NominatimGeocodingProvider` or `OsrmRouteProvider`, the UI visibly displays `© OpenStreetMap contributors (ODbL)`.
2. **Public Demo Server Restrictions:**
   - The public OSRM demo server (`router.project-osrm.org`) and OSM Nominatim (`nominatim.openstreetmap.org`) are strictly for low-volume testing/demos.
   - W_MAP calculates a route **once** when the user clicks **Calculate Route** (or once upon confirmed 3-sample off-route deviation) and never polls routing servers on routine GPS ticks.
3. **Offline Limitations:**
   - The ESP32-S3 display has no internet connection and limited RAM; it only renders simplified local vector coordinates (`compactRouteGeometry`, up to 64 points) transmitted over BLE.
