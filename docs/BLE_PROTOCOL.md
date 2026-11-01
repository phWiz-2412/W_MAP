# BLE Protocol Specification (DRAFT v1 – Design & Integration Contract)

> **Status:** **Designed, not implemented in firmware/iOS, not tested on physical BLE hardware.**
> Currently, `@w-map/navigation-core` implements and tests the **JSON packet envelope** (`NavigationPacket`, `version: 1`) and validation rules. The compact binary frame below is the target contract for the future iPhone + ESP32-S3 phase.
> All UUIDs below are **project-defined placeholders for W_MAP**; they are not taken from, and make no claim of compatibility with, SteedPilot, MotoNav, or any Bluetooth SIG standard profile.

---

## 1. GATT Service & Characteristics

| Item | UUID (Project-Defined Placeholder) | Properties | Direction |
|---|---|---|---|
| W_MAP Navigation Service | `7f3a0000-0000-4d41-5057-4d4150000001` | – | ESP32-S3 is the GATT peripheral/server |
| Navigation Data Characteristic | `7f3a0001-0000-4d41-5057-4d4150000001` | Write Without Response | iPhone → ESP32-S3 |
| Route Geometry Characteristic | `7f3a0002-0000-4d41-5057-4d4150000001` | Write (with response / chunked) | iPhone → ESP32-S3 |
| Device Status Characteristic | `7f3a0003-0000-4d41-5057-4d4150000001` | Read, Notify | ESP32-S3 → iPhone |

---

## 2. Implemented Simulator Contract (JSON Form)

Validated in `packages/navigation-core/src/validation/validateNavigation.ts` (`validateNavigationPacket`, `parseNavigationPacketJson`).

```json
{
  "version": 1,
  "data": {
    "sequenceNumber": 42,
    "timestamp": 1730430000000,
    "currentSpeedKmh": 45,
    "speedLimitKmh": 50,
    "turnDirection": "ROUNDABOUT",
    "distanceToTurnMeters": 180,
    "latitude": 10.772,
    "longitude": 106.698,
    "headingDegrees": 45,
    "gpsStatus": "ACTIVE",
    "bleStatus": "CONNECTED",
    "routeStatus": "ACTIVE",
    "speedLimitStatus": "VALID",
    "routePoints": [
      { "latitude": 10.7705, "longitude": 106.698 },
      { "latitude": 10.772, "longitude": 106.698 }
    ]
  }
}
```

### Enforced Validation Rules (`navigation-core`)
- `version`: must equal `1` (`PROTOCOL_VERSION`).
- `sequenceNumber`: non-negative integer (`0, 1, 2, ...`).
- `timestamp`: non-negative finite number (ms).
- `currentSpeedKmh`: `null` or `0..300`.
- `speedLimitKmh`: `null` or `(0..200]`. **Never `0`** (`0` is rejected so an unknown limit is never encoded as zero).
- `speedLimitStatus`: `"VALID" | "UNKNOWN" | "STALE"`.
  - `"UNKNOWN"` requires `speedLimitKmh === null`.
  - `"VALID"` and `"STALE"` require a non-null `speedLimitKmh`.
- `turnDirection`: `"LEFT" | "RIGHT" | "STRAIGHT" | "U_TURN" | "ROUNDABOUT"`.
- `distanceToTurnMeters`: `null` or `0..100000`.
- `latitude` / `longitude`: both `null` or both valid (`-90..90`, `-180..180`).
- `headingDegrees`: `null` or `[0, 360)`.
- `routePoints`: array of `0..64` valid `{ latitude, longitude }` points (`MAX_ROUTE_POINTS = 64`).

---

## 3. Proposed Binary Frame Contract (Future Hardware Phase)

### A. Navigation Telemetry Frame (24 bytes, Little-Endian)

Sent on the Navigation Data Characteristic at 1–2 Hz (and immediately on maneuver changes).

