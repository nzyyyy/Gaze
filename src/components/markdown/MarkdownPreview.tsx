import { t, useLanguage } from "../../lib/i18n";
import { DEFAULT_PREFERENCES } from "../../lib/settings/preferences";
import {
  Children,
  createContext,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import refractor from "refractor/core";
import bash from "refractor/lang/bash";
import css from "refractor/lang/css";
import diff from "refractor/lang/diff";
import go from "refractor/lang/go";
import java from "refractor/lang/java";
import javascript from "refractor/lang/javascript";
import json from "refractor/lang/json";
import jsx from "refractor/lang/jsx";
import markdown from "refractor/lang/markdown";
import markup from "refractor/lang/markup";
import python from "refractor/lang/python";
import rust from "refractor/lang/rust";
import sql from "refractor/lang/sql";
import tsx from "refractor/lang/tsx";
import typescript from "refractor/lang/typescript";
import yaml from "refractor/lang/yaml";

import { api } from "../../lib/platform/api";
import { errorMessage } from "../../lib/utils";
import type { MarkdownPreviewRequest } from "../../editor/types";
import { useMarkdownRenderers } from "../../plugins/runtime";
import { ExternalCodeBlock } from "./ExternalCodeBlock";
import { useMarkdownMath } from "../../plugins/markdown-math";

const HEADING_PREFIX = "gaze-markdown-";
const MAX_MARKDOWN_IMAGES = 50;
// shortcut: climbing past this many characters turns a code block into thousands of spans.
const MAX_HIGHLIGHT_CHARS = 20_000;
const OUTLINE_MIN_WIDTH = 140;
const OUTLINE_MAX_WIDTH = 360;
const OUTLINE_COLLAPSE_WIDTH = 96;
const MIN_READER_WIDTH = 320;
// Remembered across preview remounts (switching back from source view) without touching layout storage.
let rememberedOutlineWidth = 220;
const remoteImageTrust = new Set<string>();
const remarkPlugins = [remarkGfm, remarkCjkFriendly];
const rehypePlugins: NonNullable<React.ComponentProps<typeof Markdown>["rehypePlugins"]> = [
  rehypeRaw,
  rehypeSanitize,
  [rehypeSlug, { prefix: HEADING_PREFIX }],
];

for (const language of [
  bash,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  jsx,
  markdown,
  markup,
  python,
  rust,
  sql,
  tsx,
  typescript,
  yaml,
]) {
  refractor.register(language);
}

type HighlightNode = {
  type: string;
  value?: string;
  properties?: { className?: string[] };
  children?: HighlightNode[];
};

function highlightNodes(nodes: HighlightNode[]): ReactNode {
  return nodes.map((node, index) =>
    node.type === "text" ? (
      node.value
    ) : (
      <span key={index} className={node.properties?.className?.join(" ")}>
        {highlightNodes(node.children ?? [])}
      </span>
    ),
  );
}

function childText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(childText).join("");
  return "";
}

const CodeBlockRenderers = createContext<ReturnType<typeof useMarkdownRenderers> | null>(null);

function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  const renderers = useContext(CodeBlockRenderers);
  const child = Children.toArray(children)[0];
  const code = isValidElement<{ className?: string; children?: ReactNode }>(child) ? child : null;
  const className = code?.props.className ?? "";
  const text = code ? childText(code.props.children) : childText(children);
  const language = /(?:^|\s)language-([^\s]+)/.exec(className)?.[1];
  const renderer = language ? renderers?.get(language.toLowerCase()) : undefined;
  const highlighted = useMemo(
    () =>
      language && !renderer && text.length <= MAX_HIGHLIGHT_CHARS && refractor.registered(language)
        ? (refractor.highlight(text, language) as unknown as HighlightNode[])
        : null,
    [language, renderer, text],
  );
  const source = (
    <pre>
      <code className={className}>{highlighted ? highlightNodes(highlighted) : text}</code>
    </pre>
  );
  if (!renderer) return source;
  const content = text.replace(/\n$/, "");
  if ("component" in renderer) return <renderer.component code={content} />;
  return (
    <ExternalCodeBlock
      key={renderer.revision}
      renderer={renderer}
      code={content}
      fallback={source}
    />
  );
}

