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
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from "react";
import { flushSync } from "react-dom";
import { closeCompletion } from "@codemirror/autocomplete";
import {
  forEachDiagnostic,
  nextDiagnostic,
  previousDiagnostic,
  setDiagnostics,
  setDiagnosticsEffect,
} from "@codemirror/lint";
import { isolateHistory } from "@codemirror/commands";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Text } from "@codemirror/state";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { closeHoverTooltips, EditorView } from "@codemirror/view";
import { AlertCircle, FileQuestion, LoaderCircle, RotateCcw } from "lucide-react";

import type { EditorDiffSnapshot } from "../git/EditorDiff";
import type {
  CodeReaderHandle,
  EditorTab,
  MarkdownPreviewRequest,
  RevealRequest,
} from "../editor/types";
import { codeDiagnostics } from "../lib/diagnostics";
import { isWithinEditorSelection } from "../lib/columnSelection";
import { writeEditorClipboard } from "../lib/editorClipboard";
import { autoImportExtension } from "../lib/autoImport";
import { codeCompletion } from "../lib/completion";
import {
  dismissEditorLanguageTooltip,
  editorLanguageTools,
  runEditorLanguageAction,
} from "../lib/editorLanguageTools";
import { DEFAULT_PREFERENCES, type Preferences } from "../lib/preferences";
import { resolveShortcuts, type NavigationTarget } from "../lib/shortcuts";
import type { EditorViewState } from "../lib/session";
import { isMarkdownFile, matchLanguage } from "../lib/language";
import {
  useBuiltinFeature,
  useEditorCompletion,
  usePlugins,
  useSemanticAvailability,
} from "../plugins/runtime";
import { EditorProblems, type EditorProblem } from "./EditorProblems";
import { EditorContextMenu } from "./EditorContextMenu";
import type { MenuTarget } from "./ContextMenu";
import { Select } from "./Select";
import {
  createCodeReaderCompartments,
  createCodeReaderExtensions,
  editorTheme,
  openEditorSearch,
  preferenceExtensions,
} from "./codeReader/codeMirrorExtensions";
import type { LoadedState } from "./codeReader/documentModel";
import { useDocumentLifecycle } from "./codeReader/useDocumentLifecycle";
import { useGitChangeBlocks } from "./codeReader/useGitChangeBlocks";
import type {
  EditorStatus,
  ResolvedTheme,
  PositionEncoding,
  NavigationResult,
  TextPosition,
} from "../lib/types";
import { errorMessage } from "../lib/utils";

const MARKDOWN_PREVIEW_DELAY_MS = 120;

