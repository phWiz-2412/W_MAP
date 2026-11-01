import { useEffect, useRef, useState } from "react";
import {
  INITIAL_ROUTE_TRACKER,
  evaluateRouteProgress,
  type CalculatedRoute,
  type GPSStatus,
  type RoutePoint,
  type RouteProgressEvaluation,
  type RouteProviderStatus,
  type RouteTrackerState,
} from "@w-map/navigation-core";
import { formatDistance } from "./TurnArrow";
import { InteractivePlanningMap, isValidRoutePoint } from "./InteractivePlanningMap";
import type { GeocodingCandidate, GeocodingProvider } from "../services/GeocodingProvider";
import type { MapRouteProvider } from "../services/MapRouteProvider";

export type ProviderMode = "OFFLINE_SYNTHETIC" | "ONLINE_OSM";

interface Props {
  currentPosition: RoutePoint | null;
  accuracyMeters: number | null;
  gpsStatus: GPSStatus;
  providerMode: ProviderMode;
  onProviderModeChange?: (mode: ProviderMode) => void;
  geocodingProvider: GeocodingProvider;
  routingProvider: MapRouteProvider;
  /** Optional fallback polyline streamed from the iPhone Brain when no PC-calculated route is active. */
  fallbackRoutePoints?: readonly RoutePoint[];
  onGuidanceChange: (evalResult: RouteProgressEvaluation | null, route: CalculatedRoute | null) => void;
}

