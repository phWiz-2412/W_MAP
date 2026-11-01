import {
  useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  fromLocalMeters,
  toLocalMeters,
  type CalculatedRoute,
  type GPSStatus,
  type RoutePoint,
} from "@w-map/navigation-core";

interface Props {
  currentPosition: RoutePoint | null;
  gpsStatus: GPSStatus;
  destination: RoutePoint | null;
  route: CalculatedRoute | null;
  activeStepIndex: number;
  onSelectDestination: (point: RoutePoint) => void;
}

const DEFAULT_CENTER: RoutePoint = { latitude: 21.0285, longitude: 105.8542 }; // Hanoi center fallback
const VIEW_WIDTH = 360;
const VIEW_HEIGHT = 240;

export function InteractivePlanningMap({
  currentPosition,
  gpsStatus,
  destination,
  route,
  activeStepIndex,
  onSelectDestination,
}: Props) {
  const [metersPerPixel, setMetersPerPixel] = useState(8); // ~2.8 km across 360px
  const [panEastMeters, setPanEastMeters] = useState(0);
  const [panNorthMeters, setPanNorthMeters] = useState(0);
  const [dragStart, setDragStart] = useState<{ x: number; y: number; moved: boolean } | null>(null);

  const baseOrigin = currentPosition ?? destination ?? DEFAULT_CENTER;
  const viewCenter = fromLocalMeters(baseOrigin, panEastMeters, panNorthMeters);

  const toScreen = (p: RoutePoint): [number, number] => {
    const { east, north } = toLocalMeters(viewCenter, p);
    return [VIEW_WIDTH / 2 + east / metersPerPixel, VIEW_HEIGHT / 2 - north / metersPerPixel];
  };

  const toGeo = (x: number, y: number): RoutePoint => {
    const east = (x - VIEW_WIDTH / 2) * metersPerPixel;
    const north = (VIEW_HEIGHT / 2 - y) * metersPerPixel;
    return fromLocalMeters(viewCenter, east, north);
  };

  const handleSvgClick = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (dragStart?.moved) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = rect.width > 0 ? VIEW_WIDTH / rect.width : 1;
    const scaleY = rect.height > 0 ? VIEW_HEIGHT / rect.height : 1;
    const svgX = (e.clientX - rect.left) * scaleX;
    const svgY = (e.clientY - rect.top) * scaleY;
    const geo = toGeo(svgX, svgY);
    onSelectDestination({
      latitude: Number(geo.latitude.toFixed(6)),
      longitude: Number(geo.longitude.toFixed(6)),
    });
  };

  const handleMouseDown = (e: ReactMouseEvent<SVGSVGElement>) => {
    setDragStart({ x: e.clientX, y: e.clientY, moved: false });
  };

  const handleMouseMove = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (!dragStart) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (Math.hypot(dx, dy) > 4) {
      setPanEastMeters((prev) => prev - dx * metersPerPixel);
      setPanNorthMeters((prev) => prev + dy * metersPerPixel);
      setDragStart({ x: e.clientX, y: e.clientY, moved: true });
    }
  };

  const handleMouseUp = () => {
    setTimeout(() => setDragStart(null), 0);
  };

  const handleWheel = (e: ReactWheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.25 : 0.8;
    setMetersPerPixel((m) => Math.min(80, Math.max(1, Number((m * factor).toFixed(2)))));
  };

  const routeSvgPath =
    route && route.geometry.length >= 2
      ? route.geometry
          .map((pt, i) => {
            const [x, y] = toScreen(pt);
            return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
          })
          .join(" ")
      : null;

  const activeManeuver = route?.steps[activeStepIndex]?.maneuverLocation ?? null;
  const gridSpacingPx = 45;
  const scaleBarMeters = Math.round(gridSpacingPx * metersPerPixel);

  return (
    <div className="planning-map-box" data-testid="planning-map-container">
      <div className="planning-map-toolbar">
        <span className="panel-note">
          Click/tap map to set destination · Scale: {scaleBarMeters} m/grid
        </span>
        <div className="map-zoom-btns" role="group" aria-label="Planning map controls">
          <button
            type="button"
            aria-label="Zoom in map"
            onClick={() => setMetersPerPixel((m) => Math.max(1, Number((m * 0.65).toFixed(2))))}
          >
            +
          </button>
          <button
            type="button"
            aria-label="Zoom out map"
            onClick={() => setMetersPerPixel((m) => Math.min(80, Number((m * 1.5).toFixed(2))))}
          >
            −
          </button>
          <button
            type="button"
            aria-label="Center map on current position"
            onClick={() => {
              setPanEastMeters(0);
              setPanNorthMeters(0);
            }}
          >
            Center
          </button>
        </div>
      </div>

      <svg
        className="planning-map-svg"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        role="application"
        aria-label="Interactive route planning map"
        data-testid="planning-map-svg"
        onClick={handleSvgClick}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
      >
        <rect x={0} y={0} width={VIEW_WIDTH} height={VIEW_HEIGHT} fill="#0b0f16" />

        {/* Coordinate grid lines */}
        {[45, 90, 135, 180, 225, 270, 315].map((x) => (
          <line key={`gx-${x}`} x1={x} y1={0} x2={x} y2={VIEW_HEIGHT} stroke="#1a2230" strokeWidth={1} />
        ))}
        {[45, 90, 135, 180, 225].map((y) => (
          <line key={`gy-${y}`} x1={0} y1={y} x2={VIEW_WIDTH} y2={y} stroke="#1a2230" strokeWidth={1} />
        ))}

        {/* Calculated route polyline */}
        {routeSvgPath && (
          <path
            d={routeSvgPath}
            fill="none"
            stroke="#2ea8ff"
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
            data-testid="planning-map-route"
          />
        )}

        {/* Active maneuver highlight */}
        {activeManeuver && (
          <circle
            cx={toScreen(activeManeuver)[0]}
            cy={toScreen(activeManeuver)[1]}
            r={6}
            fill="none"
            stroke="#f5a524"
            strokeWidth={2}
            data-testid="planning-map-maneuver"
          />
        )}

        {/* Current GPS position marker */}
        {currentPosition && (
          <g
            transform={`translate(${toScreen(currentPosition)[0].toFixed(1)} ${toScreen(currentPosition)[1].toFixed(1)})`}
            data-testid="planning-map-origin"
          >
            <circle r={9} fill={gpsStatus === "ACTIVE" ? "#34d399" : "#f5a524"} opacity={0.28} />
            <circle r={5} fill={gpsStatus === "ACTIVE" ? "#34d399" : "#f5a524"} stroke="#0b0f16" strokeWidth={1.5} />
          </g>
        )}

        {/* Selected destination marker */}
        {destination && (
          <g
            transform={`translate(${toScreen(destination)[0].toFixed(1)} ${toScreen(destination)[1].toFixed(1)})`}
            data-testid="planning-map-destination"
          >
            <circle r={7} fill="#ff5a5f" stroke="#ffffff" strokeWidth={1.5} />
            <text y={-10} textAnchor="middle" fontSize={9} fontWeight={700} fill="#ff9a9a">
              DEST
            </text>
          </g>
        )}

        <text x={8} y={16} fontSize={9} fill="#8b93a1">
          N ↑ ({viewCenter.latitude.toFixed(4)}, {viewCenter.longitude.toFixed(4)})
        </text>
      </svg>
    </div>
  );
}
