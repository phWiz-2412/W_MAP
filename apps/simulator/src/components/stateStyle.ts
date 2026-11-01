import type { SpeedState } from "@w-map/navigation-core";

export interface StateStyle {
  banner: string;
  color: string;
  /** Speed digits color. */
  speedColor: string;
  /** True when displayed numbers are not current/live. */
  notCurrent: boolean;
}

export const STATE_STYLES: Record<SpeedState, StateStyle> = {
  NORMAL: { banner: "WITHIN LIMIT", color: "#34d399", speedColor: "#ffffff", notCurrent: false },
  WARNING: { banner: "SLOW DOWN", color: "#ff3b3b", speedColor: "#ff3b3b", notCurrent: false },
  UNKNOWN_LIMIT: { banner: "LIMIT UNKNOWN", color: "#9aa3b2", speedColor: "#ffffff", notCurrent: false },
  STALE_LIMIT: { banner: "LIMIT DATA OLD", color: "#f5a524", speedColor: "#ffffff", notCurrent: false },
  DATA_STALE: { banner: "DATA STALE - NOT LIVE", color: "#f5a524", speedColor: "#8b93a1", notCurrent: true },
  GPS_LOST: { banner: "GPS LOST - SPEED OLD", color: "#f5a524", speedColor: "#8b93a1", notCurrent: true },
  DISCONNECTED: { banner: "SIM BLE DISCONNECTED", color: "#ff5a5f", speedColor: "#8b93a1", notCurrent: true },
  NO_SPEED: { banner: "NO SPEED DATA", color: "#f5a524", speedColor: "#8b93a1", notCurrent: true },
};
