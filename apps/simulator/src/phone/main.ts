import type { RoutePoint } from "@w-map/navigation-core";
import { DEFAULT_VN_FIXTURE } from "../fixtures/vnFixtures";
import {
  NominatimGeocodingProvider,
  SyntheticVnGeocodingProvider,
  type GeocodingCandidate,
} from "../services/GeocodingProvider";
import {
  OsrmRouteProvider,
  SyntheticFixtureMapProvider,
} from "../services/MapRouteProvider";
import { PhoneGpsClient } from "./phoneClient";

/**
 * Phone companion page ("The Brain" in SteedPilot architecture):
 * 1. Acquires real GPS from iPhone Safari via `navigator.geolocation.watchPosition`.
 * 2. Searches destinations and calculates turn-by-turn routes directly on the phone.
 * 3. Evaluates route progress & automatic off-route rerouting on the phone and streams
 *    both live GPS telemetry and computed turn-by-turn HUD guidance to the display over WebSocket.
 */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const startBtn = $<HTMLButtonElement>("start");
const stopBtn = $<HTMLButtonElement>("stop");
const modeTurnBtn = $<HTMLButtonElement>("mode-turn");
const modeMapBtn = $<HTMLButtonElement>("mode-map");
const speedEl = $("speed");
const statusEl = $("status");
const infoEl = $("info");
const linkEl = $("link");
const endpointEl = $("endpoint");
const errEl = $("error");

const providerSelect = $<HTMLSelectElement>("provider-mode");
const searchInput = $<HTMLInputElement>("search-input");
const searchBtn = $<HTMLButtonElement>("search-btn");
const plannerStatusEl = $("planner-status");
const candidateListEl = $<HTMLUListElement>("candidate-list");
const calcRouteBtn = $<HTMLButtonElement>("calc-route-btn");
const clearRouteBtn = $<HTMLButtonElement>("clear-route-btn");
const guidanceBoxEl = $("guidance-box");
const guidanceDestEl = $("guidance-dest");
const guidanceTurnEl = $("guidance-turn");
const guidanceInstEl = $("guidance-inst");
const guidanceRemEl = $("guidance-rem");

let wakeLock: WakeLockSentinel | null = null;
let candidates: GeocodingCandidate[] = [];
let selectedCandidate: GeocodingCandidate | null = null;
let isCalculatingRoute = false;

const DEFAULT_ORIGIN: RoutePoint = { latitude: 10.772, longitude: 106.698 };

const onlineGeocoder = new NominatimGeocodingProvider();
const offlineGeocoder = new SyntheticVnGeocodingProvider();
const onlineRouter = new OsrmRouteProvider();
const offlineRouter = new SyntheticFixtureMapProvider(DEFAULT_VN_FIXTURE);

function getActiveProviders() {
  const mode = providerSelect?.value === "OFFLINE_SYNTHETIC" ? "OFFLINE_SYNTHETIC" : "ONLINE_OSM";
  return {
    mode,
    geocoder: mode === "ONLINE_OSM" ? onlineGeocoder : offlineGeocoder,
    router: mode === "ONLINE_OSM" ? onlineRouter : offlineRouter,
  };
}

const client = new PhoneGpsClient({
  onChange: (snap) => {
    if (speedEl) speedEl.textContent = snap.speedKmhText;
    if (statusEl) statusEl.textContent = `State: ${snap.statusLabel}`;
    if (infoEl) infoEl.textContent = snap.infoLabel;
    if (linkEl) linkEl.textContent = snap.linkLabel;
    if (endpointEl) endpointEl.textContent = `Relay endpoint: ${snap.relayEndpoint}`;
    if (errEl) errEl.textContent = snap.errorMessage;
    if (startBtn) startBtn.disabled = snap.running;
    if (stopBtn) stopBtn.disabled = !snap.running;

    if (modeTurnBtn && modeMapBtn) {
      modeTurnBtn.classList.toggle("active-mode", snap.displayMode === "TURN");
      modeMapBtn.classList.toggle("active-mode", snap.displayMode === "MAP");
    }

    if (clearRouteBtn) {
      clearRouteBtn.disabled = snap.activeRoute === null;
    }

    if (guidanceBoxEl) {
      if (snap.activeRoute) {
        guidanceBoxEl.hidden = false;
        if (guidanceDestEl) {
          guidanceDestEl.textContent = `Destination: ${snap.destinationName ?? "Selected Destination"}`;
        }
        if (guidanceTurnEl) {
          const distText = snap.distanceToTurnMeters !== null ? ` in ${snap.distanceToTurnMeters} m` : "";
          guidanceTurnEl.textContent = `${snap.activeTurnDirection}${distText} (${snap.routeStatus})`;
        }
        if (guidanceInstEl) {
          guidanceInstEl.textContent = snap.activeInstruction ?? "";
        }
        if (guidanceRemEl) {
          guidanceRemEl.textContent =
            snap.remainingDistanceMeters !== null
              ? `Remaining: ${snap.remainingDistanceMeters} m`
              : "";
        }
      } else {
        guidanceBoxEl.hidden = true;
      }
    }
  },
  onAutoRerouteRequested: (currentPos) => {
    if (selectedCandidate && !isCalculatingRoute) {
      void calculateAndSendRoute(currentPos, selectedCandidate, true);
    }
  },
});

