export const DISPLAY_EVENT = 'display-changed';
export const MUTE_EVENT = 'mute-changed';

export type ThemeMode = 'light' | 'dark' | 'system';

export function readTheme(): ThemeMode {
  const value = localStorage.getItem('theme');
  if (value === 'dark' || value === 'light' || value === 'system') return value;
  return 'light';
}

export function readRefreshSeconds() {
  const value = Number(localStorage.getItem('refreshSeconds'));
  if (!Number.isFinite(value)) return 15;
  return Math.min(120, Math.max(5, Math.round(value)));
}

export function readAnimations() {
  return localStorage.getItem('animations') !== '0';
}

export function readCompact() {
  return localStorage.getItem('density') === 'compact';
}

export function readMuted() {
  return sessionStorage.getItem('mute') === '1';
}

export function applyDisplay() {
  const theme = readTheme();
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.motion = readAnimations() ? 'on' : 'off';
  document.documentElement.dataset.density = readCompact() ? 'compact' : 'comfortable';
}

export function saveDisplay(partial: {
  theme?: ThemeMode;
  refreshSeconds?: number;
  animations?: boolean;
  compact?: boolean;
}) {
  if (partial.theme) localStorage.setItem('theme', partial.theme);
  if (partial.refreshSeconds !== undefined) localStorage.setItem('refreshSeconds', String(partial.refreshSeconds));
  if (partial.animations !== undefined) localStorage.setItem('animations', partial.animations ? '1' : '0');
  if (partial.compact !== undefined) localStorage.setItem('density', partial.compact ? 'compact' : 'comfortable');
  applyDisplay();
  window.dispatchEvent(new Event(DISPLAY_EVENT));
}

export function saveMuted(muted: boolean) {
  sessionStorage.setItem('mute', muted ? '1' : '0');
  window.dispatchEvent(new CustomEvent(MUTE_EVENT, { detail: muted }));
}
