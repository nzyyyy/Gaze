import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  copyLineUp,
  defaultKeymap,
  deleteLine,
  deleteLineBoundaryBackward,
  history,
  historyKeymap,
  indentWithTab,
  moveLineDown,
  moveLineUp,
} from "@codemirror/commands";
import {
  bracketMatching,
  indentUnit,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  syntaxHighlighting,
} from "@codemirror/language";
import { nextDiagnostic, previousDiagnostic } from "@codemirror/lint";
import {
  gotoLine,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
  selectNextOccurrence,
  selectSelectionMatches,
} from "@codemirror/search";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  tooltips,
  type ViewUpdate,
} from "@codemirror/view";

import { gitChangeGutter } from "../../git/editorChanges";
import type { ChangeBlock } from "../../git/lineDiff";
import { t } from "../../lib/i18n";
import { columnSelection } from "../../lib/editor/columnSelection";
import { editorCommands, matchSelection } from "../../lib/editor/editorCommands";
import { definitionLink } from "../../lib/editor/definitionLink";
import { detectIndentation } from "../../lib/editor/indentation";
import { indentDoubleClick, indentGuides } from "../../lib/editor/indentGuides";
import { matchLanguage } from "../../lib/editor/language";
import { DEFAULT_PREFERENCES, type Preferences } from "../../lib/settings/preferences";
import { rainbowBrackets } from "../../lib/editor/rainbowBrackets";
import { stickyScroll, syntaxSelection } from "../../lib/editor/readingTools";
import { resolveShortcuts, shortcutKeymap, type NavigationTarget } from "../../lib/shortcuts";
import type { NavigationResult, ResolvedTheme, TextFile, TextPosition } from "../../lib/types";

export interface CodeReaderCompartments {
  diagnostics: Compartment;
  autoImport: Compartment;
  languageTools: Compartment;
  aiCompletion: Compartment;
  locale: Compartment;
  theme: Compartment;
  preferences: Compartment;
  minimap: Compartment;
  highlight: Compartment;
  language: Compartment;
  operation: Compartment;
}

export interface CreateCodeReaderExtensionsOptions {
  compartments: CodeReaderCompartments;
  theme: ResolvedTheme;
  content: TextFile;
  fileName: string;
  projectId: string;
  filePath: string;
  preferences: Preferences;
  onNavigate: ((target: NavigationTarget) => boolean) | undefined;
  onCopyLocation: (view: EditorView) => boolean;
  onDocumentChanged: (view: EditorView) => void;
  onGitChangeSelect: (block: ChangeBlock, element: HTMLElement) => void;
  canGoToDefinition: () => boolean;
  onGoToDefinition: (position: TextPosition, result: NavigationResult) => void;
  onOpenFileLink: (path: string, fragment: string | null) => void;
  onUpdate: (update: ViewUpdate) => void;
  isLocked: () => boolean;
}

export function createCodeReaderCompartments(): CodeReaderCompartments {
  return {
    diagnostics: new Compartment(),
    autoImport: new Compartment(),
    languageTools: new Compartment(),
    aiCompletion: new Compartment(),
    locale: new Compartment(),
    theme: new Compartment(),
    preferences: new Compartment(),
    minimap: new Compartment(),
    highlight: new Compartment(),
    language: new Compartment(),
    operation: new Compartment(),
  };
}

