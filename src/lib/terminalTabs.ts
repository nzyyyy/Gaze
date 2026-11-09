import { PALETTES, type ColorScheme } from "./colorSchemes";

export interface TerminalTab {
  id: string;
  projectId: string | null;
  title: string;
  shell: string;
  exited: boolean;
  exitCode: number | null;
}

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export function shellName(shell: string): string {
  const base = shell.split(/[\\/]/).pop() ?? shell;
  return base.toLowerCase().endsWith(".exe") ? base.slice(0, -4) : base;
}

export function nextTerminalTitle(tabs: TerminalTab[], shell: string): string {
  const base = shellName(shell) || "终端";
  const used = new Set(tabs.map((tab) => tab.title));
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

// 标签显示当前目录的文件夹名；OSC 7 与 OSC 633 都会上报这个路径。
export function folderName(path: string): string | null {
  if (!path) return null;
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) return "/";
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || null;
}

// OSC 7：一般为 file://<host>/<path>，个别 shell 直接发送裸路径。
export function parseOsc7Cwd(payload: string): string | null {
  const value = payload.trim();
  if (!value) return null;
  if (!value.startsWith("file://")) return value.startsWith("/") ? value : null;
  try {
    const url = new URL(value);
    return decodeURIComponent(url.pathname) || null;
  } catch {
    return null;
  }
}

// OSC 633：VS Code 风格的 Shell Integration，目录放在 633;P;Cwd=<path>。
export function parseOsc633Cwd(payload: string): string | null {
  for (const part of payload.split(";")) {
    if (part.startsWith("Cwd=")) return part.slice(4) || null;
  }
  return null;
}

export function removeTerminal(
  tabs: TerminalTab[],
  activeId: string | null,
  closingId: string,
): { tabs: TerminalTab[]; activeId: string | null } {
  const remaining = tabs.filter((tab) => tab.id !== closingId);
  if (activeId !== closingId) return { tabs: remaining, activeId };
  const index = tabs.findIndex((tab) => tab.id === closingId);
  const fallback = remaining[Math.min(index, remaining.length - 1)] ?? null;
  return { tabs: remaining, activeId: fallback?.id ?? null };
}

// Keep the Alucard ANSI colors; match the reading surface and keep ANSI black visible.
const LIGHT_THEME: TerminalTheme = {
  background: PALETTES.original.light.background,
  foreground: "#1f1f1f",
  cursor: "#1f1f1f",
  cursorAccent: PALETTES.original.light.background,
  selectionBackground: "#cfcfde",
  black: "#1f1f1f",
  red: "#cb3a2a",
  green: "#14710a",
  yellow: "#846e15",
  blue: "#644ac9",
  magenta: "#a3144d",
  cyan: "#036a96",
  white: "#1f1f1f",
  brightBlack: "#6c664b",
  brightRed: "#d23b2b",
  brightGreen: "#18850b",
  brightYellow: "#877016",
  brightBlue: "#7862d0",
  brightMagenta: "#bf185a",
  brightCyan: "#047aae",
  brightWhite: "#2c2b31",
};

// Keep the existing Dracula ANSI colors on Gaze's shared dark surface.
const DARK_THEME: TerminalTheme = {
  background: PALETTES.original.dark.background,
  foreground: "#e6e6e6",
  cursor: "#bbbbbb",
  cursorAccent: PALETTES.original.dark.background,
  selectionBackground: "#44475a",
  black: "#000000",
  red: "#ff5555",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  blue: "#bd93f9",
  magenta: "#ff79c6",
  cyan: "#8be9fd",
  white: "#bbbbbb",
  brightBlack: "#555555",
  brightRed: "#ff5555",
  brightGreen: "#50fa7b",
  brightYellow: "#f1fa8c",
  brightBlue: "#bd93f9",
  brightMagenta: "#ff79c6",
  brightCyan: "#8be9fd",
  brightWhite: "#ffffff",
};

export function terminalTheme(dark: boolean, scheme: ColorScheme = "original"): TerminalTheme {
  if (scheme === "original") return dark ? DARK_THEME : LIGHT_THEME;
  const p = PALETTES[scheme][dark ? "dark" : "light"];
  return {
    background: p.background,
    foreground: p.text,
    cursor: p.text,
    cursorAccent: p.background,
    selectionBackground: p.border,
    black: dark ? p.sidebar : p.text,
    brightBlack: p.faint,
    red: p.red,
    brightRed: p.red,
    green: p.green,
    brightGreen: p.green,
    yellow: p.yellow,
    brightYellow: p.yellow,
    blue: p.accent,
    brightBlue: p.accent,
    magenta: p.magenta,
    brightMagenta: p.magenta,
    cyan: p.cyan,
    brightCyan: p.cyan,
    white: dark ? p.muted : p.raised,
    brightWhite: dark ? p.text : p.background,
  };
}
