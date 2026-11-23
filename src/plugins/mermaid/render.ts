import type { Mermaid } from "mermaid";

type ThemeName = "default" | "dark";

let loading: Promise<Mermaid> | null = null;
let appliedTheme: ThemeName | null = null;
let sequence = 0;
let renderQueue = Promise.resolve();

function currentTheme(): ThemeName {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "default";
}

async function loadMermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then(({ default: mermaid }) => mermaid);
  return loading;
}

export function renderMermaid(code: string, signal: AbortSignal): Promise<string> {
  const result = renderQueue.then(() => renderDiagram(code, signal));
  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function renderDiagram(code: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw signal.reason;
  // Give the WebView a chance to handle input and paint between diagrams.
  await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
  if (signal.aborted) throw signal.reason;
  const mermaid = await loadMermaid();
  if (signal.aborted) throw signal.reason;
  const theme = currentTheme();
  if (theme !== appliedTheme) {
    const dark = theme === "dark";
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      themeVariables: {
        darkMode: dark,
        background: dark ? "#24262c" : "#fcfcfd",
        primaryColor: dark ? "#253648" : "#eaf3ff",
        primaryTextColor: dark ? "#e5e6ea" : "#272930",
        primaryBorderColor: dark ? "#597799" : "#8baed3",
        secondaryColor: dark ? "#233133" : "#eaf5f0",
        tertiaryColor: dark ? "#272b33" : "#f1f3f7",
        clusterBkg: dark ? "#272b33" : "#f1f3f7",
        clusterBorder: dark ? "#4e5969" : "#c9d2df",
        lineColor: dark ? "#a4adb9" : "#646871",
        edgeLabelBackground: dark ? "#272b33" : "#fcfcfd",
        fontFamily: "var(--font-ui)",
        fontSize: "14px",
      },
      flowchart: { wrappingWidth: 200 },
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
