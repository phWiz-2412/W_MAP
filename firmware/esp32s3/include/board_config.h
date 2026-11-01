#pragma once
#include <stdint.h>

/**
 * W_MAP ESP32-S3 Hardware Configuration Layer (`board_config.h`)
 *
 * Isolates board-specific GPIO mappings, SPI bus settings, display resolution, and BLE parameters
 * from navigation protocol decoding and HUD state evaluation.
 * Override any macro via compiler build flags (`-DWMAP_PIN_TFT_CS=...`) for your specific ESP32-S3 board.
 */

// Display geometry (240x240 logical cockpit HUD)
#ifndef WMAP_DISPLAY_WIDTH
#define WMAP_DISPLAY_WIDTH 240
#endif

#ifndef WMAP_DISPLAY_HEIGHT
#define WMAP_DISPLAY_HEIGHT 240
#endif

// Display controller selection: 1 = GC9A01 (round 240x240), 2 = ST7789 (square 240x240)
#ifndef WMAP_DISPLAY_DRIVER
#define WMAP_DISPLAY_DRIVER 1
#endif

// Default ESP32-S3 SPI display pins (adjust to match target PCB / wiring)
#ifndef WMAP_PIN_TFT_SCLK
#define WMAP_PIN_TFT_SCLK 12
#endif

#ifndef WMAP_PIN_TFT_MOSI
#define WMAP_PIN_TFT_MOSI 11
#endif

#ifndef WMAP_PIN_TFT_CS
#define WMAP_PIN_TFT_CS 10
#endif

#ifndef WMAP_PIN_TFT_DC
#define WMAP_PIN_TFT_DC 9
#endif

#ifndef WMAP_PIN_TFT_RST
#define WMAP_PIN_TFT_RST 8
#endif

#ifndef WMAP_PIN_TFT_BL
#define WMAP_PIN_TFT_BL 7
#endif

// BLE GATT configuration
#define WMAP_BLE_DEVICE_NAME           "W_MAP-HUD"
#define WMAP_BLE_SERVICE_UUID          "7f3a0000-0000-4d41-5057-4d4150000001"
#define WMAP_BLE_TELEMETRY_CHAR_UUID   "7f3a0001-0000-4d41-5057-4d4150000001"
#define WMAP_BLE_ROUTE_CHUNK_CHAR_UUID "7f3a0002-0000-4d41-5057-4d4150000001"
#define WMAP_BLE_STATUS_CHAR_UUID      "7f3a0003-0000-4d41-5057-4d4150000001"
#define WMAP_BLE_PREFERRED_MTU         185

// Timing & freshness thresholds
#define WMAP_MAX_PACKET_AGE_MS         3000U
#define WMAP_STATUS_NOTIFY_INTERVAL_MS 2000U
#define WMAP_RENDER_INTERVAL_MS        50U   // 20 Hz UI poll; redraws only when state is dirty
