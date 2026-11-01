import { useCallback, useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { CalculatedRoute, GPSStatus, RoutePoint } from "@w-map/navigation-core";

export interface InteractivePlanningMapProps {
  currentPosition: RoutePoint | null;
  gpsStatus: GPSStatus;
  destination: RoutePoint | null;
  route: CalculatedRoute | null;
  /** Optional fallback route polyline (e.g., streamed from iPhone Brain when no PC route override is active). */
  fallbackRoutePoints?: readonly RoutePoint[];
  activeStepIndex: number;
  onSelectDestination: (point: RoutePoint) => void;
}

const DEFAULT_CENTER: RoutePoint = { latitude: 21.0285, longitude: 105.8542 }; // Hanoi center fallback
const DEFAULT_ZOOM = 15;
const FALLBACK_VIEWPORT_WIDTH = 640;
const FALLBACK_VIEWPORT_HEIGHT = 420;

export function isValidRoutePoint(pt: unknown): pt is RoutePoint {
  if (typeof pt !== "object" || pt === null) return false;
  const { latitude, longitude } = pt as Record<string, unknown>;
  return (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

export function InteractivePlanningMap({
  currentPosition,
  gpsStatus,
  destination,
  route,
  fallbackRoutePoints,
  activeStepIndex,
  onSelectDestination,
}: InteractivePlanningMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const svgRendererRef = useRef<L.SVG | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const onSelectRef = useRef(onSelectDestination);
  onSelectRef.current = onSelectDestination;

  const lastFittedRouteIdRef = useRef<string | null>(null);
  const hasCenteredInitialGpsRef = useRef<boolean>(false);

  const [mapInitCount, setMapInitCount] = useState(0);
  const [fitBoundsCount, setFitBoundsCount] = useState(0);
  const [recenterCount, setRecenterCount] = useState(0);
  const [zoomLevel, setZoomLevel] = useState(DEFAULT_ZOOM);
  const [viewCenter, setViewCenter] = useState<RoutePoint>(
    currentPosition ?? destination ?? DEFAULT_CENTER,
  );

  const activeGeometry =
    route && route.geometry.length >= 2
      ? route.geometry
      : fallbackRoutePoints && fallbackRoutePoints.length >= 2
        ? fallbackRoutePoints
        : null;

  // Initialize Leaflet map instance ONCE on mount — never recreate on GPS updates
  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;

    const initialCenter = currentPosition ?? destination ?? DEFAULT_CENTER;
    const map = L.map(el, {
      center: [initialCenter.latitude, initialCenter.longitude],
      zoom: DEFAULT_ZOOM,
      zoomControl: false,
      attributionControl: true,
      preferCanvas: false,
      zoomAnimation: false,
      fadeAnimation: false,
      markerZoomAnimation: false,
    });

    // In headless test environments (jsdom) where layout dimensions remain 0x0, provide a fallback viewport size
    // while using real container dimensions whenever the browser has laid out the element.
    const origGetSize = map.getSize.bind(map);
    map.getSize = () => {
      const actual = origGetSize();
      if (actual.x > 0 && actual.y > 0) return actual;
      return new L.Point(FALLBACK_VIEWPORT_WIDTH, FALLBACK_VIEWPORT_HEIGHT);
    };

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      subdomains: ["a", "b", "c"],
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors (ODbL)',
    }).addTo(map);

    const svgRenderer = L.svg({ padding: 0.5 });
    svgRenderer.addTo(map);
    const layerGroup = L.layerGroup().addTo(map);

    const svgEl = (svgRenderer as unknown as { _container?: SVGSVGElement })._container;

    const emitValidatedDestination = (lat: number, lng: number) => {
      const candidate: RoutePoint = {
        latitude: Number(lat.toFixed(6)),
        longitude: Number(lng.toFixed(6)),
      };
      if (isValidRoutePoint(candidate)) {
        onSelectRef.current(candidate);
      }
    };

    map.on("click", (ev: L.LeafletMouseEvent) => {
      if (ev.originalEvent) {
        (ev.originalEvent as MouseEvent & { _wmapHandled?: boolean })._wmapHandled = true;
      }
      emitValidatedDestination(ev.latlng.lat, ev.latlng.lng);
    });

    map.on("moveend zoomend", () => {
      const c = map.getCenter();
      setViewCenter({
        latitude: Number(c.lat.toFixed(5)),
        longitude: Number(c.lng.toFixed(5)),
      });
      setZoomLevel(map.getZoom());
    });

    if (svgEl) {
      svgEl.setAttribute("data-testid", "planning-map-svg");
      svgEl.setAttribute("role", "application");
      svgEl.setAttribute("aria-label", "Interactive route planning map");
      svgEl.style.pointerEvents = "auto";
    }

    el.addEventListener("click", (ev: MouseEvent) => {
      if ((ev as MouseEvent & { _wmapHandled?: boolean })._wmapHandled) return;
      if ((ev.target as HTMLElement | null)?.closest(".leaflet-control")) return;
      const rect = el.getBoundingClientRect();
      const localX = ev.clientX - rect.left;
      const localY = ev.clientY - rect.top;
      const latLng = map.containerPointToLatLng(L.point(localX, localY));
      emitValidatedDestination(latLng.lat, latLng.lng);
    });

    mapRef.current = map;
    svgRendererRef.current = svgRenderer;
    layerGroupRef.current = layerGroup;
    setMapInitCount((c) => c + 1);

    // Ensure Leaflet recalculates tile coverage once the full browser container width is laid out
    const rafId =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(() => {
            map.invalidateSize({ animate: false });
          })
        : null;

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            map.invalidateSize({ animate: false });
          })
        : null;
    resizeObserver?.observe(el);

    return () => {
      if (rafId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      }
      resizeObserver?.disconnect();
      map.remove();
      mapRef.current = null;
      svgRendererRef.current = null;
      layerGroupRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFitRoute = useCallback(() => {
    const map = mapRef.current;
    if (!map || !activeGeometry || activeGeometry.length < 2) return;
    const validPts = activeGeometry.filter(isValidRoutePoint);
    if (validPts.length < 2) return;
    const bounds = L.latLngBounds(validPts.map((pt) => [pt.latitude, pt.longitude] as [number, number]));
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [36, 36], maxZoom: 17, animate: false });
      const c = map.getCenter();
      setViewCenter({ latitude: Number(c.lat.toFixed(5)), longitude: Number(c.lng.toFixed(5)) });
      setZoomLevel(map.getZoom());
      setFitBoundsCount((n) => n + 1);
    }
  }, [activeGeometry]);

  const handleRecenterGps = useCallback(() => {
    const map = mapRef.current;
    if (!map || !currentPosition || !isValidRoutePoint(currentPosition)) return;
    map.setView([currentPosition.latitude, currentPosition.longitude], Math.max(map.getZoom(), 15), {
      animate: false,
    });
    setViewCenter({
      latitude: Number(currentPosition.latitude.toFixed(5)),
      longitude: Number(currentPosition.longitude.toFixed(5)),
    });
    setRecenterCount((n) => n + 1);
  }, [currentPosition]);

  // Center once when the first valid GPS position arrives and no route is active yet
  useEffect(() => {
    const map = mapRef.current;
    if (!map || hasCenteredInitialGpsRef.current) return;
    if (currentPosition && isValidRoutePoint(currentPosition)) {
      hasCenteredInitialGpsRef.current = true;
      if (!activeGeometry) {
        map.setView([currentPosition.latitude, currentPosition.longitude], map.getZoom(), { animate: false });
        setViewCenter({
          latitude: Number(currentPosition.latitude.toFixed(5)),
          longitude: Number(currentPosition.longitude.toFixed(5)),
        });
      }
    }
  }, [currentPosition, activeGeometry]);

  // Auto-fit map bounds whenever a new route is calculated
  useEffect(() => {
    if (!route || route.geometry.length < 2) {
      if (!route) lastFittedRouteIdRef.current = null;
      return;
    }
    if (lastFittedRouteIdRef.current !== route.routeId) {
      lastFittedRouteIdRef.current = route.routeId;
      handleFitRoute();
    }
  }, [route, handleFitRoute]);

  // Imperatively update route polyline, maneuver ring, GPS marker, and destination pin without recreating the map
  useEffect(() => {
    const layerGroup = layerGroupRef.current;
    const svgRenderer = svgRendererRef.current;
    if (!layerGroup || !svgRenderer) return;

    layerGroup.clearLayers();

    if (activeGeometry && activeGeometry.length >= 2) {
      const validCoords = activeGeometry
        .filter(isValidRoutePoint)
        .map((pt) => [pt.latitude, pt.longitude] as [number, number]);

      if (validCoords.length >= 2) {
        L.polyline(validCoords, {
          renderer: svgRenderer,
          color: "#082f49",
          weight: 9,
          opacity: 0.78,
          lineCap: "round",
          lineJoin: "round",
          interactive: false,
        }).addTo(layerGroup);

        const routeLine = L.polyline(validCoords, {
          renderer: svgRenderer,
          color: "#2ea8ff",
          weight: 5,
          opacity: 0.96,
          lineCap: "round",
          lineJoin: "round",
          interactive: false,
        }).addTo(layerGroup);

        const routeEl = routeLine.getElement();
        if (routeEl) {
          routeEl.setAttribute("data-testid", "planning-map-route");
          routeEl.setAttribute("data-point-count", String(validCoords.length));
        }
      }
    }

    const activeManeuver = route?.steps[activeStepIndex]?.maneuverLocation ?? null;
    if (activeManeuver && isValidRoutePoint(activeManeuver)) {
      const manMarker = L.circleMarker([activeManeuver.latitude, activeManeuver.longitude], {
        renderer: svgRenderer,
        radius: 8,
        color: "#f5a524",
        weight: 2.5,
        fillColor: "#f5a524",
        fillOpacity: 0.25,
        interactive: false,
      }).addTo(layerGroup);
      manMarker.getElement()?.setAttribute("data-testid", "planning-map-maneuver");
    }

    if (currentPosition && isValidRoutePoint(currentPosition)) {
      const gpsColor = gpsStatus === "ACTIVE" ? "#34d399" : "#f5a524";
      L.circleMarker([currentPosition.latitude, currentPosition.longitude], {
        renderer: svgRenderer,
        radius: 13,
        color: gpsColor,
        weight: 1.5,
        fillColor: gpsColor,
        fillOpacity: 0.22,
        interactive: false,
      }).addTo(layerGroup);

      const origMarker = L.circleMarker([currentPosition.latitude, currentPosition.longitude], {
        renderer: svgRenderer,
        radius: 6,
        color: "#0b0f16",
        weight: 2,
        fillColor: gpsColor,
        fillOpacity: 1,
        interactive: false,
      }).addTo(layerGroup);

      const origEl = origMarker.getElement();
      if (origEl) {
        origEl.setAttribute("data-testid", "planning-map-origin");
        origEl.setAttribute("data-gps", gpsStatus);
        origEl.setAttribute("data-lat", String(currentPosition.latitude));
        origEl.setAttribute("data-lon", String(currentPosition.longitude));
      }
    }

    if (destination && isValidRoutePoint(destination)) {
      L.circleMarker([destination.latitude, destination.longitude], {
        renderer: svgRenderer,
        radius: 12,
        color: "#ff5a5f",
        weight: 1.5,
        fillColor: "#ff5a5f",
        fillOpacity: 0.22,
        interactive: false,
      }).addTo(layerGroup);

      const destMarker = L.circleMarker([destination.latitude, destination.longitude], {
        renderer: svgRenderer,
        radius: 7,
        color: "#ffffff",
        weight: 2,
        fillColor: "#ff5a5f",
        fillOpacity: 1,
        interactive: false,
      }).addTo(layerGroup);

      const destEl = destMarker.getElement();
      if (destEl) {
        destEl.setAttribute("data-testid", "planning-map-destination");
        destEl.setAttribute("data-lat", String(destination.latitude));
        destEl.setAttribute("data-lon", String(destination.longitude));
      }
    }
  }, [currentPosition, gpsStatus, destination, route, activeGeometry, activeStepIndex]);

  const handleZoomIn = () => {
    const map = mapRef.current;
    if (!map) return;
    map.setZoom(Math.min(19, map.getZoom() + 1), { animate: false });
  };

  const handleZoomOut = () => {
    const map = mapRef.current;
    if (!map) return;
    map.setZoom(Math.max(3, map.getZoom() - 1), { animate: false });
  };

  return (
    <div
      className="planning-map-box"
      data-testid="planning-map-container"
      data-map-init-count={mapInitCount}
      data-fit-bounds-count={fitBoundsCount}
      data-recenter-count={recenterCount}
      data-zoom={zoomLevel}
    >
      <div className="planning-map-toolbar">
        <span className="panel-note" data-testid="planning-map-coords">
          Click/tap map to set destination · Center: ({viewCenter.latitude.toFixed(4)},{" "}
          {viewCenter.longitude.toFixed(4)}) · Zoom z{zoomLevel}
        </span>
        <div className="map-zoom-btns" role="group" aria-label="Planning map controls">
          <button
            type="button"
            aria-label="Zoom in map"
            data-testid="map-zoom-in-btn"
            onClick={handleZoomIn}
          >
            +
          </button>
          <button
            type="button"
            aria-label="Zoom out map"
            data-testid="map-zoom-out-btn"
            onClick={handleZoomOut}
          >
            −
          </button>
          <button
            type="button"
            aria-label="Center map on current position"
            data-testid="map-recenter-gps-btn"
            disabled={!currentPosition}
            onClick={handleRecenterGps}
          >
            Recenter GPS
          </button>
          <button
            type="button"
            aria-label="Fit entire route"
            data-testid="map-fit-route-btn"
            disabled={!activeGeometry || activeGeometry.length < 2}
            onClick={handleFitRoute}
          >
            Fit Route
          </button>
        </div>
      </div>

      <div className="planning-map-viewport-wrapper">
        <div
          ref={containerRef}
          className="planning-map-viewport"
          data-testid="planning-map-leaflet"
        />
        <div className="planning-map-legend" aria-hidden="true">
          <span className="legend-item">
            <span
              className="legend-dot"
              style={{ background: gpsStatus === "ACTIVE" ? "#34d399" : "#f5a524" }}
            />
            GPS ({gpsStatus})
          </span>
          <span className="legend-item">
            <span className="legend-dot" style={{ background: "#ff5a5f" }} />
            Destination
          </span>
          <span className="legend-item">
            <span className="legend-line" style={{ background: "#2ea8ff" }} />
            Route
          </span>
        </div>
      </div>
    </div>
  );
}
