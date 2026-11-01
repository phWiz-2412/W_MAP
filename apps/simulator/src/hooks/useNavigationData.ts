import { useEffect, useState, useSyncExternalStore } from "react";
import {
  isNewerSequence,
  parseNavigationPacketJson,
  type LiveLatencyMetrics,
  type NavigationData,
  type RoutePoint,
} from "@w-map/navigation-core";
import type { LivePhoneProvider } from "../services/LivePhoneProvider";
import type { NavigationDataProvider } from "../services/NavigationDataProvider";
import type { SimulatorControls, SimulatorService } from "../services/SimulatorService";

export interface NavigationFeed {
  data: NavigationData | null;
  /** Messages rejected as malformed/invalid. */
  rejectedCount: number;
  /** Messages dropped as duplicate or older than the last accepted one. */
  droppedStaleCount: number;
  lastError: string | null;
}

const EMPTY: NavigationFeed = { data: null, rejectedCount: 0, droppedStaleCount: 0, lastError: null };

function sameRoutePoints(a: readonly RoutePoint[], b: readonly RoutePoint[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.latitude !== b[i]!.latitude || a[i]!.longitude !== b[i]!.longitude) return false;
  }
  return true;
}

/**
 *Subscribes to any NavigationDataProvider; validates and sequence-filters packets.
 * Reuses the previous `routePoints` array reference when coordinates have not changed
 * so downstream memoized map projections do not recompute on every 1 Hz GPS heartbeat.
 */
export function useNavigationData(provider: NavigationDataProvider): NavigationFeed {
  const [feed, setFeed] = useState<NavigationFeed>(EMPTY);

  useEffect(() => {
    let lastSequence: number | null = null;
    setFeed(EMPTY);
    return provider.subscribe((raw) => {
      const result = parseNavigationPacketJson(raw);
      if (!result.ok) {
        setFeed((f) => ({ ...f, rejectedCount: f.rejectedCount + 1, lastError: result.errors.join("; ") }));
        return;
      }
      const incoming = result.value.data;
      if (!isNewerSequence(lastSequence, incoming.sequenceNumber)) {
        setFeed((f) => ({ ...f, droppedStaleCount: f.droppedStaleCount + 1 }));
        return;
      }
      lastSequence = incoming.sequenceNumber;
      setFeed((f) => {
        const prev = f.data;
        const data =
          prev && sameRoutePoints(prev.routePoints, incoming.routePoints)
            ? { ...incoming, routePoints: prev.routePoints }
            : incoming;
        return { ...f, data };
      });
    });
  }, [provider]);

  return feed;
}

/** Reactive view of the simulator's control state. */
export function useSimulatorControls(sim: SimulatorService): SimulatorControls {
  return useSyncExternalStore(sim.subscribeControls, sim.getControls);
}

const NO_METRICS: LiveLatencyMetrics = {
  phoneSampleAgeMs: null,
  phoneProcessingDelayMs: null,
  relayToSimulatorMs: null,
  simulatorProcessingMs: null,
  timeSinceLastFixMs: null,
  timeSinceLastPacketMs: null,
  roundTripPingMs: null,
  updateFrequencyHz: 0,
  acceptedFixes: 0,
  invalidMessages: 0,
  droppedOutOfOrder: 0,
  speedSource: "none",
};

const noopSubscribe = () => () => undefined;
const getNoMetrics = () => NO_METRICS;

/** Reactive view of live phone GPS latency metrics. */
export function useLiveLatencyMetrics(live: LivePhoneProvider | null): LiveLatencyMetrics {
  return useSyncExternalStore(
    live ? live.subscribeMetrics : noopSubscribe,
    live ? live.getMetrics : getNoMetrics,
  );
}
