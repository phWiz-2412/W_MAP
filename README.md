# W_MAP – Motorcycle Navigation Companion

DIY motorcycle navigation system inspired by compact handlebar displays: iPhone (navigation computer) → BLE → ESP32-S3 240×240 display.

**Current repository state:** Windows browser simulator (`apps/simulator`) + UI-independent core library (`packages/navigation-core`). Includes low-latency live iPhone Safari GPS over LAN WebSocket, destination search, interactive route planning map, and turn-by-turn navigation progress tracking. No native iOS app or ESP32 firmware is implemented yet.

> **Safety & Honesty Disclaimer:** This is an auxiliary display *simulator*, not a certified vehicle instrument. Built-in Vietnamese road scenarios, synthetic offline routes, speed limits, and BLE states are **synthetic test data** unless explicitly switched to Live Phone GPS (`LivePhoneProvider`) or Online OSM/OSRM mode (`NominatimGeocodingProvider` + `OsrmRouteProvider`). Unverified routing steps always leave speed limits explicitly `UNKNOWN` (`null`). Never interact with a phone or this simulator while riding.

## Run on Windows

Requires Node.js 20+ and npm. Runs locally without hardware, paid APIs, or cloud services.

```powershell
npm install
npm run dev        # simulator at http://localhost:5173
npm run dev:phone  # HTTPS dev server for testing live iPhone Safari GPS over LAN WiFi
npm run typecheck  # strict TypeScript check across workspaces
npm test           # Vitest unit & component tests across workspaces
npm run build      # typecheck + production bundle into apps/simulator/dist
```

## Project Layout

```
apps/simulator/
  src/
    components/    240×240 SVG display (TURN & MAP modes), DestinationNavigationPanel, InteractivePlanningMap
    fixtures/      Built-in synthetic Vietnamese route fixtures (vn/*.json) & loader
    hooks/         useNavigationData (packet validation, sequence filtering & reference preservation)
    phone/         Mobile web page (phone.html) & GpsReporter for streaming real iPhone Safari GPS
    services/      SimulatorService, LivePhoneProvider, MapRouteProvider (Synthetic & OSRM), GeocodingProvider
  relay/           Low-latency Vite WebSocket relay (/ws, perMessageDeflate: false, TCP_NODELAY, ping/pong)
  tests/           React Testing Library + Vitest suite
packages/navigation-core/
  src/
    domain/        NavigationData, NavigationPacket, TurnDirection (incl. ROUNDABOUT), Clock
    validation/    Strict packet validation & sequence gate
    speed-warning/ Deterministic speed-warning engine (threshold, hysteresis, persistence)
    map/           Heading-up lat/lon -> 240×240 projection
    fixtures/      RouteFixture schema validation, step resolution & route interpolation
    live/          Browser GPS fix validation, Haversine helpers, LiveLatencyMetrics & conversion
    routing/       CalculatedRoute validation, point-to-segment projection & evaluateRouteProgress engine
  tests/           Unit tests for validation, speed warnings, projection, fixtures, live GPS & route tracker
docs/
  ARCHITECTURE.md  Module boundaries, live GPS latency diagnostics, and data flow
  BLE_PROTOCOL.md  Draft v1 GATT protocol & binary/JSON packet contracts
  MAP_DATA.md      Geocoding/routing provider contracts & OpenStreetMap Vietnam evaluation
```

## Implemented Features

1. **240×240 Square SVG Display (`TURN` and `MAP` modes):**
   - `TURN` mode: large speed readout, speed-limit sign (`VALID`, `STALE` with dashed amber ring + `OLD` tag, `UNKNOWN` as `--`), state banner, maneuver arrow (`LEFT`, `RIGHT`, `STRAIGHT`, `U_TURN`, `ROUNDABOUT`), distance to turn, and navigation status.
   - `MAP` mode: memoized heading-up projected route polyline, context roads, current-position marker, rotating north indicator, explicit `ROUTE UNAVAILABLE` / `NO POSITION` states.
