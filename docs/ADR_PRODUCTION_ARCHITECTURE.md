# Architecture Decision Record: Transition to Production Motorcycle Navigation System

- **Status:** Accepted & Implemented (Core Protocol, Google Maps Providers, Firmware & iOS Modules)
- **Target Branch:** `main`
- **Date:** 2026-11-01

---

## 1. Context & Baseline Audit

W_MAP began as a TypeScript monorepo (`@w-map/navigation-core` + `@w-map/simulator`) with a 240 × 240 cockpit HUD (`TURN HUD` and `MAP HUD`), real iPhone Safari GPS streaming over a LAN WebSocket relay (`/ws`), interactive Leaflet/OpenStreetMap route planning, and 179 automated tests.

To operate as a practical long-distance motorcycle navigation companion in Vietnam, the system must transition from a browser-tab prototype to a 3-tier hardware/software architecture:

1. **iPhone Navigation Application (`ios/WMap/`)** — The navigation computer and single source of truth (Core Location GPS, pre-trip destination search, Google Maps Platform / OSRM route calculation, turn-by-turn progress tracking, and CoreBluetooth Central).
2. **BLE GATT Binary Protocol (`packages/navigation-core/src/ble/bleProtocol.ts` + `docs/BLE_PROTOCOL.md`)** — A deterministic, CRC-16-protected 38-byte binary telemetry frame with session IDs, monotonic sequence numbers, explicit sentinel values for unknown fields, and a latest-state coalescing transmission policy.
3. **ESP32-S3 Handlebar Display Firmware (`firmware/esp32s3/`)** — A low-latency BLE GATT Peripheral with a lock-free frame inbox, sequence/freshness validation, dirty-flag HUD rendering, and automotive 12V→5V power protection requirements.
4. **Windows Simulator (`apps/simulator/`)** — Retained as a deterministic development, protocol-verification, and hardware-in-the-loop testing environment.

---

## 2. Key Architectural Decisions

### ADR-01: Phone as the Sole Source of Navigation Truth
- **Decision:** All geocoding, route calculation, polyline projection, off-route detection, and ETA estimation execute on the iPhone. The ESP32-S3 never connects to Wi-Fi/cellular or queries external map APIs.
- **Rationale:** Keeps ESP32-S3 power consumption, RAM footprint, and firmware complexity minimal and deterministic while leveraging the iPhone's 5G modem and GNSS hardware.

### ADR-02: 38-Byte Binary BLE Telemetry Frame over JSON on GATT
- **Decision:** Use a fixed 38-byte Little-Endian binary frame (`WMAP_BLE_TELEMETRY_FRAME_BYTES = 38`) with a trailing `CRC-16/CCITT-FALSE` checksum on Characteristic `7f3a0001-0000-4d41-5057-4d4150000001` (`Write Without Response`).
- **Comparison (Binary vs. JSON):**
  - JSON (`NavigationPacket`) averages `320–550 bytes` per update, requiring multi-packet ATT fragmentation even with an MTU of 185 bytes and dynamic heap parsing on the microcontroller.
  - The 38-byte binary frame fits in a single unfragmented write whenever `ATT_MTU >= 41` (iOS negotiates `185+` bytes automatically), parses in $O(1)$ with zero heap allocations on ESP32-S3, and is verified across TypeScript, Swift, and C++ using shared golden hex vectors (`BLE_GOLDEN_VECTORS`).

### ADR-03: Server-Side Proxy for Google Maps Platform Web/Simulator Requests
- **Decision:** Browser simulator requests to Google Places API (New) and Google Routes API v2 go through `/api/google/places` and `/api/google/routes` (`apps/simulator/relay/googleMapsProxy.ts`), which injects `GOOGLE_MAPS_SERVER_API_KEY` on the Node.js backend.
- **Rationale:** Prevents exposing private server API keys in client-side JavaScript bundles or Git history. Native iOS builds use a separate iOS-restricted API key bound to the app's Bundle ID.

### ADR-04: Honest Handling of Vietnam Motorcycle Routing & Speed Limits
- **Decision:** Expose genuinely supported route modifiers (`avoidHighways`, `avoidTolls`, `avoidFerries`, and `travelMode: "TWO_WHEELER" | "DRIVE"`), never claim a generic "avoid car lanes" API capability exists, never silently fall back to synthetic routes on API failure, and keep unverified speed limits explicitly `UNKNOWN` (`null` / `--`).
