# W_MAP – Motorcycle Navigation Companion

DIY motorcycle navigation system: iPhone (navigation computer) → BLE → ESP32-S3 240×240 display. **Phase 1 (this repo state): Windows browser simulator + `navigation-core` package.** iOS app and firmware are future phases.

> **Safety:** This is an auxiliary display *simulation*, not a certified instrument. All speed limits, GPS, routes and maps shown are **simulated** and are not a substitute for road signs. Do not use a phone or the simulator while riding.

## Run on Windows

Requires Node.js 20+ and npm. No hardware, paid service or network access at runtime.

```powershell
npm install
npm run dev        # simulator at http://localhost:5173
npm run typecheck  # strict TypeScript, both workspaces
npm test           # Vitest, both workspaces
npm run build      # typecheck + production build (apps/simulator/dist)
```

## Layout

```
apps/simulator/            React + Vite + SVG simulator (src/, tests/)
packages/navigation-core/  types, validation, speed-warning engine, map projection (src/, tests/)
docs/ARCHITECTURE.md       module overview
docs/BLE_PROTOCOL.md       draft BLE GATT protocol (design only)
```

## Using the simulator

Left: device preview (240×240 logical SVG, always square). Right: controls for mode (TURN/MAP), speed, speed limit (incl. unknown), warning threshold, turn direction, distance, navigation active/inactive, route geometry availability, heading, map position along a demo route, GPS status, simulated BLE connection, speed-limit data freshness, packet freshness, automatic speed and reset. Every control updates the display immediately.

State indicators on the display: `WITHIN LIMIT`, `SLOW DOWN` (warning), `LIMIT UNKNOWN` (`--`), `LIMIT DATA OLD` (dashed amber, "OLD"), `DATA STALE`, `GPS LOST`, `SIM BLE DISCONNECTED`, `NO NAVIGATION DATA`.

## Behavior rules

- Warning when speed > limit + threshold (default +5 km/h) for ≥ 800 ms; clears at ≤ limit + threshold − 3 km/h (hysteresis).
- Unknown limit is `null` – never guessed, never 0, never warns. Stale limit never warns and is never shown as verified.
- GPS loss, stale packets and BLE disconnection suppress warnings and are shown explicitly.
- Invalid packets (bad coordinates, negative distance/speed, bad heading/enums, wrong version, malformed JSON) are rejected and counted; older/duplicate sequence numbers are dropped.

## Simulated vs real

| Real (implemented) | Simulated |
|---|---|
| Data model, validation, sequence filter, speed-warning engine, lat/lon projection, SVG UI, tests | GPS, speed, speed limits, route and map geometry, BLE link status |

## Known limitations / next (Phase 2+)

- Sequence gate accepts only strictly increasing numbers; a device reboot restarting at 0 needs a gate reset on reconnect (documented in the protocol).
- Map backdrop and route are fictional fixtures. Phase 4 adds a map-provider interface (OSM/OSRM evaluation, attribution and usage-policy docs).
- No binary BLE codec yet (specified in `docs/BLE_PROTOCOL.md`). iOS app (Phase 5) and ESP32 firmware (Phase 6) not started; hardware notes are written when the board is chosen.
- Visual layout verified via tests/build, not by on-device testing.