export function DestinationNavigationPanel({
  currentPosition,
  accuracyMeters,
  gpsStatus,
  providerMode,
  onProviderModeChange,
  geocodingProvider,
  routingProvider,
  fallbackRoutePoints,
  onGuidanceChange,
}: Props) {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchStatus, setSearchStatus] = useState<"IDLE" | "LOADING" | "DONE" | "ERROR">("IDLE");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<GeocodingCandidate[]>([]);

  const [confirmBeforeRoute, setConfirmBeforeRoute] = useState(false);
  const [destination, setDestination] = useState<{ label: string; point: RoutePoint } | null>(null);
  const [routeStatus, setRouteStatus] = useState<RouteProviderStatus>("IDLE");
  const [routeError, setRouteError] = useState<string | null>(null);
  const [route, setRoute] = useState<CalculatedRoute | null>(null);
  const [tracker, setTracker] = useState<RouteTrackerState>(INITIAL_ROUTE_TRACKER);
  const [evaluation, setEvaluation] = useState<RouteProgressEvaluation | null>(null);

  const searchAbortRef = useRef<AbortController | null>(null);
  const routeAbortRef = useRef<AbortController | null>(null);
  const rerouteInFlightRef = useRef(false);
  /** Ref holding the latest valid GPS position so destination selection only triggers 1 route calculation. */
  const latestPosRef = useRef<RoutePoint | null>(currentPosition);
  latestPosRef.current = currentPosition;

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort();
      routeAbortRef.current?.abort();
    };
  }, []);

  const handleSearch = async () => {
    const q = searchQuery.trim();
    if (!q) {
      setResults([]);
      setSearchStatus("IDLE");
      return;
    }
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearchStatus("LOADING");
    setSearchError(null);

    try {
      const matches = await geocodingProvider.search(q, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setResults(matches);
      setSearchStatus("DONE");
    } catch (err) {
      if (controller.signal.aborted) return;
      setResults([]);
      setSearchStatus("ERROR");
      setSearchError(err instanceof Error ? err.message : "Destination search failed");
    }
  };

  const calculateRouteTo = async (destPoint: RoutePoint, isReroute = false) => {
    if (!isValidRoutePoint(destPoint)) {
      setRoute(null);
      setEvaluation(null);
      setRouteStatus("ERROR");
      setRouteError("Invalid destination coordinates (latitude must be -90..90 and longitude -180..180).");
      onGuidanceChange(null, null);
      return;
    }

    const origin = latestPosRef.current;
    if (!origin || !isValidRoutePoint(origin)) {
      setRouteStatus("UNAVAILABLE");
      setRouteError("Waiting for a valid GPS origin position before calculating route.");
      return;
    }
    if (isReroute && rerouteInFlightRef.current) return;

    routeAbortRef.current?.abort();
    const controller = new AbortController();
    routeAbortRef.current = controller;
    if (isReroute) rerouteInFlightRef.current = true;
    setRouteStatus(isReroute ? "REROUTING" : "CALCULATING");
    setRouteError(null);

    try {
      const calc = await routingProvider.calculateRoute({
        origin,
        destination: destPoint,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setRoute(calc);
      setTracker(INITIAL_ROUTE_TRACKER);
      const initialEval = evaluateRouteProgress(
        calc,
        origin,
        accuracyMeters,
        gpsStatus,
        INITIAL_ROUTE_TRACKER,
      );
      setEvaluation(initialEval);
      setRouteStatus(initialEval.hasArrived ? "ARRIVED" : "ACTIVE");
      onGuidanceChange(initialEval, calc);
    } catch (err) {
      if (controller.signal.aborted) return;
      setRoute(null);
      setEvaluation(null);
      setRouteStatus("ERROR");
      setRouteError(err instanceof Error ? err.message : "Route calculation failed");
      onGuidanceChange(null, null);
    } finally {
      if (isReroute) rerouteInFlightRef.current = false;
    }
  };

  const applySelectedDestination = (label: string, point: RoutePoint) => {
    if (!isValidRoutePoint(point)) {
      setDestination(null);
      setRoute(null);
      setEvaluation(null);
      setRouteStatus("ERROR");
      setRouteError("Invalid destination coordinates selected.");
      onGuidanceChange(null, null);
      return;
    }
    setDestination({ label, point });
    setRouteError(null);
    if (confirmBeforeRoute) {
      routeAbortRef.current?.abort();
      setRoute(null);
      setEvaluation(null);
      setRouteStatus("IDLE");
      onGuidanceChange(null, null);
    } else {
      void calculateRouteTo(point, false);
    }
  };

  const selectDestinationCandidate = (c: GeocodingCandidate) => {
    applySelectedDestination(c.name, c.location);
  };

  const selectDestinationOnMap = (pt: RoutePoint) => {
    const label =
      isValidRoutePoint(pt)
        ? `Map pin (${pt.latitude.toFixed(4)}, ${pt.longitude.toFixed(4)})`
        : "Invalid map coordinate";
    applySelectedDestination(label, pt);
  };

  const clearDestination = () => {
    routeAbortRef.current?.abort();
    rerouteInFlightRef.current = false;
    setDestination(null);
    setRoute(null);
    setEvaluation(null);
    setTracker(INITIAL_ROUTE_TRACKER);
    setRouteStatus("IDLE");
    setRouteError(null);
    onGuidanceChange(null, null);
  };

  // Update route progress when GPS position or status changes (without making network requests unless off-route)
  useEffect(() => {
    if (!route) return;
    if (!currentPosition || !isValidRoutePoint(currentPosition) || gpsStatus !== "ACTIVE") {
      setEvaluation((prev) => (prev ? { ...prev, isProgressCurrent: false } : prev));
      return;
    }
    const nextEval = evaluateRouteProgress(route, currentPosition, accuracyMeters, gpsStatus, tracker);
    setTracker(nextEval.tracker);
    setEvaluation(nextEval);
    onGuidanceChange(nextEval, route);

    if (nextEval.hasArrived) {
      setRouteStatus("ARRIVED");
    } else if (nextEval.isOffRoute && destination && !rerouteInFlightRef.current) {
      setRouteStatus("OFF_ROUTE");
      void calculateRouteTo(destination.point, true);
    } else if (routeStatus !== "CALCULATING" && routeStatus !== "REROUTING") {
      setRouteStatus("ACTIVE");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPosition?.latitude, currentPosition?.longitude, gpsStatus]);

  return (
    <section
      className="panel planner-panel"
      aria-label="Destination & route planner"
      data-testid="destination-panel"
    >
      <div className="planner-header">
        <div>
          <h2>Destination &amp; Real Street Map Planner</h2>
          <p className="panel-note">
            Search for a street or landmark, or click/tap directly on the interactive OpenStreetMap street map below. Speed limits from routing providers are never assumed and remain{" "}
            <strong>UNKNOWN</strong>.
          </p>
        </div>
        {onProviderModeChange && (
          <div className="field provider-select-field">
            <label htmlFor="provider-mode">Geocoding &amp; routing provider</label>
            <select
              id="provider-mode"
              value={providerMode}
              onChange={(e) => onProviderModeChange(e.target.value as ProviderMode)}
              data-testid="provider-mode-select"
            >
              <option value="OFFLINE_SYNTHETIC">
                Offline Synthetic Vietnam Catalog &amp; Router (Default)
              </option>
              <option value="ONLINE_OSM">
                Online OpenStreetMap (Nominatim + OSRM Real Streets)
              </option>
            </select>
          </div>
        )}
      </div>

      <div className="planner-controls-grid">
        <div className="planner-search-col">
          <div className="field">
            <label htmlFor="dest-search-input">Search destination (place, street, POI)</label>
            <div className="search-row">
              <input
                id="dest-search-input"
                type="text"
                placeholder="e.g. Chợ Bến Thành, Lê Lợi, Hồ Hoàn Kiếm, Cầu Rồng..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleSearch();
                  }
                }}
              />
              <button
                type="button"
                onClick={() => void handleSearch()}
                data-testid="dest-search-btn"
              >
                Search
              </button>
            </div>
          </div>

          <label className="check panel-note" htmlFor="confirm-before-route">
            <input
              id="confirm-before-route"
              type="checkbox"
              checked={confirmBeforeRoute}
              onChange={(e) => setConfirmBeforeRoute(e.target.checked)}
              data-testid="confirm-before-route-toggle"
            />{" "}
            Confirm destination before requesting route
          </label>

          {searchStatus === "LOADING" && (
            <p className="panel-note" data-testid="search-loading">
              Searching locations...
            </p>
          )}
          {searchStatus === "ERROR" && searchError && (
            <div className="search-row" role="alert" data-testid="search-error">
              <p className="feed-error">Search error: {searchError}</p>
              <button
                type="button"
                onClick={() => void handleSearch()}
                data-testid="retry-search-btn"
              >
                Retry search
              </button>
            </div>
          )}
          {searchStatus === "DONE" && results.length === 0 && (
            <p className="panel-note" data-testid="search-empty">
              No matching locations found. Try another query or click directly on the map.
            </p>
          )}

          {results.length > 0 && (
            <ul
              className="search-results"
              aria-label="Destination search results"
              data-testid="search-results"
            >
              {results.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className="search-result-btn"
                    onClick={() => selectDestinationCandidate(r)}
                    data-testid={`search-result-${r.id}`}
                  >
                    <strong>{r.name}</strong>
                    <span>{r.displayName}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="route-summary" data-testid="route-summary" data-status={routeStatus}>
          <div className="row">
            <strong>Route status:</strong>
            <span data-testid="planner-route-status">{routeStatus}</span>
          </div>
          {destination && (
            <>
              <div className="row">
                <span>Selected destination:</span>
                <span data-testid="selected-destination-label">{destination.label}</span>
              </div>
              <div className="row">
                <span>Destination coords:</span>
                <span data-testid="selected-destination-coords">
                  {destination.point.latitude.toFixed(5)}, {destination.point.longitude.toFixed(5)}
                </span>
              </div>
            </>
          )}
          {route && evaluation && (
            <>
              <div className="row">
                <span>Next turn ({evaluation.activeStep.turnDirection}):</span>
                <span data-testid="planner-next-turn-distance">
                  {formatDistance(evaluation.distanceToNextTurnMeters)}
                </span>
              </div>
              <div className="row">
                <span>Remaining / Total:</span>
                <span data-testid="route-distance-summary">
                  {formatDistance(evaluation.remainingDistanceMeters)} /{" "}
                  {formatDistance(route.totalDistanceMeters)}
                  {route.estimatedDurationSeconds !== null
                    ? ` (~${Math.max(1, Math.round(route.estimatedDurationSeconds / 60))} min)`
                    : ""}
                </span>
              </div>
              <div className="row">
                <span>
                  Active step ({tracker.activeStepIndex + 1}/{route.steps.length}):
                </span>
                <span data-testid="active-step-instruction">
                  {evaluation.activeStep.instruction}
                </span>
              </div>
              <div className="row">
                <span>Progress freshness:</span>
                <span data-testid="route-progress-freshness">
                  {evaluation.isProgressCurrent
                    ? "Current (GPS ACTIVE)"
                    : "Paused (GPS LOST / Stale)"}
                </span>
              </div>
            </>
          )}
          {routeError && (
            <div className="route-error-box">
              <p className="feed-error" role="alert" data-testid="route-error">
                {routeError}
              </p>
              {destination && (
                <button
                  type="button"
                  onClick={() => void calculateRouteTo(destination.point, false)}
                  data-testid="retry-route-btn"
                >
                  Retry route
                </button>
              )}
            </div>
          )}
          {destination && (
            <div className="search-row">
              {!route && routeStatus !== "CALCULATING" && (
                <button
                  type="button"
                  onClick={() => void calculateRouteTo(destination.point, false)}
                  data-testid="confirm-route-btn"
                >
                  Confirm &amp; calculate route
                </button>
              )}
              <button
                type="button"
                onClick={() => void calculateRouteTo(destination.point, false)}
                data-testid="recalculate-route-btn"
              >
                Recalculate route
              </button>
              <button
                type="button"
                onClick={clearDestination}
                data-testid="clear-destination-btn"
              >
                Clear destination
              </button>
            </div>
          )}
          {route && route.steps.length > 0 && (
            <ol
              className="route-steps-list"
              aria-label="Turn-by-turn route steps"
              data-testid="route-steps-list"
            >
              {route.steps.map((step, idx) => (
                <li
                  key={`${idx}-${step.turnDirection}-${step.distanceMeters}`}
                  className={idx === tracker.activeStepIndex ? "step-item active" : "step-item"}
                  data-testid={`route-step-${idx}`}
                >
                  <span className="step-dir">{step.turnDirection}</span>
                  <span className="step-inst">{step.instruction}</span>
                  <span className="step-dist">{formatDistance(step.distanceMeters)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <InteractivePlanningMap
        currentPosition={currentPosition}
        gpsStatus={gpsStatus}
        destination={destination?.point ?? null}
        route={route}
        fallbackRoutePoints={fallbackRoutePoints}
        activeStepIndex={tracker.activeStepIndex}
        onSelectDestination={selectDestinationOnMap}
      />

      <p className="panel-note" data-testid="provider-attribution">
        Map tiles: © OpenStreetMap contributors (ODbL) · Geocoding: {geocodingProvider.attribution}{" "}
        · Routing: {routingProvider.attribution}
      </p>
    </section>
  );
}
