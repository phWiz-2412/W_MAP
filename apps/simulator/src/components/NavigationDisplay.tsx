import { useEffect, useState } from "react";
import {
  DEFAULT_WARNING_CONFIG,
  INITIAL_TRACKER,
  evaluateSpeed,
  pendingDelayMs,
  systemClock,
  type Clock,
  type NavigationData,
  type NavigationMode,
  type SpeedState,
  type WarningConfig,
  type WarningTracker,
} from "@w-map/navigation-core";
import type { BackdropRoad } from "../fixtures/demoRoute";
import { MapDisplay } from "./MapDisplay";
import { StatusIndicator } from "./StatusIndicator";
import { TurnDisplay } from "./TurnDisplay";

interface Props {
  data: NavigationData | null;
  mode: NavigationMode;
  warningConfig?: WarningConfig;
  clock?: Clock;
  backdropRoads?: readonly BackdropRoad[];
  /** How often packet age is re-checked. */
  recheckMs?: number;
}

/** Runs the pure warning evaluator with persistence timing and packet-age checks. */
function useSpeedState(data: NavigationData | null, config: WarningConfig, clock: Clock, recheckMs: number): SpeedState {
  const [result, setResult] = useState<{ state: SpeedState; tracker: WarningTracker }>({
    state: "NO_SPEED",
    tracker: INITIAL_TRACKER,
  });
  const [tick, setTick] = useState(0);

  // Packet age grows even when no new packet arrives, so re-check periodically.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), recheckMs);
    return () => clearInterval(id);
  }, [recheckMs]);

  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = (tracker: WarningTracker) => {
      const now = clock.nowMs();
      const next = evaluateSpeed({ ...data, packetAgeMs: now - data.timestamp }, config, tracker, now);
      if (cancelled) return;
      setResult((prev) =>
        prev.state === next.state && prev.tracker.warning === next.tracker.warning && prev.tracker.overSinceMs === next.tracker.overSinceMs
          ? prev
          : next,
      );
      const delay = pendingDelayMs(next.tracker, config, now);
      if (delay !== null) timer = setTimeout(() => run(next.tracker), delay);
    };
    run(result.tracker);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `result.tracker` is intentionally read only when the effect starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, config, clock, tick]);

  return data ? result.state : "NO_SPEED";
}

/** 240x240 logical SVG display. Scales responsively; always square. */
export function NavigationDisplay({
  data,
  mode,
  warningConfig = DEFAULT_WARNING_CONFIG,
  clock = systemClock,
  backdropRoads,
  recheckMs = 500,
}: Props) {
  const speedState = useSpeedState(data, warningConfig, clock, recheckMs);
  const border = speedState === "WARNING" ? "#ff3b3b" : speedState === "DISCONNECTED" ? "#ff5a5f" : "#2a313c";

  return (
    <svg
      className="device-display"
      viewBox="0 0 240 240"
      role="group"
      aria-label="Simulated navigation display"
      data-testid="navigation-display"
      data-mode={mode}
      data-speed-state={speedState}
      fontFamily="'Segoe UI', system-ui, sans-serif"
    >
      <rect x={0} y={0} width={240} height={240} rx={14} fill="#0b0d10" />
      <rect x={1.5} y={1.5} width={237} height={237} rx={13} fill="none" stroke={border} strokeWidth={speedState === "WARNING" ? 3 : 1.5} data-testid="display-border" />
      {data ? (
        <>
          <StatusIndicator gps={data.gpsStatus} ble={data.bleStatus} />
          {mode === "TURN" ? (
            <TurnDisplay data={data} speedState={speedState} />
          ) : (
            <MapDisplay data={data} speedState={speedState} backdropRoads={backdropRoads} />
          )}
        </>
      ) : (
        <text x={120} y={124} textAnchor="middle" fontSize={14} fontWeight={700} fill="#9aa3b2" data-testid="waiting">
          NO NAVIGATION DATA
        </text>
      )}
      <text x={120} y={235} textAnchor="middle" fontSize={8} fill="#6b7280" data-testid="sim-footer">
        SIMULATED DATA - NOT A ROAD SIGN
      </text>
    </svg>
  );
}