2. **Low-Latency Live Phone GPS (`LivePhoneProvider` + `/phone.html`):**
   - Streams real GPS fixes from iPhone Safari to the PC simulator over a local WebSocket relay (`/ws` with `perMessageDeflate: false` and `TCP_NODELAY`).
   - **Displacement Speed Fallback:** When iOS Safari reports `coords.speed === null` during low-speed starts, `GpsReporter` derives speed (`speedSource: "derived"`) and heading from consecutive high-accuracy fixes with jitter filtering.
   - **Session-Safe Sequence Filtering:** Tracks `phoneSessionId` and `phoneSeq` so restarting GPS on the phone cleanly resets sequence validation without dropping fixes.
   - **Clock-Domain-Separated Latency Telemetry:** Displays phone sample age, phone JS delay, relay→simulator transit, simulator processing, WebSocket ping RTT, update frequency (Hz), and GPS accuracy.
3. **Destination Search, Interactive Planning Map & Turn-by-Turn Navigation:**
   - **Destination Search (`GeocodingProvider`):** Search by place name, street address, or POI using `SyntheticVnGeocodingProvider` (offline, diacritic-insensitive, includes disambiguation for duplicate street names like *Lê Lợi* in HCMC vs. Hanoi) or `NominatimGeocodingProvider` (online OpenStreetMap Nominatim).
   - **Interactive Planning Map (`InteractivePlanningMap`):** Separate from the 240×240 device screen; supports click-to-set-destination, zoom (`+`/`-`/`Fit`), pan, origin/current/destination markers, and route overview.
   - **Route Calculation (`MapRouteProvider.calculateRoute`) & Live Progress (`evaluateRouteProgress`):** Computes validated multi-step routes via `SyntheticFixtureMapProvider` (offline) or `OsrmRouteProvider` (online OSRM), tracks active step and remaining turn distance from live or simulated GPS, pauses progress when GPS is lost, and triggers automatic rerouting after 3 consecutive off-route GPS fixes without polling on every tick.
4. **Deterministic Vietnamese Scenario Fixtures (Synthetic):**
   - Built-in validated JSON presets in `apps/simulator/src/fixtures/vn/` (`vn-left-right-turns`, `vn-urban-straight`, `vn-roundabout`, `vn-missing-route`, `vn-gps-loss`, `vn-stale-data`, `vn-unknown-speed-limit`) plus custom `.json` fixture upload.
5. **Speed-Warning Engine (`@w-map/navigation-core`):**
   - Priority: `DISCONNECTED > GPS_LOST > DATA_STALE > NO_SPEED > UNKNOWN_LIMIT > STALE_LIMIT > WARNING / NORMAL`.

## Troubleshooting Live iPhone GPS & WebSocket Relay

1. Start the HTTPS server on Windows: `npm run dev:phone`.
2. Ensure the Windows PC and iPhone are on the **same Wi-Fi network** (disable client isolation / VPNs) and allow port `5173` through Windows Defender Firewall if prompted.
3. Open `https://<PC-LAN-IP>:5173/phone.html` in **iPhone Safari**, accept the self-signed local certificate warning, tap **Start sending GPS**, and grant Location permission (**Precise Location: ON**).
4. On the PC simulator (`https://localhost:5173`), switch the top toggle to **Live Phone GPS (iPhone)**.
5. Inspect the **Latency & Telemetry Diagnostics** card:
   - If **Ping RTT** is high (>100 ms), check Wi-Fi signal strength.
   - If **Speed source** reads `derived (Δpos/Δt)`, iOS Safari returned `coords.speed = null` and W_MAP computed speed from consecutive coordinates.
   - If `GPS LOST (accuracy Xm > 100m)` appears indoors, test outdoors with a clear sky view so GPS accuracy drops below 35–100 m.
