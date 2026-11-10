/** Panel sizes that should survive a restart; stored per machine, not per project. */
export interface Layout {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  terminalHeight: number;
  outputHeight: number;
  editorSplitRatio: number;
  gitHistorySplitRatio: number;
}

const KEY = "gaze:layout";
export const LAYOUT_CHANGE_EVENT = "gaze:layout-change";
export const LAYOUT_SIZE_LIMITS = {
  sidebarWidth: { min: 200, max: 600 },
  terminalHeight: { min: 120, max: 1000 },
  outputHeight: { min: 96, max: 1000 },
} as const;

export const DEFAULT_LAYOUT: Layout = {
  sidebarWidth: 292,
  sidebarCollapsed: false,
  terminalHeight: 240,
  outputHeight: 170,
  editorSplitRatio: 0.5,
  gitHistorySplitRatio: 0.3,
};

export function readLayout(fallback: Partial<Layout> = {}): Layout {
  const defaults = { ...DEFAULT_LAYOUT, ...fallback };
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Layout>;
    const pick = (value: unknown, base: number) =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? value : base;
    const size = (key: keyof typeof LAYOUT_SIZE_LIMITS) => {
      const { min, max } = LAYOUT_SIZE_LIMITS[key];
      return Math.round(Math.min(max, Math.max(min, pick(stored[key], defaults[key]))));
    };
    const splitRatio = pick(stored.editorSplitRatio, defaults.editorSplitRatio);
    const historyRatio = pick(stored.gitHistorySplitRatio, defaults.gitHistorySplitRatio);
    return {
      sidebarWidth: size("sidebarWidth"),
      sidebarCollapsed:
        typeof stored.sidebarCollapsed === "boolean"
          ? stored.sidebarCollapsed
          : defaults.sidebarCollapsed,
      terminalHeight: size("terminalHeight"),
      outputHeight: size("outputHeight"),
      editorSplitRatio: splitRatio < 1 ? splitRatio : defaults.editorSplitRatio,
      gitHistorySplitRatio: historyRatio < 1 ? historyRatio : defaults.gitHistorySplitRatio,
    };
  } catch {
    return defaults;
  }
}

export function saveLayout(patch: Partial<Layout>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readLayout(), ...patch }));
    window.dispatchEvent(new Event(LAYOUT_CHANGE_EVENT));
  } catch {
    // Layout is a convenience; losing it must never break the app.
  }
}