export function editorTheme(
  dark: boolean,
  fontFamily = "var(--font-mono)",
  preferences = DEFAULT_PREFERENCES,
) {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        color: "var(--text)",
        backgroundColor: "var(--editor-bg)",
        fontSize: `${preferences.editorFontSize}px`,
        "--editor-text-inset": "6px",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": {
        fontFamily,
        lineHeight: String(preferences.editorLineHeight),
        overflow: "auto",
      },
      ".cm-content": { padding: "12px 0 20px", caretColor: "var(--accent)" },
      ".cm-line": { padding: "0 18px 0 var(--editor-text-inset)" },
      ".cm-gutters": {
        backgroundColor: "var(--editor-bg)",
        color: "var(--text-faint)",
        border: "none",
        paddingLeft: "4px",
        "&.cm-gutters-before": { borderRight: "1px solid var(--border)" },
      },
      ".cm-lineNumbers .cm-gutterElement": { minWidth: "32px", padding: "0 8px 0 4px" },
      ".cm-activeLine": { backgroundColor: "var(--active-line)" },
      ".cm-activeLineGutter": {
        backgroundColor: "var(--active-line)",
        color: "var(--text-muted)",
      },
      ".cm-foldGutter .cm-gutterElement": { color: "var(--text-faint)", padding: "0 2px" },
      ".cm-foldGutter .cm-fold-on-hover": { opacity: 0 },
      ".cm-foldGutter .cm-fold-on-hover:hover": { opacity: 1 },
      ".cm-foldGutter span": {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        height: "1.65em",
        verticalAlign: "top",
      },
      ".cm-foldPlaceholder": {
        backgroundColor: "var(--hover)",
        color: "var(--text-muted)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-small)",
        margin: "0 3px",
        padding: "0 5px",
      },
      ".cm-foldPlaceholder:hover": {
        backgroundColor: "var(--accent-soft)",
        color: "var(--accent)",
        borderColor: "var(--accent)",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: "var(--selection) !important",
      },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
      ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
        backgroundColor: "var(--bracket-match)",
        outline: "1px solid var(--accent-soft)",
      },
      ".cm-searchMatch": { backgroundColor: "var(--search-match)" },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--search-selected)" },
      ".cm-selectionMatch": { backgroundColor: "var(--selection-match)" },
      ".cm-panels": {
        backgroundColor: "var(--surface-raised)",
        color: "var(--text)",
        borderColor: "var(--border)",
      },
      ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
      ".cm-search": { padding: "8px 12px", fontFamily: "var(--font-ui)" },
      ".cm-search label": { color: "var(--text-muted)", fontSize: "12px" },
      ".cm-textfield": {
        backgroundColor: "var(--input-bg)",
        color: "var(--text)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-control)",
        padding: "4px 7px",
        outline: "none",
      },
      ".cm-textfield:focus": { borderColor: "var(--accent)" },
      ".cm-button": {
        backgroundImage: "none",
        backgroundColor: "var(--surface-raised)",
        color: "var(--text-muted)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-control)",
        padding: "3px 8px",
        fontSize: "12px",
      },
      ".cm-button:hover": { backgroundColor: "var(--hover)" },
      ".cm-tooltip": {
        backgroundColor: "var(--surface-raised)",
        border: "1px solid var(--border)",
        color: "var(--text)",
        borderRadius: "var(--radius-control)",
        boxShadow: "var(--shadow-panel)",
      },
      ".cm-tooltip-autocomplete > ul": {
        padding: "4px",
        maxWidth: "min(580px, 72vw)",
        maxHeight: "min(280px, 45vh)",
        minWidth: "min(280px, 60vw)",
        fontFamily: "var(--font-mono)",
        fontSize: "12px",
      },
      ".cm-tooltip-autocomplete > ul > li": {
        display: "flex",
        alignItems: "center",
        gap: "7px",
        minHeight: "25px",
        padding: "0 7px",
        borderRadius: "4px",
      },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "var(--accent-soft)",
        color: "var(--text)",
      },
      ".cm-completionIcon": {
        flex: "0 0 16px",
        width: "16px",
        height: "16px",
        padding: "0",
        textAlign: "center",
        fontSize: "13px",
        lineHeight: "16px",
        opacity: "1",
        borderRadius: "3px",
        color: "var(--icon-data)",
        background: "color-mix(in srgb, currentColor 8%, transparent)",
      },
      ".cm-completionIcon-function, .cm-completionIcon-method, .cm-completionIcon-constructor": {
        color: "var(--accent)",
      },
      ".cm-completionIcon-variable, .cm-completionIcon-property, .cm-completionIcon-constant": {
        color: "var(--icon-code)",
      },
      ".cm-completionLabel, .cm-completionDetail, .completion-origin": {
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        minWidth: "0",
      },
      ".cm-completionLabel": { flex: "0 0 auto", maxWidth: "58%" },
      ".cm-completionMatchedText": {
        color: "var(--accent)",
        fontWeight: "bold",
        textDecoration: "none",
      },
      ".cm-completionDetail, .completion-origin": {
        color: "var(--text-muted)",
        fontSize: "11px",
        fontStyle: "normal",
      },
      ".completion-origin": { marginLeft: "auto", maxWidth: "40%" },
      ".cm-completionInfo": {
        maxWidth: "min(375px, 72vw)",
        maxHeight: "min(220px, 38vh)",
        overflow: "auto",
        padding: "8px 10px",
        fontSize: "12px",
        lineHeight: "1.5",
      },
      ".completion-documentation": { whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
    },
    { dark },
  );
}

