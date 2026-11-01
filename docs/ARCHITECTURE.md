# Architecture

## Monorepo (npm workspaces)

```
apps/simulator            React + Vite + SVG browser simulator (Phase 1)
packages/navigation-core  Framework-independent domain logic (Phase 1–3 core)
docs/                     BLE protocol and architecture
```

Why a monorepo: the same validation and speed-warning code must later be mirrored by iOS/firmware, and keeping it in a UI-free package enforces the separation (the package has no React dependency). `ios/` and `firmware/` are intentionally absent until their interfaces are implemented (Phases 5–6).

## navigation-core

| Module | Responsibility |
|---|---|
| `domain/types.ts` | `NavigationData`, `NavigationPacket`, enums, `Clock`/`ManualClock` |
| `validation/` | Strict validation of untrusted packets, JSON parsing, sequence gate |
| `speed-warning/` | Pure `evaluateSpeed()` state machine: threshold, hysteresis, persistence, staleness; time injected |
| `map/projection.ts` | lat/lon → 240×240 heading-up projection (provider-independent) |

Speed states, highest priority first: `DISCONNECTED > GPS_LOST > DATA_STALE > NO_SPEED > UNKNOWN_LIMIT > STALE_LIMIT > WARNING/NORMAL`. Unknown limit = `null`, never guessed or `0`.

## simulator

```
SimulatorService (NavigationDataProvider) --raw JSON--> useNavigationData
   (validate, drop old/duplicate sequences) --NavigationData--> NavigationDisplay (SVG)
SimulatorPanel --controls--> SimulatorService
```

- Display components depend only on `NavigationData`, never on the simulator.
- A future BLE provider implements `NavigationDataProvider` and emits the same raw packets.
- `fixtures/demoRoute.ts` holds deterministic **simulated** coordinates (arbitrary test values, not a real road network).
- A 1 s heartbeat keeps simulated "live" packets fresh; tests disable timers and use `ManualClock`.

## Not in Phase 1 (documented, not implemented)

Real map/routing providers (OSM/OSRM etc.), speed-limit data sources, the iOS app, ESP32 firmware, hardware notes. Nothing in the simulator performs network requests.
