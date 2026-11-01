# Architecture

## Monorepo (npm workspaces)

```
apps/simulator            React + Vite + SVG browser simulator, destination planner & LAN phone GPS relay
packages/navigation-core  Framework-independent domain logic, validation, fixtures, projection & route progress
docs/                     Architecture, BLE protocol contract, and Vietnam map data guide
```

Why a monorepo: the validation, speed-warning, projection, route-fixture schemas, and turn-by-turn route tracker in `packages/navigation-core` have zero React or DOM dependencies, so they can be unit-tested in isolation and mirrored when building the future iOS and ESP32-S3 phases.

## `packages/navigation-core`

| Module | Responsibility |
|---|---|
| `domain/types.ts` | `NavigationData`, `NavigationPacket`, `TurnDirection` (`LEFT`, `RIGHT`, `STRAIGHT`, `U_TURN`, `ROUNDABOUT`), status enums, `Clock`/`ManualClock` |
| `validation/validateNavigation.ts` | Strict validation of untrusted packets, JSON parsing, sequence gate (`isNewerSequence`) |
| `speed-warning/speedWarning.ts` | Pure `evaluateSpeed()` state machine: threshold, hysteresis, persistence, packet-age staleness |
| `map/projection.ts` | Local flat-earth lat/lon → 240×240 heading-up screen projection |
| `fixtures/routeFixture.ts` | Validated `RouteFixture` schema (`schemaVersion: 1`), step resolution (`resolveStepAtProgress`), and polyline interpolation (`interpolateRoutePosition`) |
| `live/gpsFix.ts` | Validation of real phone GPS fixes (`validateGpsFix`), Haversine distance/bearing, `LiveLatencyMetrics`, and conversion to `NavigationData` (`buildLiveNavigationData`) |
| `routing/routeTracker.ts` | Validated `CalculatedRoute` model, point-to-segment projection (`pointToSegmentDistanceMeters`), compact 64-point geometry, and pure `evaluateRouteProgress()` turn-by-turn engine |

Speed states, highest priority first:
`DISCONNECTED > GPS_LOST > DATA_STALE > NO_SPEED > UNKNOWN_LIMIT > STALE_LIMIT > WARNING / NORMAL`.
Unknown speed limit is always `null`, never guessed or `0`.

## `apps/simulator`

```
SimulatorService (NavigationDataProvider) ──┐
                                            ├── raw JSON ──> useNavigationData ──> NavigationDisplay (240×240 SVG)
LivePhoneProvider (NavigationDataProvider) ─┘
        ▲
        └── CalculatedRoute overlay ── DestinationNavigationPanel + InteractivePlanningMap
                                       (GeocodingProvider + MapRouteProvider)
```

- **Display Components (`NavigationDisplay`, `TurnDisplay`, `MapDisplay`):** Consume only `NavigationData` and optional `BackdropRoad[]`. `MapDisplay` memoizes SVG polyline projections and `useNavigationData` preserves `routePoints` array references across 1 Hz heartbeats when coordinates are unchanged.
- **Destination Search & Planning (`DestinationNavigationPanel`, `InteractivePlanningMap`, `GeocodingProvider`, `MapRouteProvider`):**
  - `GeocodingProvider` (`SyntheticVnGeocodingProvider` offline + `NominatimGeocodingProvider` online) searches places, street addresses, and POIs with disambiguation support.
  - `InteractivePlanningMap` provides a dedicated planning canvas (click-to-set destination, zoom, pan, route overview) separate from the 240×240 motorcycle display.
  - `MapRouteProvider.calculateRoute` (`SyntheticFixtureMapProvider` offline + `OsrmRouteProvider` online) produces validated `CalculatedRoute` objects consumed by `evaluateRouteProgress`.
- **Low-Latency Live Phone GPS (`LivePhoneProvider`, `GpsReporter`, `phone.html`, `relay/`):**
  - Uses `watchPosition({ enableHighAccuracy: true, maximumAge: 0, timeout: 6000 })` with single-watcher lifecycle and a Haversine displacement speed fallback (`speedSource: "derived"`) when iOS Safari reports `coords.speed === null`.
  - WebSocket relay (`/ws`) runs with `perMessageDeflate: false` and `TCP_NODELAY`, stamps `relayReceivedAtMs`, and responds to `{ type: "ping" }` with `{ type: "pong" }`.
  - Latency metrics (`LiveLatencyMetrics`) strictly separate phone clock (`phoneSampleAgeMs`, `phoneProcessingDelayMs`) from PC clock (`relayToSimulatorMs`, `simulatorProcessingMs`, `roundTripPingMs`, `updateFrequencyHz`) to avoid cross-device clock skew errors.
