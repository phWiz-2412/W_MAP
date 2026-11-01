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
import { InteractivePlanningMap } from "./InteractivePlanningMap";
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
  onGuidanceChange,
}: Props) {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchStatus, setSearchStatus] = useState<"IDLE" | "LOADING" | "DONE" | "ERROR">("IDLE");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<GeocodingCandidate[]>([]);

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
    const origin = latestPosRef.current;
    if (!origin) {
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

  const selectDestinationCandidate = (c: GeocodingCandidate) => {
    setDestination({ label: c.name, point: c.location });
    void calculateRouteTo(c.location, false);
  };

  const selectDestinationOnMap = (pt: RoutePoint) => {
    const label = `Map pin (${pt.latitude.toFixed(4)}, ${pt.longitude.toFixed(4)})`;
    setDestination({ label, point: pt });
    void calculateRouteTo(pt, false);
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
    if (!route || !currentPosition) return;
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
    <section className="panel" aria-label="Destination & route planner" data-testid="destination-panel">
      <h2>Destination &amp; Turn-by-Turn Planner</h2>
      <p className="panel-note">
        Select a destination by searching or clicking the planning map. Speed limits from routing providers are never assumed and remain <strong>UNKNOWN</strong>.
      </p>

      {onProviderModeChange && (
        <div className="field">
          <label htmlFor="provider-mode">Geocoding &amp; routing provider</label>
          <select
            id="provider-mode"
            value={providerMode}
            onChange={(e) => onProviderModeChange(e.target.value as ProviderMode)}
          >
            <option value="OFFLINE_SYNTHETIC">Offline Synthetic Vietnam Catalog &amp; Router (Default)</option>
            <option value="ONLINE_OSM">Online OpenStreetMap (Nominatim + OSRM Demo)</option>
          </select>
        </div>
      )}

      <div className="field">
        <label htmlFor="dest-search-input">Search destination (place, street, POI)</label>
        <div className="search-row">
          <input
            id="dest-search-input"
            type="text"
            placeholder="e.g. Chợ Bến Thành, Lê Lợi, Hồ Hoàn Kiếm..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSearch();
              }
            }}
          />
          <button type="button" onClick={() => void handleSearch()} data-testid="dest-search-btn">
            Search
          </button>
        </div>
      </div>

      {searchStatus === "LOADING" && (
        <p className="panel-note" data-testid="search-loading">
          Searching locations...
        </p>
      )}
      {searchStatus === "ERROR" && searchError && (
        <p className="feed-error" role="alert" data-testid="search-error">
          Search error: {searchError}
        </p>
      )}
      {searchStatus === "DONE" && results.length === 0 && (
        <p className="panel-note" data-testid="search-empty">
          No matching locations found. Try another query or click directly on the map.
        </p>
      )}

      {results.length > 0 && (
        <ul className="search-results" aria-label="Destination search results" data-testid="search-results">
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

      <InteractivePlanningMap
        currentPosition={currentPosition}
        gpsStatus={gpsStatus}
        destination={destination?.point ?? null}
        route={route}
        activeStepIndex={tracker.activeStepIndex}
        onSelectDestination={selectDestinationOnMap}
      />

      <div className="route-summary" data-testid="route-summary" data-status={routeStatus}>
        <div className="row">
          <strong>Route status:</strong>
          <span data-testid="planner-route-status">{routeStatus}</span>
        </div>
        {destination && (
          <div className="row">
            <span>Destination:</span>
            <span data-testid="selected-destination-label">{destination.label}</span>
          </div>
        )}
        {route && evaluation && (
          <>
            <div className="row">
              <span>Remaining / Total:</span>
              <span data-testid="route-distance-summary">
                {formatDistance(evaluation.remainingDistanceMeters)} / {formatDistance(route.totalDistanceMeters)}
                {route.estimatedDurationSeconds !== null
                  ? ` (~${Math.max(1, Math.round(route.estimatedDurationSeconds / 60))} min)`
                  : ""}
              </span>
            </div>
            <div className="row">
              <span>Active step ({tracker.activeStepIndex + 1}/{route.steps.length}):</span>
              <span data-testid="active-step-instruction">{evaluation.activeStep.instruction}</span>
            </div>
            <div className="row">
              <span>Progressfreshness:</span>
              <span data-testid="route-progress-freshness">
                {evaluation.isProgressCurrent ? "Current (GPS ACTIVE)" : "Paused (GPS LOST / Stale)"}
              </span>
            </div>
          </>
        )}
        {routeError && (
          <p className="feed-error" role="alert" data-testid="route-error">
            {routeError}
          </p>
        )}
        {destination && (
          <div className="search-row">
            <button
              type="button"
              onClick={() => void calculateRouteTo(destination.point, false)}
              data-testid="recalculate-route-btn"
            >
              Recalculate route
            </button>
            <button type="button" onClick={clearDestination} data-testid="clear-destination-btn">
              Clear destination
            </button>
          </div>
        )}
      </div>

      <p className="panel-note" data-testid="provider-attribution">
        Geocoding: {geocodingProvider.attribution} · Routing: {routingProvider.attribution}
      </p>
    </section>
  );
}
