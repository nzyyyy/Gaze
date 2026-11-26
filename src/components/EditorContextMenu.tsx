import { foldable, foldCode, foldedRanges, unfoldCode } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { flushSync } from "react-dom";
import { columnMode, deleteEditorSelection, selectedEditorText } from "../lib/columnSelection";
import { pasteEditorText, readEditorClipboard, writeEditorClipboard } from "../lib/editorClipboard";
import { editorCommands } from "../lib/editorCommands";
import { runEditorLanguageAction } from "../lib/editorLanguageTools";
import { t } from "../lib/i18n";
import {
  shortcutCommandLabel,
  shortcutLabel,
  type NavigationTarget,
  type ShortcutBindings,
} from "../lib/shortcuts";
import { ContextMenu, type MenuTarget } from "./ContextMenu";

interface EditorContextMenuProps {
  view: EditorView;
  state: EditorState;
  target: MenuTarget;
  shortcuts: ShortcutBindings;
  canNavigate: boolean;
  canUseLanguage: boolean;
  canFold: boolean;
  isCurrent: () => boolean;
  canEdit: () => boolean;
  onClose: () => void;
  onNavigate: (target: NavigationTarget) => boolean;
  onCopyLocation: (view: EditorView) => boolean;
  onSearchSelection?: (text: string) => void;
  onError: (error: unknown) => void;
}

export function EditorContextMenu({
  view,
  state,
  target,
  shortcuts,
  canNavigate,
  canUseLanguage,
  canFold,
  isCurrent,
  canEdit,
  onClose,
  onNavigate,
  onCopyLocation,
  onSearchSelection,
  onError,
}: EditorContextMenuProps) {
  const selected = selectedEditorText(state);
  const { doc, selection } = state;
  const word = state.wordAt(selection.main.head);
  const onSymbol = canNavigate && !!word && /[\p{L}_$]/u.test(doc.sliceString(word.from, word.to));
  const line = doc.lineAt(selection.main.head);
  let isFolded = false;
  if (canFold)
    foldedRanges(state).between(line.from, line.to, (from) => {
      if (from >= line.from) isFolded = true;
    });
  const canToggleFold = canFold && (isFolded || !!foldable(state, line.from, line.to));
  const canSearch =
    !!onSearchSelection &&
    !!selected?.trim() &&
    selection.ranges.length === 1 &&
    !/[\r\n]/.test(selected);
  const editable = () => !view.state.readOnly && canEdit();
  const valid = () =>
    isCurrent() &&
    !view.compositionStarted &&
    view.state.doc === doc &&
    view.state.selection === selection;

  const run = (action: () => unknown, writes?: boolean) => {
    flushSync(onClose);
    if (!valid() || (writes && !editable())) return;
    view.focus();
    try {
      void Promise.resolve(action()).catch(onError);
    } catch (error) {
      onError(error);
    }
  };
  const copy = async (cut: boolean) => {
    if (selected === null) return;
    const text = state
      .facet(EditorView.clipboardOutputFilter)
      .reduce((value, filter) => filter(value, state), selected);
    await writeEditorClipboard(text);
    if (cut && valid() && editable() && view.hasFocus) {
      deleteEditorSelection(view, "delete.cut");
    }
  };
  const paste = async () => {
    const value = await readEditorClipboard();
    if (value && valid() && editable() && view.hasFocus) pasteEditorText(view, value);
  };

  const item = (
    label: string,
    action: () => unknown,
    key?: string,
    writes = false,
    checked?: boolean,
  ) => (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-label={label}
      aria-checked={checked}
      disabled={writes && !editable()}
      onClick={() => run(action, writes)}
    >
      <span>{label}</span>
      {checked && (
        <span aria-hidden="true" className="editor-menu-check">
          ✓
        </span>
      )}
      {key && <kbd>{key}</kbd>}
    </button>
  );
  const command = (id: string, action: () => unknown, writes = false, checked?: boolean) =>
    item(
      shortcutCommandLabel(id),
      action,
      shortcuts[id] ? shortcutLabel(shortcuts[id]) : undefined,
      writes,
      checked,
    );

  return (
    <ContextMenu
      target={target}
      label={t("编辑器操作")}
      onClose={onClose}
      className="editor-context-menu"
    >
      {selected !== null && item(t("剪切"), () => copy(true), "⌘X", true)}
      {selected !== null && item(t("复制"), () => copy(false), "⌘C")}
      {item(t("粘贴"), paste, "⌘V", true)}
      {command("copy-location", () => onCopyLocation(view))}
      <div role="separator" />
      {command(
        "column-selection",
        () => editorCommands["column-selection"](view),
        false,
        columnMode(state),
      )}
      {selected !== null &&
        command("extend-selection", () => editorCommands["extend-selection"](view))}
      {selected !== null &&
        command("shrink-selection", () => editorCommands["shrink-selection"](view))}
      {canSearch &&
        selected !== null &&
        item(t("在工作区搜索选中文本"), () => onSearchSelection?.(selected))}
      <div role="separator" />
      {command("go-to-line", () => editorCommands["go-to-line"](view))}
      {onSymbol && command("definition", () => onNavigate("definition"))}
      {onSymbol && canUseLanguage && command("references", () => onNavigate("references"))}
      {onSymbol && canUseLanguage && command("implementation", () => onNavigate("implementation"))}
      {(canUseLanguage || canToggleFold) && <div role="separator" />}
      {canUseLanguage &&
        command("quick-fix", () => runEditorLanguageAction(view, "quick-fix"), true)}
      {canUseLanguage &&
        command("format-code", () => runEditorLanguageAction(view, "format-code"), true)}
      {canToggleFold &&
        (isFolded
          ? item(t("展开代码"), () => unfoldCode(view))
          : item(t("折叠代码"), () => foldCode(view)))}
    </ContextMenu>
  );
}
