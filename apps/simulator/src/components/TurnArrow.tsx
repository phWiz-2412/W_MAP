import type { TurnDirection } from "@w-map/navigation-core";

export const TURN_LABELS: Record<TurnDirection, string> = {
  LEFT: "Turn left",
  RIGHT: "Turn right",
  STRAIGHT: "Continue straight",
  U_TURN: "Make a U-turn",
};

/** Format a distance for the display. null → "--". */
export function formatDistance(meters: number | null): string {
  if (meters === null) return "--";
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

/** Maneuver arrow drawn around (0,0), roughly 80x80 units. */
export function TurnArrow({ direction, color = "#ffffff" }: { direction: TurnDirection; color?: string }) {
  const stroke = { fill: "none", stroke: color, strokeWidth: 10, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <g data-testid="turn-arrow" data-direction={direction} role="img" aria-label={TURN_LABELS[direction]}>
      <title>{TURN_LABELS[direction]}</title>
      {direction === "STRAIGHT" && (
        <>
          <path d="M0 36 V-12" {...stroke} />
          <polygon points="-18,-10 0,-36 18,-10" fill={color} />
        </>
      )}
      {direction === "RIGHT" && (
        <>
          <path d="M-14 36 V4 Q-14 -14 4 -14 H12" {...stroke} />
          <polygon points="10,-34 36,-14 10,6" fill={color} />
        </>
      )}
      {direction === "LEFT" && (
        <g transform="scale(-1 1)">
          <path d="M-14 36 V4 Q-14 -14 4 -14 H12" {...stroke} />
          <polygon points="10,-34 36,-14 10,6" fill={color} />
        </g>
      )}
      {direction === "U_TURN" && (
        <>
          <path d="M16 36 V-8 Q16 -32 -4 -32 Q-24 -32 -24 -8 V8" {...stroke} />
          <polygon points="-42,6 -6,6 -24,32" fill={color} />
        </>
      )}
    </g>
  );
}
