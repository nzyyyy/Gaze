import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isTauri } from "@tauri-apps/api/core";
import { api } from "../platform/api";
import { t } from "../i18n";

function hasNativeClipboard() {
  return isTauri() && /Mac/.test(navigator.userAgent);
}

export async function readEditorClipboard() {
  if (hasNativeClipboard()) return api.readEditorClipboard();
  if (!navigator.clipboard?.readText) throw new Error(t("无法读取系统剪贴板。"));
  return navigator.clipboard.readText();
}

export async function writeEditorClipboard(text: string) {
  if (hasNativeClipboard()) return api.writeEditorClipboard(text);
  if (!navigator.clipboard?.writeText) throw new Error(t("无法写入系统剪贴板。"));
  return navigator.clipboard.writeText(text);
}

export function pasteEditorText(view: EditorView, text: string) {
  if (view.state.readOnly || !text) return;
  const state = view.state;
  const filtered = state
    .facet(EditorView.clipboardInputFilter)
    .reduce((value, filter) => filter(value, state), text);
  const lines = state.toText(filtered);
  let index = 1;
  const changes =
    lines.lines === state.selection.ranges.length
      ? state.changeByRange((range) => {
          const line = lines.line(index++);
          return {
            changes: { from: range.from, to: range.to, insert: line.text },
            range: EditorSelection.cursor(range.from + line.length, -1),
          };
        })
      : state.replaceSelection(lines);
  view.dispatch(changes, { userEvent: "input.paste", scrollIntoView: true });
}
