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
3. **Destination Search, Real Interactive Street Map (Leaflet + OpenStreetMap) & Turn-by-Turn Navigation:**
   - **Destination Search (`GeocodingProvider`):** Search by place name, street address, or POI using `SyntheticVnGeocodingProvider` (offline, diacritic-insensitive, includes disambiguation for duplicate street names like *Lê Lợi* in HCMC vs. Hanoi) or `NominatimGeocodingProvider` (online OpenStreetMap Nominatim). Includes loading, empty, error, and retry states, plus optional destination confirmation before requesting a route.
   - **Real Interactive Street Map (`InteractivePlanningMap` via Leaflet + OpenStreetMap):** Displays real OpenStreetMap street tiles (`https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`, attribution `© OpenStreetMap contributors (ODbL)`), pan/zoom, click/tap-to-select-destination with coordinate validation, `Recenter GPS` and `Fit Route` controls, auto-fit route bounds when a route is calculated, active maneuver highlight, current GPS marker, and destination marker. Updates markers and route polylines imperatively without recreating the Leaflet map instance on 1 Hz GPS ticks.
   - **Route Calculation (`MapRouteProvider.calculateRoute`) & Synchronized HUD Progress (`evaluateRouteProgress`):** Computes validated multi-step routes via `SyntheticFixtureMapProvider` (offline) or `OsrmRouteProvider` (online OSRM), displays distinct next-turn distance vs. total remaining distance, synchronizes the large Leaflet street map with the 240×240 `TURN HUD` and `MAP HUD`, pauses progress when GPS is lost/stale, and triggers automatic rerouting after 3 consecutive off-route GPS fixes without polling on every tick.
4. **Deterministic Vietnamese Scenario Fixtures (Synthetic):**
   - Built-in validated JSON presets in `apps/simulator/src/fixtures/vn/` (`vn-left-right-turns`, `vn-urban-straight`, `vn-roundabout`, `vn-missing-route`, `vn-gps-loss`, `vn-stale-data`, `vn-unknown-speed-limit`) plus custom `.json` fixture upload.
5. **Speed-Warning Engine (`@w-map/navigation-core`):**
   - Priority: `DISCONNECTED > GPS_LOST > DATA_STALE > NO_SPEED > UNKNOWN_LIMIT > STALE_LIMIT > WARNING / NORMAL`.

## Troubleshooting Live iPhone GPS & WebSocket Relay

1. **Stop any existing `npm run dev` server first.** Both the PC simulator and the iPhone must connect to the **same** HTTPS server process (`npm run dev:phone` on port `5173`, enforced with `strictPort: true`). Running `npm run dev` (HTTP) and `npm run dev:phone` (HTTPS) in separate terminals creates separate in-memory relays.
2. Start the single shared HTTPS server on Windows:
   ```powershell
   npm run dev:phone
   ```
   Note the `Network` URL printed by Vite (for example, `https://192.168.1.25:5173/`).
3. Ensure the Windows PC and iPhone are on the **same Wi-Fi network** (disable client isolation / VPNs) and allow port `5173` through Windows Defender Firewall if prompted.
4. On the **Windows PC**, open `https://<PC-LAN-IP>:5173/` (or `https://localhost:5173/` on the same server process), accept the local certificate warning, and click **Live phone GPS**.
5. On the **iPhone in Safari**, open `https://<PC-LAN-IP>:5173/phone.html`, accept the certificate warning, tap **Start sending GPS**, and grant Location permission (**Settings > Privacy & Security > Location Services > Safari Websites > While Using the App**, with **Precise Location: ON**).
6. Inspect the **Latency & Telemetry Diagnostics** card on the PC and the status line on the iPhone:
   - `HEALTHY_LIVE_GPS`: Phone is registered on the relay (`phones on relay: 1`), iPhone shows `State: Sending GPS` and `1 PC display linked`, and `Fixes accepted` increments on every GPS update.
   - `PHONE_ABSENT_FROM_RELAY`: PC display WebSocket is open, but `0` phones are connected to this relay instance. Check that the iPhone opened `/phone.html` on the exact same `https://<PC-LAN-IP>:5173` server and tapped **Start sending GPS**.
   - `TRANSPORT_CONNECTED_NO_GPS`: Phone is connected to the relay, waiting for iOS Safari to deliver its first GPS fix.
   - `GPS_DATA_STALE`: No fresh GPS fix within `3000 ms` (or accuracy > `100 m`). Move outdoors with a clear sky view.
