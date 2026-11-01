import { useEffect, useMemo, useState } from "react";
import { DEFAULT_WARNING_CONFIG, systemClock, type Clock, type WarningConfig } from "@w-map/navigation-core";
import { NavigationDisplay } from "./components/NavigationDisplay";
import { SimulatorPanel } from "./components/SimulatorPanel";
import { DEMO_BACKDROP } from "./fixtures/demoRoute";
import { useNavigationData, useSimulatorControls } from "./hooks/useNavigationData";
import { LivePhoneProvider } from "./services/LivePhoneProvider";
import { SimulatorService } from "./services/SimulatorService";

export type DataSource = "SIMULATOR" | "LIVE_PHONE";

interface Props {
  /** Injectable for tests. Default: a simulator with a 1 s heartbeat. */
  simulator?: SimulatorService;
  /** Injectable live provider factory for tests. */
  liveProviderFactory?: () => LivePhoneProvider;
  /** Warning configuration baseline (tests use persistenceMs: 0). */
  warningBase?: WarningConfig;
  clock?: Clock;
  initialSource?: DataSource;
}

const defaultLiveFactory = () => {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return new LivePhoneProvider({ url: `${proto}://${location.host}/ws?role=display` });
};

export default function App({
  simulator,
  liveProviderFactory = defaultLiveFactory,
  warningBase = DEFAULT_WARNING_CONFIG,
  clock = systemClock,
  initialSource = "SIMULATOR",
}: Props) {
  const [sim] = useState(() => simulator ?? new SimulatorService({ heartbeatMs: 1000 }));
  const [source, setSource] = useState<DataSource>(initialSource);
  const live = useMemo(() => (source === "LIVE_PHONE" ? liveProviderFactory() : null), [source, liveProviderFactory]);
  const provider = live ?? sim;
  const [threshold, setThreshold] = useState(warningBase.thresholdKmh);
  const controls = useSimulatorControls(sim);
  const feed = useNavigationData(provider);
  const warningConfig = useMemo(() => ({ ...warningBase, thresholdKmh: threshold }), [warningBase, threshold]);

  useEffect(() => () => live?.dispose(), [live]);
  useEffect(() => () => sim.dispose(), [sim]);

  const isLive = source === "LIVE_PHONE";
  const mode = controls.mode;

  return (
    <div className="app">
      <header>
        <h1>
          W_MAP <span className="ver">Simulator - Phase 1</span>
        </h1>
        <span className={isLive ? "badge live" : "badge"} data-testid="source-badge">
          {provider.label}
          {isLive ? "" : " - no real GPS / Bluetooth"}
        </span>
      </header>
      <div className="disclaimer" role="note">
        Auxiliary display, not a certified instrument. Speed limits shown are never verified and are not a substitute for road signs. Never use a phone or this screen while riding.
      </div>
      <div className="source-switch" role="group" aria-label="Data source">
        <button type="button" aria-pressed={!isLive} onClick={() => setSource("SIMULATOR")}>
          Simulator
        </button>
        <button type="button" aria-pressed={isLive} onClick={() => setSource("LIVE_PHONE")}>
          Live phone GPS
        </button>
      </div>
      <main className="layout">
        <section className="device" aria-label="Device display">
          <div className="device-frame">
            <NavigationDisplay
              data={feed.data}
              mode={mode}
              warningConfig={warningConfig}
              clock={clock}
              linkLabel={isLive ? "PHONE LINK" : "SIM BLE"}
              backdropRoads={isLive ? undefined : DEMO_BACKDROP}
            />
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
        {isLive ? (
          <section className="panel" aria-label="Live GPS" data-testid="live-panel">
            <h2>Live phone GPS</h2>
            <p className="panel-note">
              Speed and position come from the phone&apos;s real GPS through a LAN WebSocket relay (not Bluetooth). There is no routing or speed-limit source yet, so the limit stays UNKNOWN and navigation stays OFF.
            </p>
            <ol className="steps">
              <li>
                Start with <code>npm run dev:phone</code> and note the <code>Network</code> https URL.
              </li>
              <li>
                On the iPhone (same WiFi) open <code>https://&lt;PC-IP&gt;:5173/phone.html</code>, accept the certificate warning, tap Start and allow location.
              </li>
              <li>Open this page the same way on the PC and choose Live phone GPS.</li>
            </ol>
            <label htmlFor="live-mode">Display mode</label>
            <select id="live-mode" value={mode} onChange={(e) => sim.update({ mode: e.target.value as typeof mode })}>
              <option value="TURN">TURN</option>
              <option value="MAP">MAP</option>
            </select>
          </section>
        ) : (
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
        )}
      </main>
    </div>
  );
}
