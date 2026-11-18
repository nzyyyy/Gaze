import type { Mermaid } from "mermaid";

type ThemeName = "default" | "dark";

let loading: Promise<Mermaid> | null = null;
let appliedTheme: ThemeName | null = null;
let sequence = 0;

function currentTheme(): ThemeName {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "default";
}

async function loadMermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then(({ default: mermaid }) => mermaid);
  return loading;
}

export async function renderMermaid(code: string): Promise<string> {
  const mermaid = await loadMermaid();
  const theme = currentTheme();
  if (theme !== appliedTheme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme,
      fontFamily: "var(--font-ui)",
    });
    appliedTheme = theme;
  }
  const id = `gaze-mermaid-${++sequence}`;
  try {
    return (await mermaid.render(id, code)).svg;
  } finally {
    // Mermaid leaves its scratch element behind when parsing fails.
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(id)?.remove();
  }
}