const EditorChangePopover = lazy(() =>
  import("../git/EditorDiff").then(({ EditorChangePopover }) => ({ default: EditorChangePopover })),
);
const MarkdownPreview = lazy(() =>
  import("./MarkdownPreview").catch(() => ({
    default: () => (
      <div className="reader-state" role="alert">
        {t("预览加载失败，请切回源码或重新打开应用。")}
      </div>
    ),
  })),
);

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
  /** Returns whether the workspace handled the target; `undefined` skips the editor binding. */
  onNavigate?: (target: NavigationTarget) => boolean;
  onActivate?: () => void;
  onSearchSelection?: (text: string) => void;
  onOpenMarkdownFile?: (projectId: string, path: string, fragment: string | null) => void;
  onNotice?: (message: string) => void;
  onOpenComparison?: (snapshot: EditorDiffSnapshot) => void;
  onStatus: (status: EditorStatus | null) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
  ref?: Ref<CodeReaderHandle>;
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
  onNavigate,
  onActivate,
  onSearchSelection,
  onNotice,
  onOpenComparison,
  onStatus,
  onDirtyChange,
  onSaved,
  ref,
}: EditorSurfaceProps) {
  const language = useLanguage();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    view: EditorView;
    target: MenuTarget;
    state: EditorState;
  } | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const compartments = useRef(createCodeReaderCompartments());
  const previousPythonRevision = useRef(pythonRevision);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const initialViewRef = useRef(initialView);
  const initialViewDocumentRef = useRef<LoadedState | null>(null);
  const revealRef = useRef(reveal);
  const activeRef = useRef(active);
  const editorPopupsBlockedRef = useRef(editorPopupsBlocked);
  editorPopupsBlockedRef.current = editorPopupsBlocked;
  const onNoticeRef = useRef(onNotice);
  const copyLocation = useCallback(
    (view: EditorView) => {
      const number = view.state.doc.lineAt(view.state.selection.main.head).number;
      void writeEditorClipboard(`${tab.path}:${number}`).catch((error: unknown) =>
        onNoticeRef.current?.(errorMessage(error)),
      );
      return true;
    },
    [tab.path],
  );
  onNoticeRef.current = onNotice;
  const onOpenFileLinkRef = useRef(onOpenMarkdownFile);
  onOpenFileLinkRef.current = onOpenMarkdownFile;
  const onGoToDefinitionRef = useRef(onGoToDefinition);
  onGoToDefinitionRef.current = onGoToDefinition;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const appNavigation = useCallback(
    (target: NavigationTarget) => onNavigateRef.current?.(target) === true,
    [],
  );
  const {
    documentRef,
    dirtyRef,
    operationLockedRef,
    gitLockedRef,
    operationCursorRef,
    loaded,
    loading,
    error,
    dirty,
    saving,
    pauseReason,
    saveError,
    recovery,
    lineCount,
    resetEditorDocument,
    onDocumentChanged: onLifecycleDocumentChanged,
    save,
    discardRecovery,
    reloadFromDisk,
    restoreRecovery,
    retryLoad,
    prepareFileOperation,
    finishFileOperation,
    clearAutoSaveTimer,
    resumeAutoSave,
  } = useDocumentLifecycle({
    projectId: tab.projectId,
    path: tab.path,
    reloadToken,
    externalChangeToken,
    gitLocked,
    preferences,
    viewRef,
    operationCompartment: compartments.current.operation,
    onSaved,
    onDirtyChange,
  });
  const [languageLabel, setLanguageLabel] = useState("Plain Text");
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

  revealRef.current = reveal;
  activeRef.current = active;

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
      prepareFileOperation,
      finishFileOperation,
    }),
    [discardRecovery, finishFileOperation, prepareFileOperation, reloadFromDisk, save],
  );

  useEffect(() => {
    if (!surfaceRef.current || !loaded || loaded.content.kind !== "text") {
      return;
    }
    const content = loaded.content;
    const normalizedContent = resetEditorDocument(content);
    setProblems(undefined);
    resumeAutoSave();
    clearAutoSaveTimer();
    const match = matchLanguage(markdown ? tab.name.toLowerCase() : tab.name);
    setLanguageLabel(match.label);
    let cancelled = false;
    const state = EditorState.create({
      doc: content.content,
      selection: { anchor: Math.min(operationCursorRef.current ?? 0, normalizedContent.length) },
      extensions: createCodeReaderExtensions({
        compartments: compartments.current,
        theme,
        content,
        fileName: tab.name,
        projectId: tab.projectId,
        filePath: tab.path,
        preferences: preferencesRef.current,
        onNavigate: appNavigation,
        onCopyLocation: copyLocation,
        onDocumentChanged: (view) => {
          closeChangePopup();
          onLifecycleDocumentChanged(view);
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
        onGitChangeSelect: (block, element) => gitSelectRef.current(block, element),
        canGoToDefinition: () =>
          (!operationLockedRef.current || gitLockedRef.current) && !!onGoToDefinitionRef.current,
        onGoToDefinition: (position, result) => onGoToDefinitionRef.current?.(position, result),
        onOpenFileLink: (path, fragment) =>
          onOpenFileLinkRef.current?.(tab.projectId, path, fragment),
        onUpdate: (update) => {
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
        },
        isLocked: () => operationLockedRef.current || gitLockedRef.current,
      }),
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
            effects: compartments.current.language.reconfigure(support),
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
  }, [
    loaded,
    tab.name,
    markdown,
    clearAutoSaveTimer,
    resumeAutoSave,
    resetEditorDocument,
    onLifecycleDocumentChanged,
    copyLocation,
  ]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.locale.reconfigure(
        EditorState.phrases.of(
          language === "zh-CN"
            ? {
                Find: "查找",
                Replace: "替换",
                "Go to line": "跳到行列",
                go: "跳转",
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

  const {
    gitBlocks,
    changePopup,
    gitSelectRef,
    scheduleGitDiffRef,
    jumpToChange,
    openChangePopup,
    closeChangePopup,
    revertChange,
    openComparison,
    getChangeAtContext,
    changeLabel,
  } = useGitChangeBlocks({
    projectId: tab.projectId,
    path: tab.path,
    viewRef,
    documentRef,
    operationLockedRef,
    gitLockedRef,
    activeRef,
    active,
    loaded,
    editorPopupsBlocked,
    gitLocked,
    onOpenComparison,
  });

  const showPreview = useCallback(() => {
    if (!viewRef.current) return;
    if (previewTimerRef.current !== null) window.clearTimeout(previewTimerRef.current);
    previewTimerRef.current = null;
    setPreviewText(viewRef.current.state.doc.toString());
    setPreviewNotice(null);
    closeChangePopup();
    setPreview(true);
  }, [closeChangePopup]);

  useEffect(
    () => () => {
      if (previewTimerRef.current !== null) window.clearTimeout(previewTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        compartments.current.theme.reconfigure(
          editorTheme(theme === "dark", fontFamily, preferences),
        ),
        compartments.current.highlight.reconfigure(
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
        effects: compartments.current.preferences.reconfigure(
          preferenceExtensions(
            preferences,
            document.mode,
            document.editable,
            document.content,
            tab.name,
            appNavigation,
            copyLocation,
          ),
        ),
      });
  }, [preferences, loaded, tab.name, appNavigation, copyLocation]);

  useEffect(() => {
    if (!active || previewVisible || editorPopupsBlocked) closeContextMenu();
  }, [active, closeContextMenu, editorPopupsBlocked, previewVisible]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.current.minimap.reconfigure(minimap ?? []) });
  }, [loaded, minimap]);

  useEffect(() => {
    const view = viewRef.current;
    const document = documentRef.current;
    if (!view || document?.mode !== "normal") return;
    const shortcuts = resolveShortcuts(preferences.shortcuts);
    closeCompletion(view);
    const wanted = () =>
      viewRef.current === view &&
      activeRef.current &&
      !previewRef.current &&
      !editorPopupsBlockedRef.current &&
      !operationLockedRef.current;
    const notify = (message: string) => onNoticeRef.current?.(message);
    view.dispatch({
      effects: compartments.current.languageTools.reconfigure([
        // Cancel pending hints before the completion keymap handles Escape.
        canShowQuickDocumentation
          ? editorLanguageTools({
              projectId: tab.projectId,
              path: tab.path,
              shortcut: (id) => shortcuts[id] ?? null,
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
    preferences.shortcuts,
    pythonRevision,
  ]);

  useEffect(() => {
    const view = viewRef.current;
    const document = documentRef.current;
    if (!view || document?.mode !== "normal") return;
    const plugin =
      active && !previewVisible && !gitLocked && document.editable ? inlineCompletion : undefined;
    view.dispatch({
      effects: compartments.current.aiCompletion.reconfigure(
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
      effects: compartments.current.diagnostics.reconfigure(
        enabled ? codeDiagnostics(tab.projectId, tab.path) : [],
      ),
    });
  }, [active, loaded, tab.projectId, tab.path, pythonRevision, semanticEnabled, previewVisible]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const enabled = preferences.autoImportEnabled && canUseEditorActions;
    view.dispatch({
      effects: compartments.current.autoImport.reconfigure(
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
        <button className="button" onClick={retryLoad}>
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

  const openContextMenu = (pointer?: ReactMouseEvent<HTMLDivElement>) => {
    const view = viewRef.current;
    if (!view || previewVisible || editorPopupsBlocked || view.compositionStarted) return;
    if (pointer && !view.contentDOM.contains(pointer.target as Node)) return;
    pointer?.preventDefault();
    onActivate?.();
    if (pointer) {
      const position = view.posAtCoords({ x: pointer.clientX, y: pointer.clientY }, false);
      if (!isWithinEditorSelection(view, position, pointer.clientX)) {
        view.dispatch({ selection: { anchor: position }, userEvent: "select.pointer" });
      }
    }
    closeCompletion(view);
    dismissEditorLanguageTooltip(view);
    view.dispatch({ effects: closeHoverTooltips });
    const anchor = view.coordsAtPos(view.state.selection.main.head);
    const bounds = view.dom.getBoundingClientRect();
    setContextMenu({
      view,
      state: view.state,
      target: {
        x: pointer?.clientX ?? anchor?.left ?? bounds.left,
        y: pointer?.clientY ?? anchor?.bottom ?? bounds.top,
        trigger: view.contentDOM,
        focusFirstItem: pointer === undefined,
      },
    });
  };

  const text = documentRef.current ?? loaded.content;
  const changeAtContext = getChangeAtContext(contextMenu);
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
        <div
          className="editor-surface"
          ref={surfaceRef}
          onContextMenu={openContextMenu}
          onMouseDownCapture={(event) => {
            if (
              event.button === 0 &&
              event.ctrlKey &&
              !event.altKey &&
              !event.metaKey &&
              /Mac/.test(navigator.userAgent) &&
              viewRef.current?.contentDOM.contains(event.target as Node)
            ) {
              event.stopPropagation();
              openContextMenu(event);
            }
          }}
          onKeyDown={(event) => {
            if (
              (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) &&
              viewRef.current?.contentDOM.contains(event.target as Node)
            ) {
              event.preventDefault();
              event.stopPropagation();
              openContextMenu();
            }
          }}
        />
        {contextMenu && active && !previewVisible && !editorPopupsBlocked && (
          <EditorContextMenu
            {...contextMenu}
            shortcuts={resolveShortcuts(preferences.shortcuts)}
            canUseLanguage={canShowQuickDocumentation}
            canNavigate={text.mode === "normal" && !tab.projectId.startsWith("external:")}
            canFold={text.mode === "normal" && preferences.codeFolding}
            onClose={closeContextMenu}
            isCurrent={() =>
              viewRef.current === contextMenu.view &&
              activeRef.current &&
              !previewRef.current &&
              !editorPopupsBlockedRef.current
            }
            canEdit={() => !gitLockedRef.current && !operationLockedRef.current}
            onNavigate={appNavigation}
            onCopyLocation={copyLocation}
            onShowGitChange={
              changeAtContext
                ? () =>
                    openChangePopup(
                      changeAtContext,
                      contextMenu.view.coordsAtPos(contextMenu.state.selection.main.head) ??
                        contextMenu.view.dom,
                    )
                : undefined
            }
            onSearchSelection={onSearchSelection}
            onError={(error) => onNoticeRef.current?.(errorMessage(error))}
          />
        )}
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
      {changePopup && active && !editorPopupsBlocked && (
        <Suspense fallback={null}>
          <EditorChangePopover
            block={changePopup.block}
            anchor={changePopup.anchor}
            pane={changePopup.view.dom}
            scroll={changePopup.view.scrollDOM}
            path={tab.path}
            fontFamily={fontFamily}
            tabSize={preferences.tabSize}
            canRevert={text.editable && !gitLocked && !operationLockedRef.current}
            onClose={closeChangePopup}
            onRevert={revertChange}
            onOpen={onOpenComparison ? openComparison : undefined}
          />
        </Suspense>
      )}
    </section>
  );
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
