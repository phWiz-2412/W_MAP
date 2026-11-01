import { useEffect, useMemo, useState } from "react";
import { DEFAULT_WARNING_CONFIG, systemClock, type Clock, type WarningConfig } from "@w-map/navigation-core";
import { NavigationDisplay } from "./components/NavigationDisplay";
import { SimulatorPanel } from "./components/SimulatorPanel";
import { DEMO_BACKDROP } from "./fixtures/demoRoute";
import { useNavigationData, useSimulatorControls } from "./hooks/useNavigationData";
import { SimulatorService } from "./services/SimulatorService";

interface Props {
  /** Injectable for tests. Default: a simulator with a 1 s heartbeat. */
  simulator?: SimulatorService;
  /** Warning configuration baseline (tests use persistenceMs: 0). */
  warningBase?: WarningConfig;
  clock?: Clock;
}

export default function App({ simulator, warningBase = DEFAULT_WARNING_CONFIG, clock = systemClock }: Props) {
  const [sim] = useState(() => simulator ?? new SimulatorService({ heartbeatMs: 1000 }));
  const [threshold, setThreshold] = useState(warningBase.thresholdKmh);
  const controls = useSimulatorControls(sim);
  const feed = useNavigationData(sim);
  const warningConfig = useMemo(() => ({ ...warningBase, thresholdKmh: threshold }), [warningBase, threshold]);

  useEffect(() => () => sim.dispose(), [sim]);

  return (
    <div className="app">
      <header>
        <h1>
          W_MAP <span className="ver">Simulator - Phase 1</span>
        </h1>
        <span className="badge" data-testid="source-badge">
          {sim.label} - no real GPS / Bluetooth
        </span>
      </header>
      <div className="disclaimer" role="note">
        Auxiliary display simulation, not a certified instrument. The speed limit shown is simulated and is not a substitute for road signs. Never use a phone or this simulator while riding.
      </div>
      <main className="layout">
        <section className="device" aria-label="Device display">
          <div className="device-frame">
            <NavigationDisplay data={feed.data} mode={controls.mode} warningConfig={warningConfig} clock={clock} backdropRoads={DEMO_BACKDROP} />
          </div>
          <p className="feed-info" data-testid="feed-info">
            Packet #{feed.data?.sequenceNumber ?? "-"} - rejected: {feed.rejectedCount} - dropped old: {feed.droppedStaleCount}
          </p>
          {feed.lastError && (
            <p className="feed-error" role="status" data-testid="feed-error">
              Last rejected packet: {feed.lastError}
            </p>
          )}
        </section>
        <SimulatorPanel
          controls={controls}
          onChange={(p) => sim.update(p)}
          onReset={() => {
            sim.reset();
            setThreshold(warningBase.thresholdKmh);
          }}
          warningThresholdKmh={threshold}
          onThresholdChange={setThreshold}
        />
      </main>
    </div>
  );
}
