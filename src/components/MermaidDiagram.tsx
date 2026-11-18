import { useEffect, useState } from "react";

import { t, useLanguage } from "../lib/i18n";
import { renderMermaid } from "../lib/mermaid";

function useDocumentTheme(): string {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "");
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme(document.documentElement.dataset.theme ?? ""),
    );
    observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

export function MermaidDiagram({ code }: { code: string }) {
  useLanguage();
  const theme = useDocumentTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    renderMermaid(code).then(
      (next) => {
        if (!cancelled) setSvg(next);
      },
      () => {
        if (!cancelled) {
          setSvg(null);
          setFailed(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [code, theme]);

  if (failed || !svg)
    return (
      <pre className={failed ? "markdown-mermaid-fallback" : undefined}>
        <code className="language-mermaid">{code}</code>
      </pre>
    );
  return (
    <div
      className="markdown-mermaid"
      role="img"
      aria-label={t("Mermaid 图表")}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
