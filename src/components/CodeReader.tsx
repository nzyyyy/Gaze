import { t, useLanguage } from "../lib/i18n";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useId,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { flushSync } from "react-dom";
import { closeBrackets, closeBracketsKeymap, closeCompletion } from "@codemirror/autocomplete";
import {
  forEachDiagnostic,
  nextDiagnostic,
  previousDiagnostic,
  setDiagnostics,
  setDiagnosticsEffect,
} from "@codemirror/lint";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  isolateHistory,
} from "@codemirror/commands";
import {
  bracketMatching,
  indentUnit,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";
import { Compartment, EditorState, Prec, type Extension, type Text } from "@codemirror/state";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import {
  closeHoverTooltips,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  tooltips,
} from "@codemirror/view";
import { AlertCircle, FileQuestion, LoaderCircle, RotateCcw } from "lucide-react";

import { gitChangeGutter, setChangeBlocks } from "../git/editorChanges";
import { useFileBase } from "../git/hooks/useFileBase";
import { computeChangeBlocksAsync } from "../git/lineDiffClient";
import type { ChangeBlock } from "../git/lineDiff";
import { api, type RecoveryRecord } from "../lib/api";
import { codeDiagnostics } from "../lib/diagnostics";
import { autoImportExtension } from "../lib/autoImport";
import { codeCompletion } from "../lib/completion";
import { definitionLink } from "../lib/definitionLink";
import { detectIndentation } from "../lib/indentation";
import {
  dismissEditorLanguageTooltip,
  editorLanguageTools,
  runEditorLanguageAction,
  type EditorLanguageAction,
} from "../lib/editorLanguageTools";
import { indentGuides } from "../lib/indentGuides";
import { DEFAULT_PREFERENCES, type Preferences } from "../lib/preferences";
import { rainbowBrackets } from "../lib/rainbowBrackets";
import { stickyScroll, syntaxSelection } from "../lib/readingTools";
import type { EditorViewState } from "../lib/session";
import { isMarkdownFile, matchLanguage } from "../lib/language";
import {
  useBuiltinFeature,
  useEditorCompletion,
  usePlugins,
  useSemanticAvailability,
} from "../plugins/runtime";
import { EditorProblems, type EditorProblem } from "./EditorProblems";
import { Select } from "./Select";
import type {
  EditorPane,
  EditorStatus,
  FileContent,
  ResolvedTheme,
  PositionEncoding,
  NavigationResult,
  TextFile,
  TextPosition,
} from "../lib/types";
import { errorCode, errorMessage } from "../lib/utils";

const AUTO_SAVE_MIN_INTERVAL_MS = 1500;
const RECOVERY_SAVE_DELAY_MS = 500;
const GIT_DIFF_DELAY_MS = 300;
const MARKDOWN_PREVIEW_DELAY_MS = 120;
const GIT_DIFF_MAX_BYTES = 1024 * 1024;
const GIT_DIFF_MAX_LINES = 20_000;

const MarkdownPreview = lazy(() =>
  import("./MarkdownPreview").catch(() => ({
    default: () => (
      <div className="reader-state" role="alert">
        {t("预览加载失败，请切回源码或重新打开应用。")}
      </div>
    ),
  })),
);

export interface MarkdownPreviewRequest {
  fragment: string | null;
  nonce: number;
}

export interface EditorTab {
  key: string;
  projectId: string;
  projectName: string;
  path: string;
  name: string;
  root?: string;
  pane?: EditorPane;
}

export interface RevealRequest {
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  encoding?: PositionEncoding;
  nonce: number;
}

export interface SaveResult {
  status: "saved" | "clean" | "readonly" | "conflict" | "error";
  message?: string;
}

export interface CodeReaderHandle {
  getCursor(): TextPosition | null;
  getNavigationAnchor(position: TextPosition): { x: number; top: number; bottom: number } | null;
  getViewState(): EditorViewState | null;
  reveal(request: RevealRequest): void;
  openFileSearch(): void;
  dismissPopups(): void;
  runEditorAction(action: EditorLanguageAction): Promise<void> | undefined;
  focus(): void;
  getText(): string | null;
  isDirty(): boolean;
  save(options?: { force?: boolean }): Promise<SaveResult>;
  discardRecovery(): Promise<void>;
  reloadFromDisk(): void;
  prepareFileOperation(options?: { save?: boolean }): Promise<SaveResult>;
  finishFileOperation(options?: { reload?: boolean }): void;
}

interface EditorSurfaceProps {
  tab: EditorTab;
  gitLocked?: boolean;
  active: boolean;
  editorPopupsBlocked?: boolean;
  theme: ResolvedTheme;
  fontFamily?: string;
  preferences?: Preferences;
  initialView?: EditorViewState;
  reveal: RevealRequest | null;
  reloadToken: number;
  externalChangeToken: number;
  pythonRevision?: number;
  previewRequest?: MarkdownPreviewRequest | null;
  onGoToDefinition?: (position: TextPosition, result: NavigationResult) => void;
  onOpenMarkdownFile?: (projectId: string, path: string, fragment: string | null) => void;
  onNotice?: (message: string) => void;
  onStatus: (status: EditorStatus | null) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
  ref?: Ref<CodeReaderHandle>;
}

interface LoadedState {
  content: FileContent;
  revision: number;
}

type PauseReason = "conflict" | "external" | "error" | null;

function editorTheme(
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
        paddingLeft: "8px",
        "&.cm-gutters-before": { borderRight: "1px solid var(--border)" },
      },
      ".cm-lineNumbers .cm-gutterElement": { minWidth: "32px", padding: "0 10px 0 4px" },
      ".cm-activeLine": { backgroundColor: "var(--active-line)" },
      ".cm-activeLineGutter": {
        backgroundColor: "var(--active-line)",
        color: "var(--text-muted)",
      },
      ".cm-foldGutter .cm-gutterElement": { color: "var(--text-faint)", padding: "0 4px" },
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

function normalizeDocumentText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function offsetAt(
  doc: EditorState["doc"],
  line: number,
  character: number,
  encoding: PositionEncoding = "utf-16",
): number {
  const lineInfo = doc.line(Math.min(Math.max(0, line) + 1, doc.lines));
  const limit = Math.max(0, character);
  if (encoding === "utf-16") return lineInfo.from + Math.min(limit, lineInfo.length);
  let units = 0;
  let offset = lineInfo.from;
  const encoder = new TextEncoder();
  for (const char of lineInfo.text) {
    if (units >= limit) break;
    units += encoding === "utf-8" ? encoder.encode(char).length : 1;
    if (units > limit) break;
    offset += char.length;
  }
  return offset;
}

function openEditorSearch(view: EditorView) {
  openSearchPanel(view);
  // Selecting the default panel's input does not guarantee focus.
  view.dom.querySelector<HTMLInputElement>('.cm-search input[name="search"]')?.focus();
  return true;
}

function initialExtensions(
  theme: ResolvedTheme,
  editable: boolean,
  language: Compartment,
  themeCompartment: Compartment,
  highlightCompartment: Compartment,
  fileName: string,
  onDocumentChanged: (view: EditorView) => void,
) {
  const keyBindings = [
    { key: "Mod-f", run: openEditorSearch, scope: "editor search-panel" },
    ...searchKeymap,
    ...foldKeymap,
    ...(editable ? closeBracketsKeymap : []),
    ...defaultKeymap,
    ...historyKeymap,
  ];
  const extensions = [
    highlightSpecialChars(),
    drawSelection(),
    rectangularSelection(),
    ...(editable ? [closeBrackets()] : []),
    history(),
    EditorState.readOnly.of(!editable),
    EditorView.editable.of(editable),
    EditorView.contentAttributes.of(() => ({
      "aria-label": t("{0}代码文件 {1}", editable ? "" : t("只读"), fileName),
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

function preferenceExtensions(
  preferences: Preferences,
  mode: TextFile["mode"],
  editable: boolean,
  text: string,
) {
  const extensions: Extension[] = [
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
    extensions.push(
      rainbowBrackets,
      syntaxSelection,
      keymap.of([
        { key: "F2", run: nextDiagnostic },
        { key: "Shift-F2", run: previousDiagnostic },
      ]),
    );
    if (preferences.showStickyScroll) extensions.push(stickyScroll);
    if (preferences.showIndentGuides) extensions.push(indentGuides);
    if (preferences.wordWrap) extensions.push(EditorView.lineWrapping);
    if (preferences.matchBrackets) extensions.push(bracketMatching());
    if (preferences.codeFolding)
      extensions.push(
        foldGutter({
          markerDOM(open) {
            const marker = document.createElement("span");
            marker.dataset.tooltip = open ? t("折叠代码") : t("展开代码");
            marker.setAttribute("aria-label", marker.dataset.tooltip);
            const path = open ? "m3 4.5 3 3 3-3" : "m4.5 3 3 3-3 3";
            marker.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="${path}"/></svg>`;
            return marker;
          },
        }),
      );
  }
  return extensions;
}

export function CodeReader({
  tab,
  gitLocked = false,
  active,
  editorPopupsBlocked = false,
  theme,
  fontFamily,
  preferences = DEFAULT_PREFERENCES,
  initialView,
  reveal,
  reloadToken,
  externalChangeToken,
  pythonRevision,
  previewRequest,
  onOpenMarkdownFile,
  onGoToDefinition,
  onNotice,
  onStatus,
  onDirtyChange,
  onSaved,
  ref,
}: EditorSurfaceProps) {
  const language = useLanguage();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const diagnosticsCompartment = useRef(new Compartment());
  const autoImportCompartment = useRef(new Compartment());
  const languageToolsCompartment = useRef(new Compartment());
  const aiCompletionCompartment = useRef(new Compartment());
  const previousPythonRevision = useRef(pythonRevision);
  const localeCompartment = useRef(new Compartment());
  const themeCompartment = useRef(new Compartment());
  const preferencesCompartment = useRef(new Compartment());
  const minimapCompartment = useRef(new Compartment());
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const highlightCompartment = useRef(new Compartment());
  const languageCompartment = useRef(new Compartment());
  const operationCompartment = useRef(new Compartment());
  const operationLockedRef = useRef(false);
  const gitLockedRef = useRef(gitLocked);
  gitLockedRef.current = gitLocked;
  const operationCursorRef = useRef<number | null>(null);
  const initialViewRef = useRef(initialView);
  const initialViewDocumentRef = useRef<LoadedState | null>(null);
  const revealRef = useRef(reveal);
  const activeRef = useRef(active);
  const editorPopupsBlockedRef = useRef(editorPopupsBlocked);
  editorPopupsBlockedRef.current = editorPopupsBlocked;
  const onNoticeRef = useRef(onNotice);
  onNoticeRef.current = onNotice;
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onSavedRef = useRef(onSaved);
  const onOpenFileLinkRef = useRef(onOpenMarkdownFile);
  onOpenFileLinkRef.current = onOpenMarkdownFile;
  const onGoToDefinitionRef = useRef(onGoToDefinition);
  onGoToDefinitionRef.current = onGoToDefinition;
  const documentRef = useRef<TextFile | null>(null);
  const baselineRef = useRef("");
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const inFlightRef = useRef<Promise<SaveResult> | null>(null);
  const autoSaveTimerRef = useRef<number | null>(null);
  const recoveryTimerRef = useRef<number | null>(null);
  const recoveryQueueRef = useRef<Promise<void>>(Promise.resolve());
  const ignoreRecoveryRef = useRef(false);
  const lastSavedAtRef = useRef(0);
  const pauseReasonRef = useRef<PauseReason>(null);
  const generationRef = useRef(0);
  const saveRef = useRef<(options?: { force?: boolean }) => Promise<SaveResult>>(async () => ({
    status: "clean",
  }));
  const scheduleAutoSaveRef = useRef<() => void>(() => undefined);
  const gitBase = useFileBase(tab.projectId, tab.path, active);
  const gitBaseRef = useRef<string | null>(null);
  const gitDiffTimerRef = useRef<number | null>(null);
  const gitDiffRequestRef = useRef(0);
  const gitSelectRef = useRef<(block: ChangeBlock, element: HTMLElement) => void>(() => undefined);

  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [localReload, setLocalReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [languageLabel, setLanguageLabel] = useState("Plain Text");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pauseReason, setPauseReason] = useState<PauseReason>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<RecoveryRecord | null>(null);
  const [lineCount, setLineCount] = useState(1);
  const [problems, setProblems] = useState<{ doc: Text; items: EditorProblem[] }>();
  const [preview, setPreview] = useState(false);
  const [previewText, setPreviewText] = useState("");
  const previewTimerRef = useRef<number | null>(null);
  const [previewNotice, setPreviewNotice] = useState<string | null>(null);
  const markdown = isMarkdownFile(tab.name);
  const editorCompletion = useEditorCompletion(
    markdown ? "Markdown" : "",
    preferences.markdownInsertEnabled,
  );
  const pathFeature = useBuiltinFeature("pathCompletionEnabled", preferences.pathCompletionEnabled);
  const plugins = usePlugins();
  const pluginMenuId = useId();
  const pluginRequest = useRef<AbortController | null>(null);
  const semanticEnabled = useSemanticAvailability(tab.name, preferences);
  const inlineCompletion = useBuiltinFeature(
    "aiCompletionEnabled",
    preferences.aiCompletionEnabled,
  );
  const minimap = useBuiltinFeature("showMinimap", preferences.showMinimap);
  const previewVisible =
    preview && markdown && loaded?.content.kind === "text" && loaded.content.mode === "normal";
  const canShowQuickDocumentation =
    active &&
    semanticEnabled &&
    !previewVisible &&
    !tab.projectId.startsWith("external:") &&
    loaded?.content.kind === "text" &&
    loaded.content.mode === "normal";
  const canUseEditorActions =
    canShowQuickDocumentation &&
    !gitLocked &&
    loaded?.content.kind === "text" &&
    loaded.content.editable;
  const pathCompletion = useMemo(
    () =>
      active && !previewVisible && !gitLocked && !tab.projectId.startsWith("external:")
        ? pathFeature?.(tab.projectId, tab.path, markdown)
        : undefined,
    [active, previewVisible, gitLocked, pathFeature, tab.projectId, tab.path, markdown],
  );
  useEffect(
    () => () => pluginRequest.current?.abort(),
    [active, tab.key, loaded, previewVisible, gitLocked],
  );
  const previewRef = useRef(false);
  const lastPreviewRequestRef = useRef<MarkdownPreviewRequest | null>(null);
  previewRef.current = previewVisible;
  const [gitBlocks, setGitBlocks] = useState<ChangeBlock[]>([]);
  const [changePopup, setChangePopup] = useState<{
    block: ChangeBlock;
    left: number;
    top: number;
  } | null>(null);

  revealRef.current = reveal;
  activeRef.current = active;
  gitBaseRef.current = gitBase;
  onDirtyChangeRef.current = onDirtyChange;
  onSavedRef.current = onSaved;

  const clearAutoSaveTimer = useCallback(() => {
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, []);

  const clearRecoveryTimer = useCallback(() => {
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
  }, []);

  const enqueueRecovery = useCallback((operation: () => Promise<unknown>) => {
    const pending = recoveryQueueRef.current.then(operation).then(
      () => undefined,
      () => undefined,
    );
    recoveryQueueRef.current = pending;
    return pending;
  }, []);

  const deleteRecovery = useCallback(() => {
    clearRecoveryTimer();
    return enqueueRecovery(() => api.deleteRecovery(tab.projectId, tab.path));
  }, [clearRecoveryTimer, enqueueRecovery, tab.path, tab.projectId]);

  const discardRecovery = useCallback(() => {
    setRecovery(null);
    return deleteRecovery();
  }, [deleteRecovery]);

  const scheduleRecovery = useCallback(
    (view: EditorView) => {
      clearRecoveryTimer();
      if (!dirtyRef.current) return;
      recoveryTimerRef.current = window.setTimeout(() => {
        recoveryTimerRef.current = null;
        if (viewRef.current !== view || !dirtyRef.current) return;
        const fingerprint = documentRef.current?.fingerprint;
        if (!fingerprint) return;
        const content = view.state.doc.toString();
        void enqueueRecovery(() =>
          api.writeRecovery(tab.projectId, tab.path, content, fingerprint),
        );
      }, RECOVERY_SAVE_DELAY_MS);
    },
    [clearRecoveryTimer, enqueueRecovery, tab.path, tab.projectId],
  );
  const scheduleRecoveryRef = useRef(scheduleRecovery);
  const deleteRecoveryRef = useRef(deleteRecovery);
  scheduleRecoveryRef.current = scheduleRecovery;
  deleteRecoveryRef.current = deleteRecovery;

  const pauseAutoSave = useCallback(
    (reason: Exclude<PauseReason, null>, message: string | null) => {
      pauseReasonRef.current = reason;
      setPauseReason(reason);
      setSaveError(message);
      clearAutoSaveTimer();
    },
    [clearAutoSaveTimer],
  );

  const resumeAutoSave = useCallback(() => {
    pauseReasonRef.current = null;
    setPauseReason(null);
    setSaveError(null);
  }, []);

  const scheduleAutoSave = useCallback(() => {
    clearAutoSaveTimer();
    if (
      !preferencesRef.current.autoSave ||
      !documentRef.current?.editable ||
      pauseReasonRef.current ||
      operationLockedRef.current ||
      gitLockedRef.current
    )
      return;
    const wait = Math.max(
      preferencesRef.current.autoSaveDelay,
      AUTO_SAVE_MIN_INTERVAL_MS - (Date.now() - lastSavedAtRef.current),
    );
    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null;
      if (viewRef.current?.composing) {
        scheduleAutoSaveRef.current();
        return;
      }
      if (dirtyRef.current && !pauseReasonRef.current && !savingRef.current) {
        void saveRef.current();
      }
    }, wait);
  }, [clearAutoSaveTimer]);

  scheduleAutoSaveRef.current = scheduleAutoSave;

  useEffect(() => {
    const locked = gitLocked || operationLockedRef.current;
    if (locked) clearAutoSaveTimer();
    viewRef.current?.dispatch({
      effects: operationCompartment.current.reconfigure(
        locked ? Prec.highest([EditorState.readOnly.of(true), EditorView.editable.of(false)]) : [],
      ),
    });
    if (!locked && dirtyRef.current) scheduleAutoSaveRef.current();
  }, [gitLocked, clearAutoSaveTimer]);

  const refreshGitChanges = useCallback((view: EditorView) => {
    const request = ++gitDiffRequestRef.current;
    if (!activeRef.current) return;
    const base = gitBaseRef.current;
    const doc = view.state.doc;
    const tooLarge = doc.length > GIT_DIFF_MAX_BYTES || doc.lines > GIT_DIFF_MAX_LINES;
    const apply = (blocks: ChangeBlock[]) => {
      if (request !== gitDiffRequestRef.current || viewRef.current !== view || !activeRef.current)
        return;
      setGitBlocks(blocks);
      view.dispatch({ effects: setChangeBlocks.of(blocks) });
    };
    if (base == null || tooLarge) {
      apply([]);
      return;
    }
    void computeChangeBlocksAsync(base, doc.toString()).then(apply, () => apply([]));
  }, []);

  const jumpToChange = useCallback((block: ChangeBlock) => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc;
    const line = doc.line(Math.min(Math.max(1, block.from), doc.lines));
    view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    view.focus();
  }, []);

  const scheduleGitDiff = useCallback(
    (view: EditorView) => {
      if (gitBaseRef.current === null) return;
      if (gitDiffTimerRef.current !== null) window.clearTimeout(gitDiffTimerRef.current);
      gitDiffTimerRef.current = window.setTimeout(() => {
        gitDiffTimerRef.current = null;
        if (viewRef.current === view) refreshGitChanges(view);
      }, GIT_DIFF_DELAY_MS);
    },
    [refreshGitChanges],
  );
  const scheduleGitDiffRef = useRef(scheduleGitDiff);
  scheduleGitDiffRef.current = scheduleGitDiff;

  const openChangePopup = useCallback((block: ChangeBlock, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setChangePopup({
      block,
      left: Math.max(8, Math.min(rect.right + 8, window.innerWidth - 376)),
      top: Math.max(8, Math.min(rect.top, window.innerHeight - 268)),
    });
  }, []);
  gitSelectRef.current = openChangePopup;

  const revertChange = useCallback((block: ChangeBlock) => {
    const view = viewRef.current;
    if (
      !view ||
      !documentRef.current?.editable ||
      operationLockedRef.current ||
      gitLockedRef.current
    )
      return;
    const doc = view.state.doc;
    if (block.kind === "deleted") {
      const text = block.oldLines.join("\n");
      const beforeLine = block.from <= doc.lines;
      view.dispatch({
        changes: beforeLine
          ? { from: doc.line(block.from).from, insert: `${text}\n` }
          : { from: doc.length, insert: `\n${text}` },
        userEvent: "delete.revert",
        scrollIntoView: false,
      });
    } else {
      const start = doc.line(Math.min(Math.max(1, block.from), doc.lines));
      const end = doc.line(Math.min(Math.max(block.to, start.number), doc.lines));
      view.dispatch({
        changes: { from: start.from, to: end.to, insert: block.oldLines.join("\n") },
        userEvent: "delete.revert",
        scrollIntoView: false,
      });
    }
    setChangePopup(null);
  }, []);

  const save = useCallback(
    async (options?: { force?: boolean; forFileOperation?: boolean }): Promise<SaveResult> => {
      if ((operationLockedRef.current || gitLockedRef.current) && !options?.forFileOperation) {
        return { status: "error", message: t("文件操作进行中，请稍候。") };
      }
      clearAutoSaveTimer();
      if (inFlightRef.current) return inFlightRef.current;
      const view = viewRef.current;
      const document = documentRef.current;
      if (!view || !document) return { status: "clean" };
      if (!document.editable) {
        return {
          status: "readonly",
          message: document.editBlockedReason ?? t("当前文件只支持阅读。"),
        };
      }
      const text = view.state.doc.toString();
      if (!options?.force && !dirtyRef.current && text === baselineRef.current) {
        return { status: "clean" };
      }
      const generation = generationRef.current;
      const promise = (async (): Promise<SaveResult> => {
        savingRef.current = true;
        setSaving(true);
        try {
          const result = await api.writeFile(
            tab.projectId,
            tab.path,
            text,
            document.fingerprint,
            document.encodingKind,
            document.lineEnding,
            options?.force ?? false,
          );
          onSavedRef.current();
          if (generation === generationRef.current) {
            document.fingerprint = result.fingerprint;
            document.size = result.size;
            baselineRef.current = text;
            lastSavedAtRef.current = Date.now();
            const stillDirty = view.state.doc.toString() !== text;
            dirtyRef.current = stillDirty;
            setDirty(stillDirty);
            setRecovery(null);
            void deleteRecovery();
            resumeAutoSave();
            if (stillDirty) {
              scheduleRecoveryRef.current(view);
              scheduleAutoSaveRef.current();
            }
          }
          return { status: "saved" };
        } catch (reason) {
          if (generation === generationRef.current) {
            if (errorCode(reason) === "conflict") {
              pauseAutoSave("conflict", errorMessage(reason));
              return { status: "conflict", message: errorMessage(reason) };
            }
            pauseAutoSave("error", errorMessage(reason));
          }
          return { status: "error", message: errorMessage(reason) };
        } finally {
          savingRef.current = false;
          setSaving(false);
          inFlightRef.current = null;
        }
      })();
      inFlightRef.current = promise;
      return promise;
    },
    [clearAutoSaveTimer, deleteRecovery, pauseAutoSave, resumeAutoSave, tab.path, tab.projectId],
  );

  saveRef.current = save;

  const reloadFromDisk = useCallback(() => {
    clearAutoSaveTimer();
    ignoreRecoveryRef.current = true;
    setRecovery(null);
    void deleteRecovery();
    resumeAutoSave();
    setLocalReload((value) => value + 1);
  }, [clearAutoSaveTimer, deleteRecovery, resumeAutoSave]);

  const restoreRecovery = useCallback(() => {
    const view = viewRef.current;
    const document = documentRef.current;
    if (!recovery || !view || !document?.editable) return;
    document.fingerprint = recovery.originalFingerprint;
    setRecovery(null);
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: normalizeDocumentText(recovery.content),
      },
      userEvent: "input.recover",
    });
    view.focus();
  }, [recovery]);

  const showPreview = useCallback(() => {
    if (!viewRef.current) return;
    if (previewTimerRef.current !== null) window.clearTimeout(previewTimerRef.current);
    previewTimerRef.current = null;
    setPreviewText(viewRef.current.state.doc.toString());
    setPreviewNotice(null);
    setChangePopup(null);
    setPreview(true);
  }, []);

  const previewMessage = useCallback(
    (message: string) => {
      if (onNotice) onNotice(message);
      else setPreviewNotice(message);
    },
    [onNotice],
  );

  useImperativeHandle(
    ref,
    () => ({
      getCursor() {
        const view = viewRef.current;
        if (!view) return null;
        const head = view.state.selection.main.head;
        const line = view.state.doc.lineAt(head);
        return { line: line.number - 1, character: head - line.from };
      },
      getNavigationAnchor(position) {
        const view = viewRef.current;
        if (!view) return null;
        const rect = view.coordsAtPos(offsetAt(view.state.doc, position.line, position.character));
        if (!rect) return null;
        const bounds = view.scrollDOM.getBoundingClientRect();
        if (rect.top < bounds.top || rect.bottom > bounds.bottom) return null;
        return { x: rect.left, top: rect.top, bottom: rect.bottom };
      },
      getViewState() {
        const view = viewRef.current;
        if (!view) return null;
        const head = view.state.selection.main.head;
        const line = view.state.doc.lineAt(head);
        return {
          line: line.number - 1,
          character: head - line.from,
          scrollTop: view.scrollDOM.scrollTop,
        };
      },
      reveal(request) {
        setPreview(false);
        if (viewRef.current) applyReveal(viewRef.current, request);
      },
      openFileSearch() {
        flushSync(() => setPreview(false));
        if (viewRef.current) {
          openEditorSearch(viewRef.current);
        }
      },
      dismissPopups() {
        const view = viewRef.current;
        if (!view) return;
        dismissEditorLanguageTooltip(view);
        closeCompletion(view);
      },
      runEditorAction(action) {
        const view = viewRef.current;
        if (!view || !activeRef.current || previewRef.current) return;
        view.focus();
        return runEditorLanguageAction(view, action);
      },
      focus() {
        viewRef.current?.focus();
      },
      getText() {
        return viewRef.current?.state.doc.toString() ?? null;
      },
      isDirty() {
        return dirtyRef.current;
      },
      save,
      discardRecovery,
      reloadFromDisk,
      async prepareFileOperation(options) {
        operationLockedRef.current = true;
        clearAutoSaveTimer();
        viewRef.current?.dispatch({
          effects: operationCompartment.current.reconfigure(
            Prec.highest([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
          ),
        });
        if (inFlightRef.current) {
          const result = await inFlightRef.current;
          if (result.status !== "saved" && result.status !== "clean") return result;
        }
        if (options?.save === false) return { status: "clean" };
        if (!dirtyRef.current) return { status: "clean" };
        if (pauseReasonRef.current === "conflict" || pauseReasonRef.current === "external") {
          return { status: "conflict", message: t("请先处理文件的磁盘冲突，再执行文件操作。") };
        }
        return save({ forFileOperation: true });
      },
      finishFileOperation(options) {
        if (options?.reload) {
          clearAutoSaveTimer();
          operationCursorRef.current = viewRef.current?.state.selection.main.head ?? null;
          viewRef.current?.destroy();
          viewRef.current = null;
          documentRef.current = null;
          dirtyRef.current = false;
          setDirty(false);
          onDirtyChangeRef.current(false);
          setLoaded(null);
          setLoading(true);
          reloadFromDisk();
        }
        operationLockedRef.current = false;
        viewRef.current?.dispatch({
          effects: operationCompartment.current.reconfigure(
            gitLockedRef.current
              ? Prec.highest([EditorState.readOnly.of(true), EditorView.editable.of(false)])
              : [],
          ),
        });
        if (dirtyRef.current) scheduleAutoSaveRef.current();
      },
    }),
    [clearAutoSaveTimer, discardRecovery, reloadFromDisk, save],
  );

  useEffect(() => {
    let cancelled = false;
    const hasView = viewRef.current !== null;
    if (!hasView) {
      setLoading(true);
      setLoaded(null);
    }
    setError(null);
    setRecovery(null);
    clearAutoSaveTimer();
    const skipRecovery = ignoreRecoveryRef.current;
    ignoreRecoveryRef.current = false;
    const recoveryRequest = skipRecovery
      ? Promise.resolve(null)
      : api.readRecovery(tab.projectId, tab.path).catch(() => null);
    Promise.all([api.readFile(tab.projectId, tab.path), recoveryRequest])
      .then(([content, recovery]) => {
        if (cancelled) return;
        const diskText = content.kind === "text" ? normalizeDocumentText(content.content) : null;
        const alreadySaved =
          recovery !== null && diskText === normalizeDocumentText(recovery.content);
        if (alreadySaved) void deleteRecovery();
        setRecovery(content.kind === "text" && recovery && !alreadySaved ? recovery : null);
        const view = viewRef.current;
        if (view && content.kind === "text" && diskText === view.state.doc.toString()) {
          documentRef.current = content;
          baselineRef.current = normalizeDocumentText(content.content);
          dirtyRef.current = false;
          setDirty(false);
          setLineCount(view.state.doc.lines);
          resumeAutoSave();
          setLoading(false);
          return;
        }
        documentRef.current = content.kind === "text" ? content : null;
        setLoaded({ content, revision: reloadToken + localReload });
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        viewRef.current?.destroy();
        viewRef.current = null;
        setError(errorMessage(reason));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    tab.projectId,
    tab.path,
    reloadToken,
    localReload,
    retryToken,
    clearAutoSaveTimer,
    deleteRecovery,
    resumeAutoSave,
  ]);

  useEffect(() => {
    if (!surfaceRef.current || !loaded || loaded.content.kind !== "text") {
      return;
    }
    const content = loaded.content;
    generationRef.current += 1;
    documentRef.current = content;
    const normalizedContent = normalizeDocumentText(content.content);
    baselineRef.current = normalizedContent;
    dirtyRef.current = false;
    setDirty(false);
    setLineCount(normalizedContent === "" ? 1 : normalizedContent.split("\n").length);
    setProblems(undefined);
    resumeAutoSave();
    clearAutoSaveTimer();
    const match = matchLanguage(markdown ? tab.name.toLowerCase() : tab.name);
    setLanguageLabel(match.label);
    let cancelled = false;
    const state = EditorState.create({
      doc: content.content,
      selection: { anchor: Math.min(operationCursorRef.current ?? 0, normalizedContent.length) },
      extensions: [
        localeCompartment.current.of([]),
        diagnosticsCompartment.current.of([]),
        autoImportCompartment.current.of([]),
        gitChangeGutter((block, element) => gitSelectRef.current(block, element)),
        initialExtensions(
          theme,
          content.editable,
          languageCompartment.current,
          themeCompartment.current,
          highlightCompartment.current,
          tab.name,
          (view) => {
            const baseline = baselineRef.current;
            const doc = view.state.doc;
            const clean = doc.length === baseline.length && doc.toString() === baseline;
            const nextDirty = !clean;
            setRecovery(null);
            if (dirtyRef.current !== nextDirty) {
              dirtyRef.current = nextDirty;
              setDirty(nextDirty);
            }
            setLineCount(doc.lines);
            if (nextDirty) {
              scheduleRecoveryRef.current(view);
              scheduleAutoSaveRef.current();
            } else {
              clearAutoSaveTimer();
              void deleteRecoveryRef.current();
            }
            scheduleGitDiffRef.current(view);
            if (previewRef.current) {
              if (previewTimerRef.current !== null) window.clearTimeout(previewTimerRef.current);
              previewTimerRef.current = window.setTimeout(() => {
                previewTimerRef.current = null;
                if (previewRef.current && viewRef.current === view)
                  setPreviewText(view.state.doc.toString());
              }, MARKDOWN_PREVIEW_DELAY_MS);
            }
          },
        ),
        content.mode === "normal"
          ? definitionLink(
              tab.projectId,
              tab.path,
              () =>
                (!operationLockedRef.current || gitLockedRef.current) &&
                !!onGoToDefinitionRef.current,
              (position, result) => onGoToDefinitionRef.current?.(position, result),
              (path, fragment) => onOpenFileLinkRef.current?.(tab.projectId, path, fragment),
            )
          : [],
        languageToolsCompartment.current.of([]),
        aiCompletionCompartment.current.of([]),
        minimapCompartment.current.of([]),
        preferencesCompartment.current.of(
          preferenceExtensions(
            preferencesRef.current,
            content.mode,
            content.editable,
            content.content,
          ),
        ),
        operationCompartment.current.of(
          operationLockedRef.current || gitLockedRef.current
            ? Prec.highest([EditorState.readOnly.of(true), EditorView.editable.of(false)])
            : [],
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged || !update.startState.selection.eq(update.state.selection)) {
            pluginRequest.current?.abort();
          }
          if (
            update.transactions.some((transaction) =>
              transaction.effects.some((effect) => effect.is(setDiagnosticsEffect)),
            )
          ) {
            const doc = update.state.doc;
            const items: EditorProblem[] = [];
            forEachDiagnostic(update.state, ({ message, severity }, from, to) => {
              const line = doc.lineAt(from);
              items.push({
                message,
                severity,
                from,
                to,
                line: line.number,
                column: from - line.from + 1,
              });
            });
            setProblems(items.length ? { doc, items } : undefined);
          } else if (update.docChanged) {
            setProblems(undefined);
          }
        }),
        EditorState.transactionFilter.of((transaction) =>
          transaction.docChanged && (operationLockedRef.current || gitLockedRef.current)
            ? []
            : transaction,
        ),
      ],
    });
    const view = new EditorView({ state, parent: surfaceRef.current });
    const restore =
      initialViewDocumentRef.current === null || initialViewDocumentRef.current === loaded
        ? initialViewRef.current
        : undefined;
    initialViewDocumentRef.current = loaded;
    operationCursorRef.current = null;
    viewRef.current = view;
    if (restore) {
      view.dispatch({
        selection: { anchor: offsetAt(view.state.doc, restore.line, restore.character) },
      });
      view.scrollDOM.scrollTop = restore.scrollTop;
    }
    if (previewRef.current) setPreviewText(view.state.doc.toString());
    if (activeRef.current && revealRef.current) applyReveal(view, revealRef.current);

    if (content.mode === "normal" && match.description) {
      match.description
        .load()
        .then((support) => {
          if (cancelled || viewRef.current !== view) return;
          view.dispatch({
            effects: languageCompartment.current.reconfigure(support),
          });
        })
        .catch(() => {
          // The document remains fully readable as plain text.
        });
    }

    return () => {
      cancelled = true;
      clearAutoSaveTimer();
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
    // The editor is rebuilt only when a document revision is loaded.
    // Theme changes are applied through the theme compartment below.
  }, [loaded, tab.name, markdown, clearAutoSaveTimer, resumeAutoSave]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: localeCompartment.current.reconfigure(
        EditorState.phrases.of(
          language === "zh-CN"
            ? {
                Find: "查找",
                Replace: "替换",
                next: "下一个",
                previous: "上一个",
                all: "全部",
                "match case": "区分大小写",
                "by word": "全字匹配",
                regexp: "正则表达式",
                replace: "替换",
                "replace all": "全部替换",
                close: "关闭",
                "current match": "当前匹配",
                "replaced $ matches": "已替换 $ 处匹配",
                "replaced match on line $": "已替换第 $ 行的匹配",
                "on line": "所在行",
                Completions: "补全候选",
              }
            : {},
        ),
      ),
    });
  }, [language, loaded]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (gitDiffTimerRef.current !== null) {
      window.clearTimeout(gitDiffTimerRef.current);
      gitDiffTimerRef.current = null;
    }
    refreshGitChanges(view);
  }, [active, gitBase, loaded, refreshGitChanges]);

  useEffect(
    () => () => {
      if (gitDiffTimerRef.current !== null) window.clearTimeout(gitDiffTimerRef.current);
      if (previewTimerRef.current !== null) window.clearTimeout(previewTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!changePopup) return;
    const closeOnPointer = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".git-change-popover, .cm-git-changes"))
        return;
      setChangePopup(null);
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChangePopup(null);
    };
    document.addEventListener("mousedown", closeOnPointer);
    document.addEventListener("keydown", closeOnKey);
    return () => {
      document.removeEventListener("mousedown", closeOnPointer);
      document.removeEventListener("keydown", closeOnKey);
    };
  }, [changePopup]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        themeCompartment.current.reconfigure(
          editorTheme(theme === "dark", fontFamily, preferences),
        ),
        highlightCompartment.current.reconfigure(
          syntaxHighlighting(theme === "dark" ? oneDarkHighlightStyle : defaultHighlightStyle, {
            fallback: true,
          }),
        ),
      ],
    });
  }, [theme, fontFamily, preferences.editorFontSize, preferences.editorLineHeight, loaded]);

  useEffect(() => {
    const view = viewRef.current;
    const document = documentRef.current;
    if (view && document)
      view.dispatch({
        effects: preferencesCompartment.current.reconfigure(
          preferenceExtensions(preferences, document.mode, document.editable, document.content),
        ),
      });
  }, [preferences, loaded]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: minimapCompartment.current.reconfigure(minimap ?? []) });
  }, [loaded, minimap]);

  useEffect(() => {
    const view = viewRef.current;
    const document = documentRef.current;
    if (!view || document?.mode !== "normal") return;
    closeCompletion(view);
    const wanted = () =>
      viewRef.current === view &&
      activeRef.current &&
      !previewRef.current &&
      !editorPopupsBlockedRef.current &&
      !operationLockedRef.current;
    const notify = (message: string) => onNoticeRef.current?.(message);
    view.dispatch({
      effects: languageToolsCompartment.current.reconfigure([
        // Cancel pending hints before the completion keymap handles Escape.
        canShowQuickDocumentation
          ? editorLanguageTools({
              projectId: tab.projectId,
              path: tab.path,
              autoParameterInfo: preferences.autoParameterInfo,
              hoverEnabled: preferences.quickDocumentationOnHover,
              wanted,
              canEdit: () => !gitLockedRef.current,
              notify,
            })
          : [],
        document.editable
          ? codeCompletion(
              tab.projectId,
              tab.path,
              editorCompletion?.contribution,
              semanticEnabled,
              Boolean(inlineCompletion),
              pathCompletion,
            )
          : [],
      ]),
    });
  }, [
    loaded,
    tab.projectId,
    tab.path,
    editorCompletion,
    semanticEnabled,
    inlineCompletion,
    pathCompletion,
    canShowQuickDocumentation,
    preferences.quickDocumentationOnHover,
    preferences.autoParameterInfo,
    pythonRevision,
  ]);

  useEffect(() => {
    const view = viewRef.current;
    const document = documentRef.current;
    if (!view || document?.mode !== "normal") return;
    const plugin =
      active && !previewVisible && !gitLocked && document.editable ? inlineCompletion : undefined;
    view.dispatch({
      effects: aiCompletionCompartment.current.reconfigure(
        plugin
          ? plugin({
              projectId: tab.projectId,
              path: tab.path,
              language: matchLanguage(markdown ? tab.name.toLowerCase() : tab.name).label,
              reserved: (state) =>
                !!editorCompletion?.reservesCompletion(state) || !!pathCompletion?.reserved(state),
              onError: (message) => onNoticeRef.current?.(message),
            })
          : [],
      ),
    });
  }, [
    active,
    previewVisible,
    gitLocked,
    loaded,
    tab.projectId,
    tab.path,
    tab.name,
    markdown,
    editorCompletion,
    pathCompletion,
    inlineCompletion,
    preferences.aiCompletion,
  ]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const enabled =
      semanticEnabled &&
      active &&
      !previewVisible &&
      loaded?.content.kind === "text" &&
      loaded.content.mode === "normal" &&
      !tab.projectId.startsWith("external:");
    if (!enabled || previousPythonRevision.current !== pythonRevision) {
      previousPythonRevision.current = pythonRevision;
      closeCompletion(view);
      view.dispatch(setDiagnostics(view.state, []), { effects: closeHoverTooltips });
    }
    view.dispatch({
      effects: diagnosticsCompartment.current.reconfigure(
        enabled ? codeDiagnostics(tab.projectId, tab.path) : [],
      ),
    });
  }, [active, loaded, tab.projectId, tab.path, pythonRevision, semanticEnabled, previewVisible]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const enabled = preferences.autoImportEnabled && canUseEditorActions;
    view.dispatch({
      effects: autoImportCompartment.current.reconfigure(
        enabled
          ? autoImportExtension(
              tab.projectId,
              tab.path,
              () =>
                viewRef.current === view &&
                activeRef.current &&
                !previewRef.current &&
                !operationLockedRef.current &&
                !gitLockedRef.current,
            )
          : [],
      ),
    });
  }, [
    canUseEditorActions,
    loaded,
    tab.projectId,
    tab.path,
    preferences.autoImportEnabled,
    pythonRevision,
  ]);

  useEffect(() => {
    clearAutoSaveTimer();
    if (dirtyRef.current) scheduleAutoSaveRef.current();
  }, [preferences.autoSave, preferences.autoSaveDelay, clearAutoSaveTimer]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let disposed = false;
    const measure = () => {
      if (!disposed) view.requestMeasure();
    };
    measure();
    void document.fonts?.load('13.5px "Gaze Maple Mono"').then(measure, measure);
    return () => {
      disposed = true;
    };
  }, [fontFamily, loaded]);

  useEffect(() => {
    if (!active || !reveal || !viewRef.current) return;
    setPreview(false);
    applyReveal(viewRef.current, reveal);
  }, [active, reveal, loaded]);

  useEffect(() => {
    if (!active || !viewRef.current) return;
    viewRef.current.requestMeasure();
  }, [active, previewVisible]);

  useEffect(() => {
    if (
      active &&
      previewRequest &&
      previewRequest !== lastPreviewRequestRef.current &&
      markdown &&
      loaded?.content.kind === "text" &&
      loaded.content.mode === "normal"
    ) {
      lastPreviewRequestRef.current = previewRequest;
      showPreview();
    }
  }, [active, previewRequest, markdown, loaded, showPreview]);

  useEffect(() => {
    if (externalChangeToken === 0 || !dirtyRef.current) return;
    pauseAutoSave("external", t("该文件已在磁盘上被其他程序修改。"));
  }, [externalChangeToken, pauseAutoSave]);

  useEffect(() => {
    if (!active) return;
    if (error || !loaded || loaded.content.kind !== "text") {
      onStatus(null);
      return;
    }
    const text = documentRef.current ?? loaded.content;
    onStatus({
      path: tab.path,
      canUseEditorActions,
      canShowQuickDocumentation,
      language: languageLabel,
      mode: text.mode,
      lines: lineCount,
      readOnly: !text.editable,
      dirty,
      saving,
      autoSavePaused: pauseReason !== null,
      warnings: text.warnings,
      encoding: text.encoding,
    });
  }, [
    active,
    error,
    loaded,
    languageLabel,
    lineCount,
    canUseEditorActions,
    canShowQuickDocumentation,
    dirty,
    saving,
    pauseReason,
    onStatus,
    tab.path,
  ]);

  useEffect(() => {
    onDirtyChangeRef.current(dirty);
  }, [dirty]);

  useEffect(() => clearAutoSaveTimer, [clearAutoSaveTimer]);
  useEffect(() => clearRecoveryTimer, [clearRecoveryTimer]);

  if (loading) {
    return (
      <div className="reader-placeholder" aria-live="polite">
        <LoaderCircle className="spin" size={20} />
        <span>
          {t("正在读取")}
          {tab.name}…
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="reader-state" role="alert">
        <AlertCircle size={26} />
        <h2>{t("无法打开文件")}</h2>
        <p>{error}</p>
        <button className="button" onClick={() => setRetryToken((value) => value + 1)}>
          <RotateCcw size={14} />
          {t("重试")}
        </button>
      </div>
    );
  }

  if (!loaded) {
    return null;
  }

  if (loaded.content.kind === "binary") {
    return (
      <div className="reader-state">
        <FileQuestion size={30} />
        <h2>{t("二进制文件")}</h2>
        <p>
          {t(
            "{0} 包含二进制数据（{1}），不会作为文本渲染。",
            tab.name,
            formatBytes(loaded.content.size),
          )}
        </p>
      </div>
    );
  }

  const runPluginCommand = async (key: string) => {
    const command = plugins?.commands.find((item) => item.key === key);
    const view = viewRef.current;
    if (
      !plugins ||
      !command ||
      !view ||
      !activeRef.current ||
      previewRef.current ||
      view.state.readOnly ||
      operationLockedRef.current ||
      gitLockedRef.current
    )
      return;
    const { doc, selection } = view.state;
    const { from, to } = selection.main;
    if (from === to || selection.ranges.length !== 1) {
      onNoticeRef.current?.(t("请选择一段文本后运行插件命令。"));
      return;
    }
    pluginRequest.current?.abort();
    const request = new AbortController();
    pluginRequest.current = request;
    try {
      const result = await plugins.run(
        command.revision,
        {
          kind: "command",
          id: command.id,
          text: doc.sliceString(from, to),
          language: languageLabel,
        },
        request.signal,
      );
      if (
        result?.kind !== "replace" ||
        request.signal.aborted ||
        !plugins.isEnabled(command.revision)
      )
        return;
      if (
        viewRef.current !== view ||
        !activeRef.current ||
        previewRef.current ||
        view.state.doc !== doc ||
        !view.state.selection.eq(selection) ||
        view.state.readOnly ||
        view.compositionStarted ||
        operationLockedRef.current ||
        gitLockedRef.current
      )
        return;
      if (result.text !== doc.sliceString(from, to)) {
        pluginRequest.current = null;
        view.dispatch({
          changes: { from, to, insert: result.text },
          selection: { anchor: from, head: from + view.state.toText(result.text).length },
          userEvent: "input.plugin",
          annotations: isolateHistory.of("full"),
        });
      }
      view.focus();
    } catch (error) {
      if (!request.signal.aborted && plugins.isEnabled(command.revision)) {
        onNoticeRef.current?.(errorMessage(error));
      }
    } finally {
      if (pluginRequest.current === request) pluginRequest.current = null;
    }
  };

  const jumpToProblem = (previous: boolean) => {
    const view = viewRef.current;
    if (!view || !activeRef.current || previewRef.current) return;
    (previous ? previousDiagnostic : nextDiagnostic)(view);
    view.focus();
  };

  const text = documentRef.current ?? loaded.content;
  return (
    <section
      className="reader"
      aria-label={`${tab.name} ${text.editable ? t("代码编辑区") : t("只读阅读区")}`}
    >
      {recovery && (
        <div className="reader-notice reader-notice-alert" role="alert">
          <span>
            {t(
              "发现 {0} 的未保存修改；当前显示磁盘内容。",
              new Date(recovery.updatedAtMs).toLocaleString(language),
            )}
          </span>
          <div className="reader-notice-actions">
            <button
              type="button"
              className="button button-small"
              disabled={!text.editable}
              onClick={restoreRecovery}
            >
              {t("恢复未保存修改")}
            </button>
            <button
              type="button"
              className="button button-small"
              onClick={() => void discardRecovery()}
            >
              {t("放弃恢复")}
            </button>
          </div>
        </div>
      )}
      {markdown && (
        <div className="markdown-toolbar" role="group" aria-label={t("Markdown 显示方式")}>
          {text.mode !== "normal" && (
            <span className="markdown-mode-hint">{t("大文件或超长行文件仅支持源码阅读")}</span>
          )}
          <button
            type="button"
            className="button button-small"
            aria-pressed={!previewVisible}
            onClick={() => setPreview(false)}
          >
            {t("源码")}
          </button>
          <button
            type="button"
            className="button button-small"
            aria-pressed={previewVisible}
            disabled={text.mode !== "normal"}
            onClick={showPreview}
          >
            {t("预览")}
          </button>
        </div>
      )}
      {active && !previewVisible && text.editable && !!plugins?.commands.length && (
        <div className="editor-plugin-commands">
          <Select
            id={pluginMenuId}
            value=""
            label={t("插件命令")}
            triggerLabel={t("插件命令")}
            commitOnTab={false}
            disabled={gitLocked}
            options={plugins.commands.map((command) => ({
              value: command.key,
              label: command.title,
              description: command.pluginName,
            }))}
            onChange={(key) => void runPluginCommand(key)}
          />
        </div>
      )}
      {previewNotice && (
        <div className="reader-notice" role="status">
          {previewNotice}
        </div>
      )}
      {!text.editable && text.editBlockedReason && (
        <div className="reader-notice" role="status">
          {t(text.editBlockedReason)}
        </div>
      )}
      {pauseReason && (
        <div className="reader-notice reader-notice-alert" role="alert">
          <span>
            {pauseReason === "conflict"
              ? (saveError ?? t("文件已在磁盘上修改，自动保存已暂停。"))
              : pauseReason === "external"
                ? (saveError ?? t("该文件已在磁盘上被其他程序修改，自动保存已暂停。"))
                : t("自动保存失败：{0}", saveError ?? t("未知错误"))}
          </span>
          <div className="reader-notice-actions">
            {pauseReason === "error" && (
              <button
                className="button button-small"
                onClick={() => {
                  resumeAutoSave();
                  void save();
                }}
              >
                {t("重试")}
              </button>
            )}
            {pauseReason !== "error" && (
              <button className="button button-small" onClick={() => void save({ force: true })}>
                {t("覆盖磁盘文件")}
              </button>
            )}
            <button className="button button-small" onClick={reloadFromDisk}>
              {t("重新载入")}
            </button>
          </div>
        </div>
      )}
      {text.warnings.length > 0 && (
        <div className="reader-notice" role="status">
          {text.warnings.map((warning) => t(warning)).join(" ")}
        </div>
      )}
      {previewVisible && (
        <Suspense
          fallback={
            <div className="reader-state" role="status">
              {t("正在加载 Markdown 预览…")}
            </div>
          }
        >
          <MarkdownPreview
            content={previewText}
            projectId={tab.projectId}
            documentPath={tab.path}
            active={active}
            markdownMathEnabled={preferences.markdownMathEnabled}
            request={previewRequest}
            onOpenFile={onOpenMarkdownFile}
            onNotice={previewMessage}
          />
        </Suspense>
      )}
      <div
        className={`editor-surface-wrap${minimap ? " has-minimap" : ""}`}
        hidden={previewVisible}
      >
        <div className="editor-surface" ref={surfaceRef} />
        {active && semanticEnabled && !previewVisible && problems && (
          <EditorProblems
            problems={problems.items}
            onStep={jumpToProblem}
            onSelect={({ from, to }) => {
              const view = viewRef.current;
              if (
                !view ||
                view.state.doc !== problems.doc ||
                !activeRef.current ||
                previewRef.current
              )
                return;
              view.dispatch({
                selection: { anchor: from, head: to },
                effects: EditorView.scrollIntoView(from, { y: "center" }),
              });
              view.focus();
            }}
          />
        )}
        {gitBlocks.length > 0 && lineCount > 1 && (
          <div className="git-change-map" role="group" aria-label={t("变更位置")}>
            {gitBlocks.map((block, index) => {
              const lines = block.kind === "deleted" ? 1 : Math.max(1, block.to - block.from + 1);
              const top = ((Math.max(1, block.from) - 1) / lineCount) * 100;
              const height = Math.max((lines / lineCount) * 100, 0.4);
              return (
                <button
                  key={`${block.from}-${block.to}-${index}`}
                  type="button"
                  className={`git-change-tick git-change-tick-${block.kind}`}
                  style={{ top: `${top}%`, height: `${height}%` }}
                  data-tooltip={t("{0}（第 {1} 行）", changeLabel(block), Math.max(1, block.from))}
                  aria-label={t("{0}，跳到第 {1} 行", changeLabel(block), Math.max(1, block.from))}
                  onClick={() => jumpToChange(block)}
                />
              );
            })}
          </div>
        )}
      </div>
      {changePopup && (
        <div
          className="git-change-popover"
          role="dialog"
          aria-label={t("代码变更")}
          style={{ left: changePopup.left, top: changePopup.top }}
        >
          <header>
            <span>{changeLabel(changePopup.block)}</span>
            {changePopup.block.oldLines.length > 0 && (
              <span className="git-change-range">
                {t("原第")}
                {changePopup.block.oldStart}
                {changePopup.block.oldLines.length > 1
                  ? `–${changePopup.block.oldStart + changePopup.block.oldLines.length - 1}`
                  : ""}{" "}
                {t("行")}
              </span>
            )}
          </header>
          {changePopup.block.oldLines.length > 0 ? (
            <div className="git-change-lines">
              {changePopup.block.oldLines.map((line, index) => (
                <div className="git-change-line" key={index}>
                  <span className="git-change-number">{changePopup.block.oldStart + index}</span>
                  <span className="git-change-code">{line || " "}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="git-change-empty">{t("这段代码为新增内容，没有更早的版本。")}</p>
          )}
          <footer>
            <button
              className="button button-small"
              onClick={() => revertChange(changePopup.block)}
              disabled={!text.editable}
              data-tooltip={text.editable ? t("用原始代码替换此处内容") : t("只读文件无法撤销更改")}
            >
              {t("撤销此更改")}
            </button>
            <button className="button button-small" onClick={() => setChangePopup(null)}>
              {t("关闭")}
            </button>
          </footer>
        </div>
      )}
    </section>
  );
}

function changeLabel(block: ChangeBlock): string {
  const added = block.newLines.length;
  const removed = block.oldLines.length;
  if (block.kind === "added") return t("新增 {0} 行", added);
  if (block.kind === "deleted") return t("删除 {0} 行", removed);
  return t("修改 {0} 行（原 {1} 行）", added, removed);
}

function applyReveal(view: EditorView, request: RevealRequest) {
  const start = offsetAt(view.state.doc, request.line, request.character, request.encoding);
  const end = offsetAt(view.state.doc, request.endLine, request.endCharacter, request.encoding);
  view.dispatch({
    selection: { anchor: start, head: Math.max(start, end) },
    effects: EditorView.scrollIntoView(start, { y: "center" }),
    scrollIntoView: true,
  });
  view.focus();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
