import {
  closeCompletion,
  currentCompletions,
  pickedCompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { isolateHistory } from "@codemirror/commands";
import { ensureSyntaxTree, language } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";
import { api } from "../lib/platform/api";
import { completionCompositionKeys } from "../lib/editor/completion";

const pathCharacters = /[\\\x00-\x1f\x7f]/;
const urlStart = /^(?:\/\/|[a-z][a-z\d+.-]*:)/i;
// These grammars distinguish ordinary quoted strings from interpolated strings.
const quotedLanguages = new Set([
  "cpp",
  "go",
  "java",
  "javascript",
  "json",
  "python",
  "rust",
  "toml",
  "typescript",
  "yaml",
]);

function markdownTarget(state: EditorState, pos: number) {
  const line = state.doc.lineAt(pos);
  const markAt = line.text.slice(0, pos - line.from).lastIndexOf("](");
  if (markAt < 0) return null;
  const mark = ensureSyntaxTree(state, pos, 5)?.resolveInner(line.from + markAt, 1);
  const link = mark?.parent;
  if (mark?.name !== "LinkMark" || (link?.name !== "Link" && link?.name !== "Image")) return null;

  const url = link.getChild("URL");
  const raw = line.text.slice(markAt + 2);
  const start = url?.from ?? line.from + markAt + 2 + (raw.length - raw.trimStart().length);
  const angle = state.sliceDoc(start, start + 1) === "<";
  const from = start + Number(angle);
  const rawEnd = state.doc.sliceString(from, url?.to ?? line.to);
  const end = rawEnd.search(angle ? /[>?#]/ : url ? /[?#]/ : /[\s<>)?#]/);
  return { from, to: from + (end < 0 ? rawEnd.length : end), quote: "" };
}

function quotedTarget(state: EditorState, pos: number) {
  if (!quotedLanguages.has(state.facet(language)?.name ?? "")) return null;
  const line = state.doc.lineAt(pos);
  if (!/["']/.test(line.text.slice(0, pos - line.from))) return null;
  const tree = ensureSyntaxTree(state, pos, 5);
  if (!tree) return null;
  for (let node = tree.resolveInner(pos, -1); node;) {
    const parent = node.parent;
    const jsonStringError =
      node.type.isError &&
      tree.topNode.name === "JsonText" &&
      (parent?.name !== "Property" || parent.getChild(":") !== null);
    if (
      ["String", "string", "StringLiteral", "QuotedLiteral"].includes(node.name) ||
      jsonStringError
    ) {
      const quote = state.sliceDoc(node.from, node.from + 1);
      if (quote !== '"' && quote !== "'") return null;
      if (
        parent &&
        ["ImportDeclaration", "ExportDeclaration", "DynamicImport", "Key"].includes(parent.name)
      )
        return null;
      const from = node.from + 1;
      const text = state.doc.sliceString(from, Math.min(node.to, line.to));
      const closingQuote = text.endsWith(quote);
      const value = closingQuote ? text.slice(0, -1) : text;
      if (value.includes(quote) || pathCharacters.test(value)) return null;
      return { from, to: from + value.length, quote };
    }
    if (!parent) break;
    node = parent;
  }
  return null;
}

function pathQuery(state: EditorState, pos: number, markdown: boolean) {
  if (state.readOnly || state.selection.ranges.length !== 1 || !state.selection.main.empty)
    return null;
  const target = markdown ? markdownTarget(state, pos) : quotedTarget(state, pos);
  if (!target || pos < target.from || pos > target.to) return null;
  const typed = state.sliceDoc(target.from, pos);
  if (!markdown && (!typed || /^[\/@~#]/.test(typed))) return null;
  const separator = typed.lastIndexOf("/") + 1;
  let directory = typed.slice(0, separator);
  let prefix = typed.slice(separator);
  if (markdown) {
    try {
      directory = decodeURIComponent(directory);
      prefix = decodeURIComponent(prefix);
    } catch {
      return null;
    }
  }
  if (urlStart.test(directory + prefix) || pathCharacters.test(directory + prefix)) return null;
  const after = state.sliceDoc(pos, target.to);
  const nextSlash = after.indexOf("/");
  return {
    directory,
    prefix,
    from: target.from + separator,
    to: nextSlash < 0 ? target.to : pos + nextSlash + 1,
    directoryOnly: nextSlash >= 0,
    quote: target.quote,
    automatic: separator > 0,
  };
}

function markdownPathSegment(name: string) {
  return encodeURIComponent(name).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function createPathCompletion(projectId: string, documentPath: string, markdown: boolean) {
  function queryFor(context: CompletionContext) {
    const query = pathQuery(context.state, context.pos, markdown);
    return query && (query.automatic || context.explicit) ? query : null;
  }

  const source: CompletionSource = async (context) => {
    const { state, view } = context;
    if (view?.compositionStarted) return null;
    const query = queryFor(context);
    if (!query) return null;
    context.addEventListener("abort", () => {}, { onDocChange: true });
    const entries = await api
      .completePaths(projectId, documentPath, query.directory, query.prefix, query.directoryOnly)
      .catch(() => []);
    if (
      context.aborted ||
      (view &&
        (!view.state.selection.eq(state.selection) ||
          view.state.doc !== state.doc ||
          view.state.readOnly ||
          view.compositionStarted))
    )
      return null;

    return {
      from: query.from,
      to: query.to,
      filter: false,
      options: entries.flatMap<Completion>(({ name, isDirectory }) => {
        // shortcut: quote-delimited literals accept plain segments, expand with language-specific escaping.
        if (pathCharacters.test(name) || (!markdown && name.includes(query.quote))) return [];
        const relative = markdown && !query.directory && urlStart.test(name) ? "./" : "";
        const suffix = isDirectory ? "/" : "";
        const insert = relative + (markdown ? markdownPathSegment(name) : name) + suffix;
        return [
          {
            label: name + suffix,
            type: isDirectory ? "folder" : "file",
            apply(editor, completion) {
              if (
                editor.compositionStarted ||
                editor.state.readOnly ||
                editor.state.doc !== state.doc ||
                !editor.state.selection.eq(state.selection)
              )
                return;
              editor.dispatch({
                changes: { from: query.from, to: query.to, insert },
                selection: { anchor: query.from + insert.length },
                annotations: [pickedCompletion.of(completion), isolateHistory.of("full")],
                userEvent: "input.complete",
              });
            },
          },
        ];
      }),
    };
  };

  const active = (state: EditorState) => pathQuery(state, state.selection.main.head, markdown);
  const composition = ViewPlugin.define(() => ({}), {
    eventHandlers: {
      compositionstart(_event, view) {
        if (active(view.state)) closeCompletion(view);
      },
      compositionend(_event, view) {
        queueMicrotask(() => {
          if (view.hasFocus && view.plugin(composition) && active(view.state)?.automatic)
            startCompletion(view);
        });
      },
    },
  });

  return {
    source,
    matches: (context: CompletionContext) => queryFor(context) !== null,
    reserved: (state: EditorState) =>
      !!active(state)?.automatic ||
      currentCompletions(state).some(({ type }) => type === "folder" || type === "file"),
    extension: [completionCompositionKeys, composition],
  };
}
