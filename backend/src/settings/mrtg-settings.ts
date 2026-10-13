export type MrtgStyle = {
  colorIn: string;
  colorOut: string;
  colorThreshold: string;
  colorProbe: string;
  colorLoss: string;
  thresholdPct: number;
};

export const mrtgDefaults: MrtgStyle = {
  colorIn: '#1f8a3b',
  colorOut: '#1d4e89',
  colorThreshold: '#c42318',
  colorProbe: '#1f8a3b',
  colorLoss: '#b45309',
  thresholdPct: 95,
};

export const mrtgSettingKeys = [
  'mrtg_color_in',
  'mrtg_color_out',
  'mrtg_color_threshold',
  'mrtg_color_probe',
  'mrtg_color_loss',
  'mrtg_threshold_pct',
] as const;

export function readMrtgStyle(map: Record<string, string | undefined>): MrtgStyle {
  return {
    colorIn: color(map.mrtg_color_in, mrtgDefaults.colorIn),
    colorOut: color(map.mrtg_color_out, mrtgDefaults.colorOut),
    colorThreshold: color(map.mrtg_color_threshold, mrtgDefaults.colorThreshold),
    colorProbe: color(map.mrtg_color_probe, mrtgDefaults.colorProbe),
    colorLoss: color(map.mrtg_color_loss, mrtgDefaults.colorLoss),
    thresholdPct: whole(map.mrtg_threshold_pct, mrtgDefaults.thresholdPct, 1, 100),
  };
}

export function mrtgSettingEntries(style: MrtgStyle) {
  return {
    mrtg_color_in: style.colorIn,
    mrtg_color_out: style.colorOut,
    mrtg_color_threshold: style.colorThreshold,
    mrtg_color_probe: style.colorProbe,
    mrtg_color_loss: style.colorLoss,
    mrtg_threshold_pct: String(style.thresholdPct),
  };
}

export function shareOfMax(max: number | null, percent: number) {
  if (max == null || Number.isNaN(max)) return null;
  return (max * percent) / 100;
}

export function billableUsage(inboundMax: number | null, outboundMax: number | null, percent: number) {
  if (inboundMax == null && outboundMax == null) return null;
  return shareOfMax(Math.max(inboundMax ?? 0, outboundMax ?? 0), percent);
}

function color(value: string | undefined, fallback: string) {
  return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback;
}

function whole(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}
