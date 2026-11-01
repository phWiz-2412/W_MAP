import type { SpeedLimitStatus } from "@w-map/navigation-core";

interface Props {
  cx: number;
  cy: number;
  r: number;
  limitKmh: number | null;
  status: SpeedLimitStatus;
  /** Force the "not current" look (GPS lost / BLE disconnected). */
  inactive?: boolean;
}

/**
 * Speed-limit sign.
 *  VALID   → solid red ring, white face.
 *  STALE   → dashed amber ring, dimmed value, "OLD" tag (never shown as verified).
 *  UNKNOWN → dashed grey ring, "--", never a guessed number.
 */
export function SpeedLimitSign({ cx, cy, r, limitKmh, status, inactive = false }: Props) {
  const shown = status === "UNKNOWN" || limitKmh === null ? "--" : String(limitKmh);
  const ring = status === "VALID" ? "#e5252a" : status === "STALE" ? "#f5a524" : "#6b7280";
  const dashed = status !== "VALID";
  const face = status === "VALID" ? "#ffffff" : "#1b1f27";
  const text = status === "VALID" ? "#0b0d10" : status === "STALE" ? "#f5a524" : "#9aa3b2";
  const tag = status === "STALE" ? "OLD" : status === "UNKNOWN" ? "N/A" : "LIMIT";
  return (
    <g
      data-testid="limit-sign"
      data-status={status}
      opacity={inactive ? 0.45 : 1}
      role="img"
      aria-label={
        status === "VALID"
          ? `Speed limit ${shown} kilometres per hour`
          : status === "STALE"
            ? `Speed limit ${shown} is outdated`
            : "Speed limit unknown"
      }
    >
      <circle cx={cx} cy={cy} r={r} fill={face} stroke={ring} strokeWidth={6} strokeDasharray={dashed ? "5 4" : undefined} />
      <text x={cx} y={cy + 9} textAnchor="middle" fontSize={shown === "--" ? 24 : 26} fontWeight={800} fill={text} data-testid="limit-value">
        {shown}
      </text>
      <text x={cx} y={cy + r + 12} textAnchor="middle" fontSize={9} fontWeight={700} fill={ring} data-testid="limit-tag">
        {tag}
      </text>
    </g>
  );
}
