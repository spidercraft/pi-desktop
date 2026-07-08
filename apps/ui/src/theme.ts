/**
 * Theme management: presets defined in @pi-desktop/ui-kit/tokens.css plus
 * per-color user overrides, persisted in localStorage and applied as inline
 * CSS custom properties on <html> (inline wins over the preset rules).
 */

export const PRESETS = [
  { id: "claude-dark", label: "Claude Dark", swatch: ["#262624", "#d97757"] },
  { id: "claude-light", label: "Claude Light", swatch: ["#faf9f5", "#c96442"] },
  { id: "midnight", label: "Midnight", swatch: ["#101014", "#7aa2f7"] },
  { id: "graphite", label: "Graphite", swatch: ["#0d0d0d", "#10a37f"] },
] as const;

export type PresetId = (typeof PRESETS)[number]["id"];

/** Base tokens the user may override (derived tokens follow automatically). */
export const COLOR_KEYS = [
  { key: "accent", cssVar: "--pd-accent", label: "Accent" },
  { key: "bg", cssVar: "--pd-bg", label: "Background" },
  { key: "surface", cssVar: "--pd-surface", label: "Surface" },
  { key: "text", cssVar: "--pd-text", label: "Text" },
] as const;

export type ColorKey = (typeof COLOR_KEYS)[number]["key"];

export interface ThemeSettings {
  preset: PresetId;
  overrides: Partial<Record<ColorKey, string>>;
}

const STORAGE_KEY = "pi-desktop.theme";
const DEFAULT: ThemeSettings = { preset: "claude-dark", overrides: {} };

export function loadTheme(): ThemeSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT;
    const parsed = JSON.parse(raw) as Partial<ThemeSettings>;
    const preset = PRESETS.some((p) => p.id === parsed.preset)
      ? (parsed.preset as PresetId)
      : DEFAULT.preset;
    return { preset, overrides: parsed.overrides ?? {} };
  } catch {
    return DEFAULT;
  }
}

export function applyTheme(theme: ThemeSettings): void {
  const root = document.documentElement;
  root.dataset.theme = theme.preset;
  for (const { key, cssVar } of COLOR_KEYS) {
    const value = theme.overrides[key];
    if (value) root.style.setProperty(cssVar, value);
    else root.style.removeProperty(cssVar);
  }
}

export function saveTheme(theme: ThemeSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
  } catch {
    /* storage unavailable — theme still applies for this session */
  }
  applyTheme(theme);
}

/** Read the current computed value of a base token (for color inputs). */
export function currentColor(cssVar: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  return normalizeToHex(value) ?? "#000000";
}

function normalizeToHex(color: string): string | undefined {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  const m = color.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`;
  return undefined;
}
