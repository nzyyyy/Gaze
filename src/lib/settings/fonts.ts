export type FontChoice = "system" | "maple" | "consolas";

export interface FontSettings {
  ui: FontChoice;
  editor: FontChoice;
  terminal: FontChoice;
}

export const DEFAULT_FONT_SETTINGS: FontSettings = {
  ui: "system",
  editor: "maple",
  terminal: "maple",
};

const SYSTEM_FONTS = {
  ui: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "PingFang SC", sans-serif',
  editor:
    '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", "Sarasa Mono SC", Menlo, Consolas, monospace',
  terminal:
    '"DejaVu Sans Mono for Powerline", "Meslo LG M for Powerline", "MesloLGS NF", "Hack Nerd Font", "JetBrainsMono Nerd Font", "SFMono-Regular", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace',
};

export function fontStack(choice: FontChoice, area: keyof FontSettings): string {
  if (choice === "system") return SYSTEM_FONTS[area];
  const maple = `"Gaze Maple Mono", ${SYSTEM_FONTS[area]}`;
  return choice === "consolas" ? `Consolas, ${maple}` : maple;
}
