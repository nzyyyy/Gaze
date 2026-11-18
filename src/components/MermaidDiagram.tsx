import { Minus, Plus } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { t, useLanguage } from "../lib/i18n";
import { renderMermaid } from "../lib/mermaid";

const ZOOM_MIN = 50;
const ZOOM_MAX = 300;
const ZOOM_STEP = 25;

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

export const MermaidDiagram = memo(function MermaidDiagram({ code }: { code: string }) {
  useLanguage();
  const theme = useDocumentTheme();
  const elementRef = useRef<HTMLElement | null>(null);
  const setElement = useCallback((element: HTMLElement | null) => {
    elementRef.current = element;
  }, []);
  const [rendered, setRendered] = useState<{ code: string; svg: string | null } | null>(null);
  const [zoom, setZoom] = useState(100);
  const svg = rendered?.code === code ? rendered.svg : undefined;
  const graphic = useMemo(() => {
    if (!svg) return null;
    const viewBox = /^<svg\b[^>]*\sviewBox="([^"]+)"/.exec(svg)?.[1];
    const [, , width = 0, height = 0] =
      viewBox
        ?.trim()
        .split(/[\s,]+/)
        .map(Number) ?? [];
    const size =
      Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
        ? { width, height }
        : null;
    return { html: { __html: svg }, size };
  }, [svg]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    let observer: IntersectionObserver | undefined;
    let request: AbortController | undefined;
    let stopped = false;
    const start = () => {
      if (stopped || request) return;
      const controller = new AbortController();
      request = controller;
      const finish = (next: string | null) => {
        if (controller.signal.aborted) return;
        stopped = true;
        observer?.disconnect();
        setRendered({ code, svg: next });
      };
      void renderMermaid(code, controller.signal).then(finish, () => finish(null));
    };

    if (typeof IntersectionObserver === "undefined") start();
    else {
      observer = new IntersectionObserver(
        ([entry]) => {
          if (entry?.isIntersecting && entry.boundingClientRect.width > 0) start();
          else {
            request?.abort();
            request = undefined;
          }
        },
        { root: element.closest(".markdown-preview"), rootMargin: "240px 0px" },
      );
      observer.observe(element);
    }

    return () => {
      stopped = true;
      observer?.disconnect();
      request?.abort();
    };
  }, [code, theme]);

  if (!graphic)
    return (
      <pre ref={setElement} className={svg === null ? "markdown-mermaid-fallback" : undefined}>
        <code className="language-mermaid">{code}</code>
      </pre>
    );
  return (
    <figure ref={setElement} className="markdown-mermaid" aria-label={t("Mermaid 图表")}>
      <div className="markdown-mermaid-toolbar">
        <button
          className="icon-button"
          type="button"
          aria-label={t("缩小图表")}
          data-tooltip={t("缩小图表")}
          disabled={zoom === ZOOM_MIN}
          onClick={() => setZoom((value) => Math.max(ZOOM_MIN, value - ZOOM_STEP))}
        >
          <Minus size={14} aria-hidden="true" />
        </button>
        <button
          className="icon-button markdown-mermaid-reset"
          type="button"
          aria-label={t("恢复适应宽度")}
          aria-description={`${zoom}%`}
          data-tooltip={t("恢复适应宽度")}
          onClick={() => setZoom(100)}
        >
          {zoom}%
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label={t("放大图表")}
          data-tooltip={t("放大图表")}
          disabled={zoom === ZOOM_MAX}
          onClick={() => setZoom((value) => Math.min(ZOOM_MAX, value + ZOOM_STEP))}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      </div>
      <div
        className="markdown-mermaid-viewport"
        role="group"
        aria-label={t("Mermaid 图表")}
        tabIndex={0}
      >
        <div
          className="markdown-mermaid-canvas"
          style={{
            width: `${zoom}%`,
            maxWidth: graphic.size ? (graphic.size.width * zoom) / 100 : undefined,
            // Keep its height when the WebView skips the offscreen SVG subtree.
            aspectRatio: graphic.size
              ? `${graphic.size.width} / ${graphic.size.height}`
              : undefined,
            contentVisibility: graphic.size ? "auto" : undefined,
          }}
          dangerouslySetInnerHTML={graphic.html}
        />
      </div>
    </figure>
  );
});
