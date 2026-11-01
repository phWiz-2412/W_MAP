import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_WARNING_CONFIG,
  systemClock,
  type CalculatedRoute,
  type Clock,
  type RouteProgressEvaluation,
  type WarningConfig,
} from "@w-map/navigation-core";
import { DestinationNavigationPanel, type ProviderMode } from "./components/DestinationNavigationPanel";
import { NavigationDisplay } from "./components/NavigationDisplay";
import { SimulatorPanel } from "./components/SimulatorPanel";
import { DEFAULT_VN_FIXTURE } from "./fixtures/vnFixtures";
import { useLiveLatencyMetrics, useNavigationData, useSimulatorControls } from "./hooks/useNavigationData";
import {
  GooglePlacesGeocodingProvider,
  NominatimGeocodingProvider,
  SyntheticVnGeocodingProvider,
  type GeocodingProvider,
} from "./services/GeocodingProvider";
import { LivePhoneProvider, buildRelayWebSocketUrl } from "./services/LivePhoneProvider";
import {
  GoogleRoutesProvider,
  OsrmRouteProvider,
  SyntheticFixtureMapProvider,
  type MapRouteProvider,
} from "./services/MapRouteProvider";
import { SimulatorService } from "./services/SimulatorService";

export type DataSource = "SIMULATOR" | "LIVE_PHONE";

interface Props {
  /** Injectable for tests. Default: a simulator with a 1 s heartbeat. */
  simulator?: SimulatorService;
  /** Injectable live provider factory for tests. */
  liveProviderFactory?: () => LivePhoneProvider;
  /** Optional custom geocoding provider for tests. */
  geocodingProvider?: GeocodingProvider;
  /** Optional custom routing provider for tests. */
  routingProvider?: MapRouteProvider;
  /** Warning configuration baseline (tests use persistenceMs: 0). */
  warningBase?: WarningConfig;
  clock?: Clock;
  initialSource?: DataSource;
}

const defaultLiveFactory = () =>
  new LivePhoneProvider({ url: buildRelayWebSocketUrl(window.location, "display") });

const fmtMs = (v: number | null) => (v === null ? "--" : `${v} ms`);

