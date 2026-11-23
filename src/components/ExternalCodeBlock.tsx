import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MarkdownOutput } from "../plugins/api";
import { usePlugins } from "../plugins/runtime";

export function ExternalCodeBlock({
  renderer,
  code,
  fallback,
}: {
  renderer: { revision: string; language: string };
  code: string;
  fallback: ReactNode;
}) {
  const run = usePlugins()?.run;
  const ref = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState<{ code: string; output: MarkdownOutput } | null>(null);
  const { revision, language } = renderer;
  useEffect(() => {
    if (!run || !ref.current) return;
    let request: AbortController | null = null;
    let completed = false;
    const start = () => {
      if (request || completed) return;
      const controller = new AbortController();
      request = controller;
      void run(revision, { kind: "markdown", language, code }, controller.signal)
        .then((output) => {
          if (controller.signal.aborted) return;
          completed = true;
          if (output?.kind === "text" || output?.kind === "table") setRendered({ code, output });
        })
        .catch(() => {
          if (!controller.signal.aborted) completed = true;
        });
    };
    const cancel = () => {
      request?.abort();
      request = null;
    };
    if (typeof IntersectionObserver === "undefined") {
      start();
      return cancel;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) start();
      else cancel();
    });
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      cancel();
    };
  }, [run, revision, language, code]);

  const output = rendered?.code === code ? rendered.output : null;
  return (
    <div ref={ref} className="markdown-plugin-output">
      {output?.kind === "text" ? (
        <pre>{output.text}</pre>
      ) : output?.kind === "table" ? (
        <table>
          <thead>
            <tr>
              {output.headers.map((header, column) => (
                <th scope="col" key={column}>
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {output.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, column) => (
                  <td key={column}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        fallback
      )}
    </div>
  );
}