export function openEditorSearch(view: EditorView) {
  openSearchPanel(view);
  // Selecting the default panel's input does not guarantee focus.
  view.dom.querySelector<HTMLInputElement>('.cm-search input[name="search"]')?.focus();
  return true;
}

export function initialExtensions(
  theme: ResolvedTheme,
  editable: boolean,
  language: Compartment,
  themeCompartment: Compartment,
  highlightCompartment: Compartment,
  fileName: string,
  onDocumentChanged: (view: EditorView) => void,
) {
  const keyBindings = [
    ...searchKeymap.filter(
      ({ key, run }) =>
        key !== "Mod-f" &&
        run !== gotoLine &&
        run !== selectNextOccurrence &&
        run !== selectSelectionMatches,
    ),
    ...foldKeymap,
    ...(editable ? closeBracketsKeymap : []),
    ...defaultKeymap.filter(
      ({ run }) =>
        ![
          moveLineUp,
          moveLineDown,
          copyLineUp,
          copyLineDown,
          deleteLine,
          deleteLineBoundaryBackward,
          addCursorAbove,
          addCursorBelow,
        ].some((command) => command === run),
    ),
    ...historyKeymap,
  ];
  const extensions = [
    highlightSpecialChars(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    columnSelection,
    matchSelection,
    syntaxSelection,
    rectangularSelection(),
    indentDoubleClick,
    EditorView.domEventObservers({
      pointerdown(event, view) {
        if (
          event.pointerType !== "mouse" ||
          event.button !== 0 ||
          event.shiftKey ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          view.hasFocus ||
          view.compositionStarted
        )
          return;
        // WebView focus can scroll to the old caret. Settle it before mousedown hit-tests.
        const { scrollDOM } = view;
        const { scrollTop, scrollLeft } = scrollDOM;
        view.focus();
        if (scrollDOM.scrollTop !== scrollTop) scrollDOM.scrollTop = scrollTop;
        if (scrollDOM.scrollLeft !== scrollLeft) scrollDOM.scrollLeft = scrollLeft;
      },
    }),
    ...(editable ? [closeBrackets()] : []),
    history(),
    EditorState.readOnly.of(!editable),
    EditorView.editable.of(editable),
    EditorView.contentAttributes.of(() => ({
      "aria-label": t("{0}代码文件 {1}", editable ? "" : t("只读"), fileName),
      tabindex: "0",
      spellcheck: "false",
      autocapitalize: "off",
      autocorrect: "off",
    })),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onDocumentChanged(update.view);
    }),
    search({ top: true }),
    tooltips({ tooltipSpace: (view) => view.scrollDOM.getBoundingClientRect() }),
    highlightSelectionMatches(),
    keymap.of(keyBindings),
    themeCompartment.of(editorTheme(theme === "dark")),
    highlightCompartment.of(
      syntaxHighlighting(theme === "dark" ? oneDarkHighlightStyle : defaultHighlightStyle, {
        fallback: true,
      }),
    ),
    language.of([]),
  ];
  return extensions;
}