export default function App({
  simulator,
  liveProviderFactory = defaultLiveFactory,
  geocodingProvider: customGeocoder,
  routingProvider: customRouter,
  warningBase = DEFAULT_WARNING_CONFIG,
  clock = systemClock,
  initialSource = "SIMULATOR",
}: Props) {
  const [sim] = useState(() => simulator ?? new SimulatorService({ heartbeatMs: 1000 }));
  const [source, setSource] = useState<DataSource>(initialSource);
  const [providerMode, setProviderMode] = useState<ProviderMode>(
    initialSource === "LIVE_PHONE" && !customGeocoder && !customRouter
      ? "ONLINE_OSM"
      : "OFFLINE_SYNTHETIC",
  );

  const live = useMemo(() => (source === "LIVE_PHONE" ? liveProviderFactory() : null), [source, liveProviderFactory]);
  const provider = live ?? sim;

  const defaultGeocoder = useMemo<GeocodingProvider>(() => {
    if (providerMode === "GOOGLE_MAPS") return new GooglePlacesGeocodingProvider();
    if (providerMode === "ONLINE_OSM") return new NominatimGeocodingProvider();
    return new SyntheticVnGeocodingProvider();
  }, [providerMode]);

  const defaultRouter = useMemo<MapRouteProvider>(() => {
    if (providerMode === "GOOGLE_MAPS") return new GoogleRoutesProvider({ clock });
    if (providerMode === "ONLINE_OSM") return new OsrmRouteProvider({ clock });
    return new SyntheticFixtureMapProvider(DEFAULT_VN_FIXTURE, clock);
  }, [providerMode, clock]);

  const activeGeocoder = customGeocoder ?? defaultGeocoder;
  const activeRouter = customRouter ?? defaultRouter;

  const [threshold, setThreshold] = useState(warningBase.thresholdKmh);
  const [mapMetersPerPixel, setMapMetersPerPixel] = useState<number>(2);
  const controls = useSimulatorControls(sim);
  const feed = useNavigationData(provider);
  const liveMetrics = useLiveLatencyMetrics(live);
  const warningConfig = useMemo(() => ({ ...warningBase, thresholdKmh: threshold }), [warningBase, threshold]);

  useEffect(() => () => live?.dispose(), [live]);
  useEffect(() => () => sim.dispose(), [sim]);

  const isLive = source === "LIVE_PHONE";
  const mode = controls.mode;

  useEffect(() => {
    if (isLive && liveMetrics.phoneDisplayMode) {
      sim.update({ mode: liveMetrics.phoneDisplayMode });
    }
  }, [isLive, liveMetrics.phoneDisplayMode, sim]);

  const handleGuidanceChange = useCallback(
    (evalResult: RouteProgressEvaluation | null, route: CalculatedRoute | null) => {
      if (isLive && live) {
        if (!evalResult || !route) {
          // Leave phone-computed guidance untouched when no PC-side route override is active
          live.setRouteOverlay({});
        } else {
          live.setRouteOverlay({
            routeStatus: "ACTIVE",
            turnDirection: evalResult.activeStep.turnDirection,
            distanceToTurnMeters: evalResult.distanceToNextTurnMeters,
            routePoints: evalResult.compactRoutePoints,
            speedLimitKmh: null,
            speedLimitStatus: "UNKNOWN",
          });
        }
      } else {
        if (!evalResult || !route) {
          sim.setCalculatedRoute(null);
        } else {
          sim.setCalculatedRoute(route, evalResult);
        }
      }
    },
    [isLive, live, sim],
  );

  const currentPosition =
    feed.data && feed.data.latitude !== null && feed.data.longitude !== null
      ? { latitude: feed.data.latitude, longitude: feed.data.longitude }
      : null;

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
        <button
          type="button"
          aria-pressed={isLive}
          onClick={() => {
            setSource("LIVE_PHONE");
            if (!customGeocoder && !customRouter) {
              setProviderMode("ONLINE_OSM");
            }
          }}
        >
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
              backdropRoads={isLive ? undefined : sim.getBackdropRoads()}
              metersPerPixel={mapMetersPerPixel}
            />
          </div>
          <div className="hud-mode-switch" role="group" aria-label="HUD display mode">
            <button
              type="button"
              className={mode === "TURN" ? "active" : ""}
              aria-pressed={mode === "TURN"}
              onClick={() => sim.update({ mode: "TURN" })}
              data-testid="hud-mode-turn"
            >
              TURN HUD
            </button>
            <button
              type="button"
              className={mode === "MAP" ? "active" : ""}
              aria-pressed={mode === "MAP"}
              onClick={() => sim.update({ mode: "MAP" })}
              data-testid="hud-mode-map"
            >
              MAP HUD
            </button>
          </div>
          {mode === "MAP" && (
            <div className="hud-mode-switch" role="group" aria-label="MAP HUD zoom scale">
              {[
                { label: "Zoom Near (1x)", value: 1 },
                { label: "Normal (2x)", value: 2 },
                { label: "Wide (4x)", value: 4 },
              ].map((z) => (
                <button
                  key={z.value}
                  type="button"
                  className={mapMetersPerPixel === z.value ? "active" : ""}
                  aria-pressed={mapMetersPerPixel === z.value}
                  onClick={() => setMapMetersPerPixel(z.value)}
                >
                  {z.label}
                </button>
              ))}
            </div>
          )}
          <p className="feed-info" data-testid="feed-info">
            Packet #{feed.data?.sequenceNumber ?? "-"} - rejected: {feed.rejectedCount} - dropped old: {feed.droppedStaleCount}
          </p>
          {feed.lastError && (
            <p className="feed-error" role="status" data-testid="feed-error">
              Last rejected packet: {feed.lastError}
            </p>
          )}
        </section>

        <div className="right-column">
          {isLive ? (
            <section className="panel" aria-label="Live GPS" data-testid="live-panel">
              <h2>Live phone GPS &amp; Latency Diagnostics</h2>
              <p className="panel-note">
                Speed and position come from the phone&apos;s real GPS through a LAN WebSocket relay (not Bluetooth). Speed limits remain UNKNOWN unless verified.
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

              <div className="field">
                <label htmlFor="live-mode">Display mode</label>
                <select id="live-mode" value={mode} onChange={(e) => sim.update({ mode: e.target.value as typeof mode })}>
                  <option value="TURN">TURN</option>
                  <option value="MAP">MAP</option>
                </select>
              </div>

              <fieldset data-testid="live-latency-metrics">
                <legend>Latency &amp; Telemetry Diagnostics</legend>
                <div className="row">
                  <span>Diagnostic status:</span>
                  <output data-testid="metric-diagnostic-status">
                    {liveMetrics.diagnosticStatus ?? "DISCONNECTED_FROM_RELAY"} — {liveMetrics.diagnosticSummary ?? ""}
                  </output>
                </div>
                <div className="row">
                  <span>Display WebSocket / Relay phones:</span>
                  <output data-testid="metric-display-ws">
                    {liveMetrics.displaySocketState ?? "disconnected"} (phones on relay:{" "}
                    <span data-testid="metric-relay-phones">{liveMetrics.relayPhoneCount ?? 0}</span>)
                  </output>
                </div>
                <div className="row">
                  <span>Current relay endpoint:</span>
                  <output data-testid="metric-relay-endpoint">{liveMetrics.relayEndpoint || "--"}</output>
                </div>
                <div className="row">
                  <span>iPhone Brain route / instruction:</span>
                  <output data-testid="metric-phone-route">
                    {liveMetrics.phoneDestinationName
                      ? `${liveMetrics.phoneDestinationName} — ${liveMetrics.phoneInstruction ?? "Active"} (${liveMetrics.phoneRemainingDistanceMeters ?? "--"} m left)`
                      : "None (plan route on iPhone /phone.html or below)"}
                  </output>
                </div>
                <div className="row">
                  <span>GPS sample age (phone clock):</span>
                  <output data-testid="metric-sample-age">{fmtMs(liveMetrics.phoneSampleAgeMs)}</output>
                </div>
                <div className="row">
                  <span>Phone JS processing delay:</span>
                  <output data-testid="metric-phone-proc">{fmtMs(liveMetrics.phoneProcessingDelayMs)}</output>
                </div>
                <div className="row">
                  <span>Last phone send timestamp (phone clock):</span>
                  <output data-testid="metric-last-phone-send">
                    {liveMetrics.lastPhoneSendAtMs != null ? `${liveMetrics.lastPhoneSendAtMs}` : "--"}
                  </output>
                </div>
                <div className="row">
                  <span>Relay → Simulator transit (PC clock):</span>
                  <output data-testid="metric-relay-sim">{fmtMs(liveMetrics.relayToSimulatorMs)}</output>
                </div>
                <div className="row">
                  <span>Simulator processing delay:</span>
                  <output data-testid="metric-sim-proc">{fmtMs(liveMetrics.simulatorProcessingMs)}</output>
                </div>
                <div className="row">
                  <span>WebSocket round-trip ping (RTT):</span>
                  <output data-testid="metric-rtt">{fmtMs(liveMetrics.roundTripPingMs)}</output>
                </div>
                <div className="row">
                  <span>Time since last GPS fix:</span>
                  <output data-testid="metric-since-fix">{fmtMs(liveMetrics.timeSinceLastFixMs)}</output>
                </div>
                <div className="row">
                  <span>Time since last GPS packet:</span>
                  <output data-testid="metric-since-pkt">{fmtMs(liveMetrics.timeSinceLastPacketMs)}</output>
                </div>
                <div className="row">
                  <span>Update frequency / Speed source:</span>
                  <output data-testid="metric-freq-source">
                    {liveMetrics.updateFrequencyHz} Hz ({liveMetrics.speedSource})
                  </output>
                </div>
                <div className="row">
                  <span>Fixes accepted / invalid / out-of-order:</span>
                  <output data-testid="metric-packet-counts">
                    {liveMetrics.acceptedFixes} / {liveMetrics.invalidMessages} / {liveMetrics.droppedOutOfOrder}
                  </output>
                </div>
                {liveMetrics.lastError && (
                  <div className="row">
                    <span>Last connection / packet error:</span>
                    <output data-testid="metric-last-error">{liveMetrics.lastError}</output>
                  </div>
                )}
              </fieldset>
            </section>
          ) : (
            <SimulatorPanel
              controls={controls}
              activeFixture={sim.getActiveFixture()}
              onChange={(p) => sim.update(p)}
              onReset={() => {
                sim.reset();
                setThreshold(warningBase.thresholdKmh);
              }}
              onLoadFixture={(fixture) => {
                sim.loadFixture(fixture);
              }}
              onLoadFixtureJson={(raw) => sim.loadFixtureJson(raw)}
              warningThresholdKmh={threshold}
              onThresholdChange={setThreshold}
            />
          )}
        </div>

        <DestinationNavigationPanel
          currentPosition={currentPosition}
          accuracyMeters={isLive ? (live?.getLatestFix()?.accuracyMeters ?? null) : 8}
          gpsStatus={feed.data?.gpsStatus ?? "LOST"}
          providerMode={providerMode}
          onProviderModeChange={customGeocoder || customRouter ? undefined : setProviderMode}
          geocodingProvider={activeGeocoder}
          routingProvider={activeRouter}
          fallbackRoutePoints={isLive ? feed.data?.routePoints : undefined}
          onGuidanceChange={handleGuidanceChange}
        />
      </main>
    </div>
  );
}
