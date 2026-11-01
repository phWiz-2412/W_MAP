# W_MAP ESP32-S3 Firmware (`firmware/esp32s3`)

Compact motorcycle handlebar navigation display firmware for **ESP32-S3**. Acts as a **BLE GATT Peripheral** (`7f3a0000-0000-4d41-5057-4d4150000001`), decodes 38-byte CRC-protected telemetry frames sent by the iPhone companion app, tracks session/sequence numbers and message freshness, and renders the HUD state.

> **Hardware Verification Status:** Firmware source code and protocol state machine (`include/wmap_protocol.h`) are implemented and verified against the shared golden test vectors (`BLE_GOLDEN_VECTORS`). Physical ESP32-S3 flashing and live BLE over-the-air testing remain pending until ESP32-S3 hardware is acquired.

---

## 1. Directory Structure

- [`platformio.ini`](file:///f:/W_MAP/firmware/esp32s3/platformio.ini) — PlatformIO build configuration (`esp32-s3-devkitc-1` and `native` host test target).
- [`include/board_config.h`](file:///f:/W_MAP/firmware/esp32s3/include/board_config.h) — Hardware configuration layer (240×240 GC9A01 / ST7789 display driver selection, SPI GPIO pinout, BLE MTU, and freshness timeout constants).
- [`include/wmap_protocol.h`](file:///f:/W_MAP/firmware/esp32s3/include/wmap_protocol.h) — Pure C++17 binary protocol decoder (`decode_telemetry`), CRC-16/CCITT-FALSE verifier, Device Status encoder, and `ReceiverState` state machine.
- [`src/main.cpp`](file:///f:/W_MAP/firmware/esp32s3/src/main.cpp) — NimBLE GATT Server callbacks, lock-free `RawFrameInbox` handoff, dirty-flag HUD renderer, and 2 s status notification heartbeat.
- [`test/test_protocol.cpp`](file:///f:/W_MAP/firmware/esp32s3/test/test_protocol.cpp) — Host-side C++17 unit test verifying `wmap_protocol.h` against the shared golden hex vectors.

---

## 2. Build & Flash Instructions

### Using PlatformIO CLI (`pio`)
```powershell
cd firmware/esp32s3
pio run -e esp32-s3-devkitc-1                 # Compile firmware
pio run -e esp32-s3-devkitc-1 -t upload       # Flash to ESP32-S3 over USB
pio device monitor -b 115200                  # Monitor serial HUD output
```

### Host-Side Protocol Unit Test (when a C++17 compiler such as `g++` or `clang++` is installed)
```powershell
g++ -std=c++17 firmware/esp32s3/test/test_protocol.cpp -o test_protocol
./test_protocol
```

---

## 3. Motorcycle 12V Electrical & Power Safety Requirements

> **WARNING:** Never connect an ESP32-S3 `5V` or `3.3V` pin directly to a motorcycle battery or 12V accessory wire.

A motorcycle's nominal 12V electrical system experiences:
- **Charging voltage:** `13.8V – 14.8V` during normal riding.
- **Cranking sags:** Drops to `6V – 9V` during electric starter engagement.
- **Load-dump & inductive transients:** High-voltage spikes (`+40V to +100V`) and negative transients from ignition coils, horn, or starter relay (ISO 7637-2).

### Required Power Supply Architecture
1. **Automotive-Rated DC-DC Buck Converter (`9V–36V` or `8V–60V` input → regulated `5.0V` output, $\ge 2\text{A}$):**
   - Connect to an **ignition-switched 12V accessory circuit** (`ACC`) so the ESP32-S3 does not drain the motorcycle battery when parked.
2. **Inline Fuse:**
   - Install a `1A – 2A` automotive blade fuse as close as practical to the 12V tap.
3. **Reverse-Polarity & Transient Protection:**
   - Use an automotive TVS diode (e.g., `SMBJ33A` / `SMCJ36A`) and a P-channel MOSFET or Schottky diode reverse-polarity stage ahead of the buck regulator.
4. **Thermal & Environmental Protection:**
   - Pot or conformal-coat the PCB and house the display in a weather-sealed (`IP65+`), UV-resistant enclosure with vibration-damping handlebar mounts.
   - Keep display backlight PWM adjustable so night riding does not cause glare and daytime sun does not overheat the regulator.
5. **Safe Grounding:**
   - Route power and ground as a twisted pair back to a clean chassis/harness ground point; never use the steering head bearings as a ground return path.