const initial = client.getSnapshot();
if (endpointEl) endpointEl.textContent = `Relay endpoint: ${initial.relayEndpoint}`;

startBtn?.addEventListener("click", () => {
  client.start();
  navigator.wakeLock?.request("screen").then((l) => (wakeLock = l)).catch(() => undefined);
});

stopBtn?.addEventListener("click", () => {
  client.stop();
  void wakeLock?.release();
  wakeLock = null;
});

modeTurnBtn?.addEventListener("click", () => client.setDisplayMode("TURN"));
modeMapBtn?.addEventListener("click", () => client.setDisplayMode("MAP"));

function renderCandidates() {
  if (!candidateListEl) return;
  candidateListEl.innerHTML = "";
  for (const c of candidates) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    if (selectedCandidate?.id === c.id) {
      btn.classList.add("selected");
    }
    btn.textContent = `${c.name} — ${c.displayName}`;
    btn.addEventListener("click", () => {
      selectedCandidate = c;
      if (calcRouteBtn) calcRouteBtn.disabled = false;
      if (plannerStatusEl) {
        plannerStatusEl.textContent = `Selected: ${c.name} (${c.location.latitude.toFixed(4)}, ${c.location.longitude.toFixed(4)})`;
      }
      renderCandidates();
    });
    li.appendChild(btn);
    candidateListEl.appendChild(li);
  }
}

async function handleSearch() {
  const q = searchInput?.value.trim() ?? "";
  if (!q) {
    if (plannerStatusEl) plannerStatusEl.textContent = "Enter a place name or street address first.";
    return;
  }
  const { geocoder, mode } = getActiveProviders();
  if (plannerStatusEl) {
    plannerStatusEl.textContent = `Searching (${mode === "ONLINE_OSM" ? "OpenStreetMap Vietnam" : "Offline Synthetic VN"})...`;
  }
  try {
    let results = await geocoder.search(q, { limit: 5 });
    if (results.length === 0 && mode === "ONLINE_OSM") {
      results = await offlineGeocoder.search(q, { limit: 5 });
    }
    candidates = results;
    selectedCandidate = results[0] ?? null;
    if (calcRouteBtn) calcRouteBtn.disabled = selectedCandidate === null;
    if (plannerStatusEl) {
      plannerStatusEl.textContent =
        results.length > 0
          ? `Found ${results.length} result(s). Tap a destination below, then tap Calculate & Send Route.`
          : `No matching places found for "${q}".`;
    }
    renderCandidates();
  } catch (err) {
    const fallback = await offlineGeocoder.search(q, { limit: 5 });
    candidates = fallback;
    selectedCandidate = fallback[0] ?? null;
    if (calcRouteBtn) calcRouteBtn.disabled = selectedCandidate === null;
    if (plannerStatusEl) {
      plannerStatusEl.textContent =
        fallback.length > 0
          ? `Online search unavailable; showing ${fallback.length} offline VN match(es).`
          : err instanceof Error
            ? err.message
            : "Search failed.";
    }
    renderCandidates();
  }
}

async function calculateAndSendRoute(
  originOverride?: RoutePoint,
  destCandidate: GeocodingCandidate | null = selectedCandidate,
  isReroute = false,
) {
  if (!destCandidate || isCalculatingRoute) return;
  isCalculatingRoute = true;
  const origin = originOverride ?? client.getLatestPosition() ?? DEFAULT_ORIGIN;
  const { router } = getActiveProviders();
  if (plannerStatusEl) {
    plannerStatusEl.textContent = isReroute
      ? `Off-route detected! Recalculating route to ${destCandidate.name}...`
      : `Calculating route from (${origin.latitude.toFixed(4)}, ${origin.longitude.toFixed(4)}) to ${destCandidate.name}...`;
  }
  try {
    const route = await router.calculateRoute({
      origin,
      destination: destCandidate.location,
    });
    client.setCalculatedRoute(route, destCandidate.name);
    if (plannerStatusEl) {
      plannerStatusEl.textContent = `Route active on iPhone & sent to HUD: ${destCandidate.name} (${Math.round(route.totalDistanceMeters)} m, ${route.steps.length} steps).`;
    }
  } catch {
    try {
      const fallbackRoute = await offlineRouter.calculateRoute({
        origin,
        destination: destCandidate.location,
      });
      client.setCalculatedRoute(fallbackRoute, destCandidate.name);
      if (plannerStatusEl) {
        plannerStatusEl.textContent = `Online OSRM unreachable; using offline route to ${destCandidate.name} (${Math.round(fallbackRoute.totalDistanceMeters)} m).`;
      }
    } catch (innerErr) {
      if (plannerStatusEl) {
        plannerStatusEl.textContent =
          innerErr instanceof Error ? innerErr.message : "Route calculation failed.";
      }
    }
  } finally {
    isCalculatingRoute = false;
  }
}

searchBtn?.addEventListener("click", () => void handleSearch());
searchInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void handleSearch();
  }
});

calcRouteBtn?.addEventListener("click", () => void calculateAndSendRoute());
clearRouteBtn?.addEventListener("click", () => {
  client.setCalculatedRoute(null);
  if (plannerStatusEl) plannerStatusEl.textContent = "Route cleared.";
});
