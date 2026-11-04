import type { ResolvedTheme } from "./types";

export type ColorScheme = "github" | "catppuccin" | "nord" | "original";
export type ColorSchemes = Record<ResolvedTheme, ColorScheme>;

export const DEFAULT_COLOR_SCHEMES: ColorSchemes = { light: "github", dark: "github" };
export const COLOR_SCHEME_NAMES: Record<ColorScheme, Record<ResolvedTheme, string>> = {
  github: { light: "GitHub Light", dark: "GitHub Dark" },
  catppuccin: { light: "Catppuccin Latte", dark: "Catppuccin Mocha" },
  nord: { light: "Nord Snow", dark: "Nord Polar Night" },
  original: { light: "Gaze 原配色", dark: "Gaze 原配色" },
};

interface Palette {
  background: string;
  sidebar: string;
  raised: string;
  text: string;
  muted: string;
  faint: string;
  border: string;
  accent: string;
  contrast: string;
  red: string;
  green: string;
  yellow: string;
  magenta: string;
  cyan: string;
}

// Adapted to Gaze's surfaces from the official Primer, Catppuccin and Nord palettes.
// https://github.com/primer/primitives · https://catppuccin.com/palette · https://www.nordtheme.com/docs/colors-and-palettes
export const PALETTES: Record<ColorScheme, Record<ResolvedTheme, Palette>> = {
  github: {
    light: {
      background: "#ffffff",
      sidebar: "#f3f4f6",
      raised: "#ffffff",
      text: "#1f2328",
      muted: "#59636e",
      faint: "#59636e",
      border: "#d1d9e0",
      accent: "#0969da",
      contrast: "#ffffff",
      red: "#cf222e",
      green: "#1a7f37",
      yellow: "#9a6700",
      magenta: "#8250df",
      cyan: "#0e6b83",
    },
    dark: {
      background: "#1f2329",
      sidebar: "#181b20",
      raised: "#2a2f38",
      text: "#e6edf3",
      muted: "#abb4c0",
      faint: "#a4adb9",
      border: "#3d444d",
      accent: "#79c0ff",
      contrast: "#0d1117",
      red: "#ff7b72",
      green: "#7ee787",
      yellow: "#d29922",
      magenta: "#d2a8ff",
      cyan: "#76e3ea",
    },
  },
  catppuccin: {
    light: {
      background: "#eff1f5",
      sidebar: "#e6e9ef",
      raised: "#ffffff",
      text: "#4c4f69",
      muted: "#5c5f77",
      faint: "#63667c",
      border: "#bcc0cc",
      accent: "#1e66f5",
      contrast: "#ffffff",
      red: "#d20f39",
      green: "#397e23",
      yellow: "#8a5800",
      magenta: "#8839ef",
      cyan: "#087f86",
    },
    dark: {
      background: "#1e1e2e",
      sidebar: "#181825",
      raised: "#313244",
      text: "#cdd6f4",
      muted: "#bac2de",
      faint: "#a6adc8",
      border: "#45475a",
      accent: "#89b4fa",
      contrast: "#1e1e2e",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      magenta: "#cba6f7",
      cyan: "#94e2d5",
    },
  },
  nord: {
    light: {
      background: "#eceff4",
      sidebar: "#e5e9f0",
      raised: "#ffffff",
      text: "#2e3440",
      muted: "#434c5e",
      faint: "#4c566a",
      border: "#b8c1cf",
      accent: "#46678f",
      contrast: "#ffffff",
      red: "#a23e4a",
      green: "#506b35",
      yellow: "#806323",
      magenta: "#855681",
      cyan: "#386a77",
    },
    dark: {
      background: "#2e3440",
      sidebar: "#272c36",
      raised: "#3b4252",
      text: "#eceff4",
      muted: "#d8dee9",
      faint: "#b8c1cf",
      border: "#4c566a",
      accent: "#88c0d0",
      contrast: "#2e3440",
      red: "#e3949c",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      magenta: "#b48ead",
      cyan: "#8fbcbb",
    },
  },
  original: {
    light: {
      background: "#fcfcfd",
      sidebar: "#f1f3f5",
      raised: "#ffffff",
      text: "#272930",
      muted: "#646871",
      faint: "#646871",
      border: "#d5d7de",
      accent: "#0969da",
      contrast: "#ffffff",
      red: "#a63c31",
      green: "#2e7d68",
      yellow: "#8c6b21",
      magenta: "#6754a3",
      cyan: "#4773a5",
    },
    dark: {
      background: "#24262c",
      sidebar: "#1c1e24",
      raised: "#30343c",
      text: "#e5e6ea",
      muted: "#b2b7c2",
      faint: "#a4adb9",
      border: "#454852",
      accent: "#79c0ff",
      contrast: "#24262c",
      red: "#e48b80",
      green: "#71bea4",
      yellow: "#d6b268",
      magenta: "#ae9bdf",
      cyan: "#82a9d5",
    },
  },
};

export function colorSchemeVariables(
  scheme: ColorScheme,
  mode: ResolvedTheme,
): Record<string, string> {
  const p = PALETTES[scheme][mode];
  const tint = (color: string, percent: number) =>
    `color-mix(in srgb, ${color} ${percent}%, transparent)`;
  const selected = (surface: string) =>
    `color-mix(in srgb, ${p.accent} ${mode === "dark" ? 24 : 12}%, ${surface})`;
  return {
    "--bg": p.background,
    "--surface": p.background,
    "--surface-raised": p.raised,
    "--sidebar": p.sidebar,
    "--sidebar-active": selected(p.sidebar),
    "--tab-active": selected(p.background),
    "--selected-inactive": `color-mix(in srgb, ${p.accent} 8%, ${p.sidebar})`,
    "--editor-bg": p.background,
    "--terminal-bg": p.background,
    "--topbar": p.sidebar,
    "--topbar-text": p.text,
    "--topbar-muted": p.muted,
    "--text": p.text,
    "--text-muted": p.muted,
    "--text-faint": p.faint,
    "--border": p.border,
    "--border-strong": p.faint,
    "--accent": p.accent,
    "--accent-strong": p.accent,
    "--accent-soft": tint(p.accent, 14),
    "--accent-contrast": p.contrast,
    "--hover": tint(p.text, 6),
    "--active-line": tint(p.text, 4),
    "--selection": tint(p.accent, 25),
    "--selection-match": tint(p.accent, 12),
    "--search-match": tint(p.yellow, 25),
    "--search-selected": tint(p.yellow, 48),
    "--bracket-match": tint(p.accent, 18),
    "--input-bg": p.raised,
    "--danger": p.red,
    "--danger-soft": tint(p.red, 10),
    "--shadow": `0 9px 30px ${tint(p.text, mode === "dark" ? 8 : 14)}`,
    "--icon-code": p.green,
    "--icon-config": p.yellow,
    "--icon-text": p.muted,
    "--icon-image": p.accent,
    "--icon-archive": p.yellow,
    "--icon-data": p.magenta,
    "--icon-shell": p.cyan,
    "--icon-folder": p.yellow,
  };
}