| Byte Offset | Type | Field | Encoding & Sentinel Rules |
|---|---|---|---|
| 0 | `u8` | `version` | `1` |
| 1 | `u8` | `flags` | `bit0`: `gpsStatus == ACTIVE`<br>`bit1`: `routeStatus == ACTIVE`<br>`bits2..3`: `speedLimitStatus` (`0` = UNKNOWN, `1` = VALID, `2` = STALE) |
| 2 | `u16` | `sequenceNumber` | Monotonic counter (`0..65535`) |
| 4 | `u32` | `timestampMs` | Sender monotonic/epoch ms (low 32 bits) |
| 8 | `u16` | `currentSpeedKmh` | `0..300` km/h; `0xFFFF` = `null` (fits `MAX_SPEED_KMH = 300` without `u8` overflow) |
| 10 | `u8` | `speedLimitKmh` | `1..200` km/h; `0` = `null` (`UNKNOWN`) |
| 11 | `u8` | `turnDirection` | `0` = LEFT, `1` = RIGHT, `2` = STRAIGHT, `3` = U_TURN, `4` = ROUNDABOUT |
| 12 | `u32` | `distanceToTurnMeters` | `0..100000` m; `0xFFFFFFFF` = `null` (fits `MAX_DISTANCE_METERS = 100000` without `u16` truncation at 65,535 m) |
| 16 | `u16` | `headingDeciDeg` | `0..3599` (`0.1°` units); `0xFFFF` = `null` |
| 18 | `i16` | `reserved` | `0` |
| 20 | `i32` | `latitudeE6` / `longitudeE6` | See note below on 28-byte vs 24-byte layout |

> **Protocol Review Note (Packet Size vs. Coordinate Precision):**
> Including full `i32` latitude (`1e-6°`) and `i32` longitude (`1e-6°`) alongside `u16` speed (`0..300`) and `u32` distance (`0..100,000`) requires **26 bytes** total (Offsets 0..17 above + 4 bytes lat + 4 bytes lon):
> - Offset 18..21: `i32 latitudeE6` (`INT32_MIN` = `null`)
> - Offset 22..25: `i32 longitudeE6` (`INT32_MIN` = `null`)
>
> **MTU Requirement:** Default BLE ATT MTU (23 bytes) allows only 20 bytes of unfragmented payload. During BLE connection setup, the iPhone and ESP32-S3 **must** negotiate an ATT MTU ≥ 64 bytes (iOS CoreBluetooth typically negotiates 185+ bytes automatically). Firmware must reject any write shorter than 26 bytes.

### B. Route Geometry Chunking
- Up to `MAX_ROUTE_POINTS` (64 points × 8 bytes = 512 bytes) cannot fit in a single GATT write under typical MTUs.
- Route geometry will use the separate Route Geometry Characteristic (`7f3a0002-...`), sending a compact header (`u8 version`, `u16 routeId`, `u8 chunkIndex`, `u8 totalChunks`, `u8 pointCount`) followed by `(latE6, lonE6)` pairs only when the active route changes or advances.

---

## 4. Sequence Numbers, Timestamps, and Reconnection

1. **Sequence Gate:**
   - Currently implemented in `isNewerSequence(lastAccepted, candidate)` (`lastAccepted === null || candidate > lastAccepted`).
   - Duplicate or out-of-order packets (`candidate <= lastAccepted`) are dropped and counted (`droppedStaleCount`).
2. **Freshness & Stale Detection:**
   - `evaluateSpeed` compares `packetAgeMs = nowMs - data.timestamp` against `maxPacketAgeMs` (default `3000` ms).
   - If `packetAgeMs > 3000`, the display enters `DATA_STALE` (`"DATA STALE - NOT LIVE"`), dims guidance, and suppresses speed warnings.
   - In `LivePhoneProvider`, receiver-side arrival time (`fixReceivedAtMs`) is used so clock skew between the phone and PC cannot mask a stalled GPS feed.
3. **Reconnection & Sequence Reset:**
   - In `useNavigationData`, re-subscribing to a provider resets `lastSequence = null`.
   - On future BLE hardware, when the GATT link disconnects (`DISCONNECTED`) and reconnects, the firmware must reset its sequence gate and display `DISCONNECTED` until the first fresh valid packet arrives.
