#include <assert.h>
#include <stdio.h>
#include "../include/wmap_protocol.h"

/**
 * Host-side C++17 unit test for `wmap_protocol.h`.
 * Verifies that the ESP32-S3 C++ decoder produces the exact same values as TypeScript
 * (`packages/navigation-core/tests/bleProtocol.test.ts`) on the shared golden test vectors.
 */

static void hex_to_bytes(const char* hex, uint8_t* out, size_t out_len) {
  for (size_t i = 0; i < out_len; ++i) {
    unsigned int byte = 0;
    sscanf(hex + (i * 2), "%02x", &byte);
    out[i] = static_cast<uint8_t>(byte);
  }
}

int main() {
  // Golden Vector 0: Active navigation in Da Nang (Turn Right in 180m, 45 km/h, limit UNKNOWN)
  const char* vec0_hex = "01012410070048e8010003012d000006b4000000022100000e009d03ac12f500806a7306650d";
  uint8_t vec0_bytes[wmap::TELEMETRY_FRAME_BYTES];
  hex_to_bytes(vec0_hex, vec0_bytes, wmap::TELEMETRY_FRAME_BYTES);

  wmap::ReceiverState rx;
  assert(rx.receiveBytes(vec0_bytes, wmap::TELEMETRY_FRAME_BYTES, 1000) == wmap::DecodeError::OK);
  assert(rx.latestFrame.sessionId == 0x1024);
  assert(rx.latestFrame.sequenceNumber == 7);
  assert(rx.latestFrame.currentSpeedKmh == 45);
  assert(rx.latestFrame.speedLimitKmh == 0);
  assert(rx.latestFrame.speedLimitStatus == wmap::SpeedLimitStatus::UNKNOWN);
  assert(rx.latestFrame.turnDirection == wmap::TurnDirection::RIGHT);
  assert(rx.latestFrame.distanceToTurnMeters == 180);
  assert(rx.latestFrame.remainingDistanceMeters == 8450);
  assert(rx.latestFrame.etaDurationMinutes == 14);
  assert(rx.evaluateBannerState(1100) == wmap::DisplayBannerState::UNKNOWN_LIMIT);

  // Duplicate sequence #7 in same session is rejected
  assert(rx.receiveBytes(vec0_bytes, wmap::TELEMETRY_FRAME_BYTES, 1200) == wmap::DecodeError::DUPLICATE_OR_OLD_SEQ);

  // Stale detection after 3000ms
  assert(rx.evaluateBannerState(4500) == wmap::DisplayBannerState::DATA_STALE);

  // Golden Vector 1: GPS lost & route inactive (seq #8)
  const char* vec1_hex = "01012410080030ec01000002ffff00ffffffffffffffffffffffffff0000008000000080ba0a";
  uint8_t vec1_bytes[wmap::TELEMETRY_FRAME_BYTES];
  hex_to_bytes(vec1_hex, vec1_bytes, wmap::TELEMETRY_FRAME_BYTES);
  assert(rx.receiveBytes(vec1_bytes, wmap::TELEMETRY_FRAME_BYTES, 4600) == wmap::DecodeError::OK);
  assert(!rx.latestFrame.gpsActive);
  assert(rx.latestFrame.currentSpeedKmh == wmap::U16_UNKNOWN);
  assert(rx.evaluateBannerState(4650) == wmap::DisplayBannerState::GPS_LOST);

  printf("All ESP32-S3 wmap_protocol C++ tests passed.\n");
  return 0;
}
