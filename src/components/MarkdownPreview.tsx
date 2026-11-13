import { t, useLanguage } from "../lib/i18n";
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import rehypeSlug from "rehype-slug";

import { api } from "../lib/api";
import { errorMessage } from "../lib/utils";
import type { MarkdownPreviewRequest } from "./CodeReader";

const HEADING_PREFIX = "gaze-markdown-";
const MAX_MARKDOWN_IMAGES = 50;
const remoteImageTrust = new Set<string>();
const remarkPlugins = [remarkGfm, remarkCjkFriendly];
const rehypePlugins: NonNullable<React.ComponentProps<typeof Markdown>["rehypePlugins"]> = [
  [rehypeSlug, { prefix: HEADING_PREFIX }],
];

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
  const [expanded, setExpanded] = useState(true);
  const [headings, setHeadings] = useState<{ id: string; text: string; level: number }[]>([]);

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

  if (!headings.length) return null;
  const baseLevel = headings.reduce((level, heading) => Math.min(level, heading.level), 6);
  return (
    <aside className={`markdown-outline${expanded ? "" : " is-collapsed"}`}>
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
  );
}

export default function MarkdownPreview({
  content,
  projectId,
  documentPath,
  active,
  request,
  onOpenFile,
  onNotice,
}: MarkdownPreviewProps) {
  useLanguage();
  const rootRef = useRef<HTMLDivElement>(null);
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
          onTrustRemote={trustRemoteImages}
        />
      );
    },
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
    <div className="markdown-preview-layout">
      <MarkdownOutline content={content} rootRef={rootRef} onNavigate={scrollToFragment} />
      <div
        className="markdown-preview"
        ref={rootRef}
        role="region"
        aria-label={t("Markdown 预览")}
        tabIndex={0}
      >
        <article className="markdown-body">
          <Markdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            components={components}
            urlTransform={safeUrl}
            skipHtml
          >
            {content}
          </Markdown>
        </article>
      </div>
    </div>
  );
}