export function preferenceExtensions(
  preferences: Preferences,
  mode: TextFile["mode"],
  editable: boolean,
  text: string,
  fileName: string,
  onNavigate: ((target: NavigationTarget) => boolean) | undefined,
  onCopyLocation: (view: EditorView) => boolean,
) {
  const shortcuts = resolveShortcuts(preferences.shortcuts);
  const plainText = mode !== "normal" || !matchLanguage(fileName).description;
  const navigate = (view: EditorView, target: NavigationTarget) => {
    if (!onNavigate?.(target)) return false;
    view.focus();
    return true;
  };
  const extensions: Extension[] = [
    Prec.high(shortcutKeymap(shortcuts, { find: openEditorSearch }, "editor search-panel")),
    Prec.high(
      shortcutKeymap(
        shortcuts,
        {
          "replace-in-file": editorCommands["replace-in-file"],
        },
        "search-panel",
      ),
    ),
    Prec.high(
      shortcutKeymap(shortcuts, {
        ...editorCommands,
        "move-statement-up": plainText
          ? editorCommands["move-line-up"]
          : editorCommands["move-statement-up"],
        "move-statement-down": plainText
          ? editorCommands["move-line-down"]
          : editorCommands["move-statement-down"],
        "copy-location": onCopyLocation,
      }),
    ),
    EditorState.tabSize.of(preferences.tabSize),
    indentUnit.of(
      mode === "normal"
        ? detectIndentation(text, preferences.tabSize)
        : " ".repeat(preferences.tabSize),
    ),
  ];
  if (preferences.lineNumbers) extensions.push(lineNumbers());
  if (preferences.highlightActiveLine)
    extensions.push(highlightActiveLine(), highlightActiveLineGutter());
  if (preferences.indentWithTab && editable) extensions.push(keymap.of([indentWithTab]));
  if (mode === "normal") {
    // Runs before the default keymaps, which bind the same keys to other commands.
    extensions.push(
      Prec.high(
        shortcutKeymap(shortcuts, {
          "next-problem": nextDiagnostic,
          "prev-problem": previousDiagnostic,
          back: (view) => navigate(view, "back"),
          forward: (view) => navigate(view, "forward"),
          definition: (view) => navigate(view, "definition"),
          references: (view) => navigate(view, "references"),
          implementation: (view) => navigate(view, "implementation"),
        }),
      ),
      rainbowBrackets,
    );
    if (preferences.showStickyScroll) extensions.push(stickyScroll);
    if (preferences.showIndentGuides) extensions.push(indentGuides);
    if (preferences.wordWrap) extensions.push(EditorView.lineWrapping);
    if (preferences.matchBrackets) extensions.push(bracketMatching());
    if (preferences.codeFolding)
      extensions.push(
        Prec.low(
          foldGutter({
            markerDOM(open) {
              const marker = document.createElement("span");
              marker.className = open ? "cm-fold-open cm-fold-on-hover" : "cm-fold-closed";
              marker.dataset.tooltip = open ? t("折叠代码") : t("展开代码");
              marker.setAttribute("aria-label", marker.dataset.tooltip);
              const path = open ? "m3 4.5 3 3 3-3" : "m4.5 3 3 3-3 3";
              marker.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="${path}"/></svg>`;
              return marker;
            },
          }),
        ),
      );
  }
  return extensions;
}

export function createCodeReaderExtensions({
  compartments,
  theme,
  content,
  fileName,
  projectId,
  filePath,
  preferences,
  onNavigate,
  onCopyLocation,
  onDocumentChanged,
  onGitChangeSelect,
  canGoToDefinition,
  onGoToDefinition,
  onOpenFileLink,
  onUpdate,
  isLocked,
}: CreateCodeReaderExtensionsOptions): Extension[] {
  return [
    compartments.locale.of([]),
    compartments.diagnostics.of([]),
    compartments.autoImport.of([]),
    Prec.lowest(gitChangeGutter(onGitChangeSelect)),
    initialExtensions(
      theme,
      content.editable,
      compartments.language,
      compartments.theme,
      compartments.highlight,
      fileName,
      onDocumentChanged,
    ),
    content.mode === "normal"
      ? definitionLink(projectId, filePath, canGoToDefinition, onGoToDefinition, onOpenFileLink)
      : [],
    compartments.languageTools.of([]),
    compartments.aiCompletion.of([]),
    compartments.minimap.of([]),
    compartments.preferences.of(
      preferenceExtensions(
        preferences,
        content.mode,
        content.editable,
        content.content,
        fileName,
        onNavigate,
        onCopyLocation,
      ),
    ),
    compartments.operation.of(
      isLocked()
        ? Prec.highest([EditorState.readOnly.of(true), EditorView.editable.of(false)])
        : [],
    ),
    EditorView.updateListener.of(onUpdate),
    EditorState.transactionFilter.of((transaction) =>
      transaction.docChanged && isLocked() ? [] : transaction,
    ),
  ];
}