function safeUrl(value: string): string {
  if (/[\u0000-\u0020\u007f\\]/.test(value) || value.startsWith("//")) return "";
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  }
  return value;
}

function markdownImageUrl(projectId: string, documentPath: string, src: string): string {
  const query = new URLSearchParams({ projectId, documentPath, src });
  return `${convertFileSrc("", "gaze-image")}?${query}`;
}

function MarkdownImage({
  projectId,
  documentPath,
  src,
  alt,
  title,
  overLimit,
  remoteTrusted,
  onTrustRemote,
}: {
  projectId: string;
  documentPath: string;
  src: string;
  alt?: string;
  title?: string;
  overLimit: boolean;
  remoteTrusted: boolean;
  onTrustRemote: () => void;
}) {
  useLanguage();
  const [failed, setFailed] = useState(false);
  const label = alt || src || t("图片");
  if (overLimit) {
    return (
      <span className="markdown-image-fallback">
        {t("[图片超过预览数量上限：")}
        {label}]
      </span>
    );
  }
  if (failed || !src) {
    return (
      <span className="markdown-image-fallback">
        {t("[图片无法显示：")}
        {label}]
      </span>
    );
  }
  const remote = /^https?:/i.test(src);
  if (remote && !remoteTrusted) {
    return (
      <span className="markdown-image-fallback">
        {t("[远程图片已阻止：")}
        {label}]{" "}
        <button type="button" onClick={onTrustRemote}>
          {t("允许本项目加载远程图片")}
        </button>
      </span>
    );
  }
  return (
    <img
      src={remote ? src : markdownImageUrl(projectId, documentPath, src)}
      alt={alt ?? ""}
      data-tooltip={title}
      aria-description={title}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

interface MarkdownPreviewProps {
  content: string;
  projectId: string;
  documentPath: string;
  active: boolean;
  mermaidEnabled?: boolean;
  markdownMathEnabled?: boolean;
  request?: MarkdownPreviewRequest | null;
  onOpenFile?: (projectId: string, path: string, fragment: string | null) => void;
  onNotice: (message: string) => void;
}

function MarkdownOutline({
  content,
  rootRef,
  onNavigate,
}: {
  content: string;
  rootRef: RefObject<HTMLDivElement | null>;
  onNavigate: (fragment: string) => void;
}) {
  useLanguage();
  const navigationId = useId();
  const asideRef = useRef<HTMLElement>(null);
  const resizerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [width, setWidth] = useState(rememberedOutlineWidth);
  const [maxWidth, setMaxWidth] = useState(OUTLINE_MAX_WIDTH);
  const [headings, setHeadings] = useState<{ id: string; text: string; level: number }[]>([]);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const widthRef = useRef(width);
  widthRef.current = width;

  const resize = useCallback((value: number, dragging = false) => {
    const layout = asideRef.current?.parentElement;
    if (!layout) return undefined;
    const available = layout.getBoundingClientRect().width || window.innerWidth;
    const max = Math.max(
      OUTLINE_MIN_WIDTH,
      Math.min(OUTLINE_MAX_WIDTH, available - MIN_READER_WIDTH),
    );
    if (dragging) {
      const collapsed = value < OUTLINE_COLLAPSE_WIDTH;
      if (collapsed === expandedRef.current) {
        expandedRef.current = !collapsed;
        setExpanded(!collapsed);
      }
      if (collapsed) return widthRef.current;
    }
    const next = Math.max(
      dragging ? OUTLINE_COLLAPSE_WIDTH : OUTLINE_MIN_WIDTH,
      Math.min(max, Math.round(value)),
    );
    widthRef.current = next;
    rememberedOutlineWidth = next;
    setWidth(next);
    setMaxWidth(max);
    return next;
  }, []);

  const stop = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    const resizer = resizerRef.current;
    resizer?.parentElement?.classList.remove("is-resizing-outline");
    if (drag) resizer?.blur();
    if (drag && resizer?.hasPointerCapture(drag.pointerId))
      resizer.releasePointerCapture(drag.pointerId);
  }, []);

  useEffect(() => {
    const elements = rootRef.current?.querySelectorAll<HTMLElement>(
      ".markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6",
    );
    setHeadings(
      Array.from(elements ?? [], (element) => ({
        id: element.id,
        text: element.textContent ?? "",
        level: Number(element.tagName.slice(1)),
      })),
    );
  }, [content, rootRef]);

  useLayoutEffect(() => {
    resize(widthRef.current);
    const fit = () => resize(widthRef.current);
    window.addEventListener("resize", fit);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("resize", fit);
      window.removeEventListener("blur", stop);
    };
  }, [resize, stop, headings.length]);

  if (!headings.length) return null;
  const baseLevel = headings.reduce((level, heading) => Math.min(level, heading.level), 6);
  return (
    <>
      <aside
        className={`markdown-outline${expanded ? "" : " is-collapsed"}`}
        ref={asideRef}
        style={expanded ? { flexBasis: `${width}px` } : undefined}
      >
        <div className="markdown-outline-header">
          {expanded && <span>{t("目录")}</span>}
          <button
            type="button"
            aria-label={t(expanded ? "收起目录" : "展开目录")}
            aria-expanded={expanded}
            aria-controls={navigationId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronsLeft size={16} /> : <ChevronsRight size={16} />}
          </button>
        </div>
        <nav id={navigationId} aria-label={t("目录")} hidden={!expanded}>
          <ol>
            {headings.map((heading) => (
              <li key={heading.id} style={{ paddingLeft: (heading.level - baseLevel) * 12 }}>
                <a
                  href={`#${heading.id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    onNavigate(heading.id);
                  }}
                >
                  {heading.text}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </aside>
      <div
        ref={resizerRef}
        className="markdown-outline-resizer"
        role="separator"
        aria-label={t("调整目录宽度")}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={maxWidth}
        aria-valuenow={expanded ? width : 0}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            width: expandedRef.current ? widthRef.current : 0,
          };
          event.currentTarget.parentElement?.classList.add("is-resizing-outline");
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (drag?.pointerId === event.pointerId)
            resize(drag.width + event.clientX - drag.x, true);
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) stop();
        }}
        onPointerCancel={stop}
        onLostPointerCapture={stop}
        onKeyDown={(event) => {
          if (!expanded) {
            if (event.key !== "ArrowRight") return;
            event.preventDefault();
            expandedRef.current = true;
            setExpanded(true);
            return;
          }
          const next =
            event.key === "ArrowLeft"
              ? width - 20
              : event.key === "ArrowRight"
                ? width + 20
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? maxWidth
                    : null;
          if (next === null) return;
          event.preventDefault();
          if (next < OUTLINE_COLLAPSE_WIDTH) {
            expandedRef.current = false;
            setExpanded(false);
            return;
          }
          resize(next);
        }}
      />
    </>
  );
}

export default function MarkdownPreview({
  content,
  projectId,
  documentPath,
  active,
  mermaidEnabled = DEFAULT_PREFERENCES.mermaidEnabled,
  markdownMathEnabled = DEFAULT_PREFERENCES.markdownMathEnabled,
  request,
  onOpenFile,
  onNotice,
}: MarkdownPreviewProps) {
  useLanguage();
  const rootRef = useRef<HTMLDivElement>(null);
  const renderers = useMarkdownRenderers(mermaidEnabled);
  const math = useMarkdownMath(markdownMathEnabled);
  const scrollToFragment = useCallback(
    (fragment: string) => {
      const root = rootRef.current;
      if (!root) return;
      if (!fragment) {
        root.scrollTop = 0;
        return;
      }
      const target = Array.from(root.querySelectorAll<HTMLElement>("[id]")).find(
        (element) => element.id === fragment || element.id === HEADING_PREFIX + fragment,
      );
      if (target) target.scrollIntoView({ block: "start" });
      else onNotice(t("没有找到链接指向的标题。"));
    },
    [onNotice],
  );

  useEffect(() => {
    if (active && request?.fragment != null) scrollToFragment(request.fragment);
  }, [active, request, content, scrollToFragment]);

  const [, setTrustRevision] = useState(0);
  const remoteTrusted = remoteImageTrust.has(projectId);
  const trustRemoteImages = useCallback(() => {
    remoteImageTrust.add(projectId);
    setTrustRevision((revision) => revision + 1);
  }, [projectId]);

  return (
    <div className="markdown-preview-layout">
      <MarkdownOutline content={content} rootRef={rootRef} onNavigate={scrollToFragment} />
      <div
        className="markdown-preview"
        ref={rootRef}
        role="region"
        aria-label={t("Markdown 预览")}
        tabIndex={0}
      >
        <CodeBlockRenderers value={renderers}>
          <MarkdownBody
            content={content}
            projectId={projectId}
            documentPath={documentPath}
            math={math}
            onOpenFile={onOpenFile}
            onNotice={onNotice}
            scrollToFragment={scrollToFragment}
            remoteTrusted={remoteTrusted}
            onTrustRemote={trustRemoteImages}
          />
        </CodeBlockRenderers>
      </div>
    </div>
  );
}

const MarkdownBody = memo(function MarkdownBody({
  content,
  projectId,
  documentPath,
  math,
  onOpenFile,
  onNotice,
  scrollToFragment,
  remoteTrusted,
  onTrustRemote,
}: Omit<MarkdownPreviewProps, "active" | "mermaidEnabled" | "markdownMathEnabled" | "request"> & {
  math?: ReturnType<typeof useMarkdownMath>;
  scrollToFragment: (fragment: string) => void;
  remoteTrusted: boolean;
  onTrustRemote: () => void;
}) {
  const remark = useMemo(() => (math ? [...remarkPlugins, math.remark] : remarkPlugins), [math]);
  const rehype = useMemo(() => (math ? [...rehypePlugins, math.rehype] : rehypePlugins), [math]);
  let imageIndex = 0;
  const components: Components = {
    img: ({ src, alt, title }) => {
      const index = imageIndex++;
      return (
        <MarkdownImage
          key={`${projectId}:${documentPath}:${index}:${src}`}
          projectId={projectId}
          documentPath={documentPath}
          src={typeof src === "string" ? src : ""}
          alt={alt}
          title={title}
          overLimit={index >= MAX_MARKDOWN_IMAGES}
          remoteTrusted={remoteTrusted}
          onTrustRemote={onTrustRemote}
        />
      );
    },
    pre: MarkdownCodeBlock,
    a: ({ href, children, title }) => {
      if (!href) return <span>{children}</span>;
      const open = async () => {
        if (href.startsWith("#")) {
          scrollToFragment(decodeURIComponent(href.slice(1)));
        } else if (/^https?:/i.test(href)) {
          await api.openExternalUrl(href);
        } else {
          const target = await api.resolveMarkdownLink(projectId, documentPath, href);
          if (target.path === documentPath) scrollToFragment(target.fragment ?? "");
          else onOpenFile?.(projectId, target.path, target.fragment);
        }
      };
      return (
        <a
          href={href}
          data-tooltip={title}
          aria-description={title}
          onAuxClick={(event) => event.preventDefault()}
          onClick={(event) => {
            event.preventDefault();
            void open().catch((error) => onNotice(errorMessage(error)));
          }}
        >
          {children}
        </a>
      );
    },
  };

  return (
    <article className="markdown-body">
      <Markdown
        remarkPlugins={remark}
        rehypePlugins={rehype}
        components={components}
        urlTransform={safeUrl}
      >
        {content}
      </Markdown>
    </article>
  );
});
