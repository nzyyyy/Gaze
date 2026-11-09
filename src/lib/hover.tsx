import { hoverTooltip, type HoverTooltipSource } from "@codemirror/view";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { api } from "./api";

export function lspHoverSource(projectId: string, path: string): HoverTooltipSource {
  return async (view, pos, side) => {
    const doc = view.state.doc;
    const line = doc.lineAt(pos);
    const word = [...line.text.matchAll(/[\p{L}\p{N}\p{M}_$]+/gu)].find((match) => {
      const start = line.from + match.index;
      const end = start + match[0].length;
      return (
        pos >= start && pos <= end && !((pos === start && side < 0) || (pos === end && side > 0))
      );
    });
    if (!word) return null;
    try {
      const contents = await api.hoverCode(projectId, path, doc.toString(), {
        line: line.number - 1,
        character: Math.min(pos, line.from + word.index + word[0].length - 1) - line.from,
      });
      if (!contents.length) return null;
      const { default: Markdown } = await import("react-markdown");
      if (view.state.doc !== doc || !view.dom.isConnected) return null;
      return {
        pos: line.from + word.index,
        end: line.from + word.index + word[0].length,
        above: true,
        create() {
          const dom = document.createElement("div");
          dom.className = "code-hover";
          dom.setAttribute("role", "tooltip");
          const root = createRoot(dom);
          // CodeMirror measures the tooltip as soon as create returns.
          flushSync(() =>
            root.render(
              contents.map((block, index) => (
                <div key={index}>
                  {block.language !== null || block.kind === "plaintext" ? (
                    <pre>{block.value}</pre>
                  ) : (
                    <Markdown
                      components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}
                    >
                      {block.value}
                    </Markdown>
                  )}
                </div>
              )),
            ),
          );
          return { dom, destroy: () => root.unmount() };
        },
      };
    } catch {
      // Hover is optional when the language server is unavailable or still starting.
      return null;
    }
  };
}

export const codeHover = (projectId: string, path: string) =>
  hoverTooltip(lspHoverSource(projectId, path), { hoverTime: 400, hideOnChange: true });
