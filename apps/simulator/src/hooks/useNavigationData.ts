import { useEffect, useState, useSyncExternalStore } from "react";
import { isNewerSequence, parseNavigationPacketJson, type NavigationData } from "@w-map/navigation-core";
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

/** Subscribes to any NavigationDataProvider; validates and sequence-filters packets. */
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
      const data = result.value.data;
      if (!isNewerSequence(lastSequence, data.sequenceNumber)) {
        setFeed((f) => ({ ...f, droppedStaleCount: f.droppedStaleCount + 1 }));
        return;
      }
      lastSequence = data.sequenceNumber;
      setFeed((f) => ({ ...f, data }));
    });
  }, [provider]);

  return feed;
}

/** Reactive view of the simulator's control state. */
export function useSimulatorControls(sim: SimulatorService): SimulatorControls {
  return useSyncExternalStore(sim.subscribeControls, sim.getControls);
}
