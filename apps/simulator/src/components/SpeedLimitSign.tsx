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
 * Speed-limit sign with radius-proportional typography and ring thickness.
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

  const scale = r / 27;
  const strokeWidth = Math.max(2.5, Number((5.5 * scale).toFixed(1)));
  const baseFontSize = shown.length >= 3 ? 21 : shown === "--" ? 23 : 25;
  const fontSize = Math.max(10, Math.round(baseFontSize * scale));
  const textYOffset = Math.round(fontSize * 0.35);
  const tagFontSize = Math.max(6.5, Number((8.5 * scale).toFixed(1)));
  const tagYOffset = Math.round(r + tagFontSize + 2);
  const dashPattern = dashed ? `${Math.max(2.5, Number((4.5 * scale).toFixed(1)))} ${Math.max(2, Number((3.5 * scale).toFixed(1)))}` : undefined;

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
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill={face}
        stroke={ring}
        strokeWidth={strokeWidth}
        strokeDasharray={dashPattern}
      />
      <text
        x={cx}
        y={cy + textYOffset}
        textAnchor="middle"
        fontSize={fontSize}
        fontWeight={800}
        fill={text}
        data-testid="limit-value"
      >
        {shown}
      </text>
      <text
        x={cx}
        y={cy + tagYOffset}
        textAnchor="middle"
        fontSize={tagFontSize}
        fontWeight={700}
        fill={ring}
        data-testid="limit-tag"
      >
        {tag}
      </text>
    </g>
  );
}
