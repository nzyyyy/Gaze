import { useEffect, useState } from "react";
import { t, useLanguage } from "../../lib/i18n";
import type { RecentFile } from "../../lib/workspace/session";
import "./CodeLocationPreview.css";

export type ReadPreviewText = (projectId: string, path: string) => Promise<string | null>;

export function CodeLocationPreview({
  location,
  readText,
}: {
  location: RecentFile;
  readText: ReadPreviewText;
}) {
  useLanguage();
  const { projectId, path, position } = location;
  const [content, setContent] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    const timer = window.setTimeout(() => {
      void readText(projectId, path)
        .catch(() => null)
        .then((text) => {
          if (!disposed) setContent(text);
        });
    }, 80);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [path, projectId, readText]);

  if (!position) return null;
  const firstLine = Math.max(0, position.line - 1);
  const lines: string[] = [];
  if (content != null) {
    let nextLine = 0;
    for (const match of content.matchAll(/([^\r\n]*)(?:\r\n?|\n|$)/g)) {
      if (!match[0] && match.index > 0 && !/[\r\n]$/.test(content)) break;
      const line = nextLine++;
      if (line < firstLine) continue;
      const text = match[1]!;
      const start =
        line === position.line && text.length > 240
          ? Math.min(Math.max(0, position.character - 70), text.length - 240)
          : 0;
      lines.push(
        `${start ? "…" : ""}${text.slice(start, start + 240)}${text.length > start + 240 ? "…" : ""}`,
      );
      if (line >= position.line + 1) break;
    }
  }

  return (
    <div className="code-location-preview" aria-label={t("代码预览")}>
      {lines.length > position.line - firstLine ? (
        <pre>
          {lines.map((text, index) => (
            <code key={firstLine + index} data-hit={firstLine + index === position.line}>
              <span aria-hidden="true">{firstLine + index + 1}</span>
              {text}
            </code>
          ))}
        </pre>
      ) : (
        <span>{content === undefined ? t("正在读取代码预览…") : t("没有可用的代码预览")}</span>
      )}
    </div>
  );
}
