import {
  closeCompletion,
  pickedCompletion,
  startCompletion,
  type Completion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { isolateHistory } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, Prec, type EditorState } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin, type Command } from "@codemirror/view";
import { t } from "../lib/i18n";
import type { CompletionContribution } from "../lib/completion";

interface InsertItem {
  name: string;
  command: string;
  level?: number;
  inline?: boolean;
  separate?: boolean;
  before: string;
  field?: string;
  after?: string;
}

const items: InsertItem[] = [
  ...Array.from({ length: 6 }, (_, index) => ({
    name: "标题 {0}",
    command: `h${index + 1}`,
    level: index + 1,
    before: `${"#".repeat(index + 1)} `,
  })),
  { name: "无序列表", command: "ul", before: "- " },
  { name: "有序列表", command: "ol", before: "1. " },
  { name: "待办列表", command: "todo", before: "- [ ] " },
  { name: "引用块", command: "quote", before: "> " },
  { name: "分隔线", command: "divider", before: "---\n", separate: true },
  { name: "代码块", command: "code", before: "```\n", after: "\n```", separate: true },
  {
    name: "表格",
    command: "table",
    before: "| ",
    field: "A",
    after: " | B |\n| --- | --- |\n|  |  |",
    separate: true,
  },
  {
    name: "Mermaid 图表",
    command: "mermaid",
    before: "```mermaid\nflowchart TD\n  ",
    field: "A --> B",
    after: "\n```",
    separate: true,
  },
  {
    name: "块级公式",
    command: "math",
    before: "$$\n",
    field: "x^2",
    after: "\n$$",
    separate: true,
  },
  { name: "插入链接", command: "link", before: "[", after: "]()", inline: true },
  { name: "插入图片", command: "image", before: "![](", after: ")", inline: true },
];

export function markdownSlashQuery(state: EditorState, pos: number) {
  if (state.readOnly || state.selection.ranges.length !== 1 || !state.selection.main.empty)
    return null;
  const line = state.doc.lineAt(pos);
  const offset = pos - line.from;
  if (/\S/.test(line.text.charAt(offset))) return null;
  const match = /(?:^|[ \t])(\/([\p{L}\p{N}-]*))$/u.exec(line.text.slice(0, offset));
  if (!match) return null;

  const from = pos - match[1]!.length;
  const tree = ensureSyntaxTree(state, pos, 5);
  if (!tree) return null;
  const node = tree.resolveInner(from, 1).cursor();
  do {
    if (["InlineCode", "FencedCode", "CodeBlock"].includes(node.name)) return null;
  } while (node.parent());

  const prefix = line.text.slice(0, from - line.from);
  return {
    from,
    line,
    query: match[2]!.toLowerCase(),
    block: /^ {0,3}$/.test(prefix) && !line.text.slice(offset).trim(),
  };
}

export const markdownSlashSource: CompletionSource = function completeMarkdown({
  state,
  pos,
  view,
}) {
  if (view?.compositionStarted) return null;
  const match = markdownSlashQuery(state, pos);
  if (!match) return null;

  const options = items.flatMap<Completion>((item) => {
    const label = t(item.name, item.level);
    const chinese = item.name.replace("{0}", String(item.level ?? ""));
    if (
      (!match.block && !item.inline) ||
      ![label, chinese, item.command].some((name) =>
        name.toLowerCase().replace(/\s/g, "").includes(match.query),
      )
    )
      return [];

    return {
      label,
      detail: `/${item.command}`,
      apply(editor, completion, from, to) {
        if (editor.compositionStarted) return;
        const state = editor.state;
        const current = markdownSlashQuery(state, state.selection.main.head);
        if (
          !current ||
          current.from !== from ||
          state.selection.main.head !== to ||
          current.query !== match.query ||
          (!current.block && !item.inline)
        )
          return;

        const { doc } = state;
        const { line } = current;
        const field = item.field ?? "";
        let before = item.before;
        let after = item.after ?? "";
        if (item.separate) {
          if (line.number > 1 && doc.line(line.number - 1).text.trim()) before = "\n" + before;
          if (
            line.number < doc.lines &&
            doc.line(line.number + 1).text.trim() &&
            !(after || before).endsWith("\n")
          )
            after += "\n";
          const indent = state.sliceDoc(line.from, from);
          before = before.replaceAll("\n", "\n" + indent);
          after = after.replaceAll("\n", "\n" + indent);
        }
        const anchor = from + before.length;
        editor.dispatch({
          changes: { from, to, insert: before + field + after },
          selection: { anchor, head: anchor + field.length },
          annotations: [pickedCompletion.of(completion), isolateHistory.of("full")],
          userEvent: "input.complete",
          scrollIntoView: true,
        });
      },
    };
  });

  return options.length
    ? {
        from: match.from,
        options,
        filter: false,
        update: (_current, _from, _to, context) => completeMarkdown(context),
      }
    : null;
};

function wrapMarkdown(before: string, after: string, link = false): Command {
  return (view) => {
    if (view.state.readOnly || view.compositionStarted) return false;
    const change = view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to);
      const start = range.from + before.length;
      return {
        changes: { from: range.from, to: range.to, insert: before + text + after },
        range:
          link && !range.empty
            ? EditorSelection.cursor(start + text.length + 2)
            : EditorSelection.range(range.anchor + before.length, range.head + before.length),
      };
    });
    view.dispatch({
      ...change,
      annotations: isolateHistory.of("full"),
      userEvent: "input",
      scrollIntoView: true,
    });
    return true;
  };
}

const compositionKeys = ViewPlugin.define((view) => {
  const keepCompositionKeys = (event: KeyboardEvent) => {
    // Leave native IME confirmation to the input method even before CodeMirror records a change.
    if (event.isComposing || event.keyCode === 229) event.stopPropagation();
  };
  view.dom.addEventListener("keydown", keepCompositionKeys, true);
  return { destroy: () => view.dom.removeEventListener("keydown", keepCompositionKeys, true) };
});

const extension = [
  Prec.high(
    keymap.of([
      { key: "Mod-b", run: wrapMarkdown("**", "**") },
      { key: "Mod-i", run: wrapMarkdown("*", "*") },
      { key: "Mod-k", run: wrapMarkdown("[", "]()", true) },
    ]),
  ),
  compositionKeys,
  EditorView.domEventHandlers({
    compositionstart(_event, view) {
      if (markdownSlashQuery(view.state, view.state.selection.main.head)) closeCompletion(view);
    },
    compositionend(_event, view) {
      queueMicrotask(() => {
        if (
          view.hasFocus &&
          view.plugin(compositionKeys) &&
          markdownSlashQuery(view.state, view.state.selection.main.head)
        )
          startCompletion(view);
      });
    },
  }),
];

export const markdownInsert: CompletionContribution = {
  sources(state, pos) {
    if (state.readOnly) return [];
    if (markdownSlashQuery(state, pos)) return [{ autocomplete: markdownSlashSource }];
  },
  extension,
};
