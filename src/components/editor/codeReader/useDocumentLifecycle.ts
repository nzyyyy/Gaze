import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { EditorState, Prec, type Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import type { SaveResult } from "../../../editor/types";
import { api, type RecoveryRecord } from "../../../lib/platform/api";
import { t } from "../../../lib/i18n";
import type { Preferences } from "../../../lib/settings/preferences";
import type { TextFile } from "../../../lib/types";
import { errorCode, errorMessage } from "../../../lib/utils";
import { normalizeDocumentText, type LoadedState, type PauseReason } from "./documentModel";

const AUTO_SAVE_MIN_INTERVAL_MS = 1500;
const RECOVERY_SAVE_DELAY_MS = 500;

export interface UseDocumentLifecycleOptions {
  projectId: string;
  path: string;
  reloadToken: number;
  externalChangeToken: number;
  gitLocked: boolean;
  preferences: Preferences;
  viewRef: RefObject<EditorView | null>;
  operationCompartment: Compartment;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
}

export function useDocumentLifecycle({
  projectId,
  path,
  reloadToken,
  externalChangeToken,
  gitLocked,
  preferences,
  viewRef,
  operationCompartment,
  onSaved,
  onDirtyChange,
}: UseDocumentLifecycleOptions) {
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const operationLockedRef = useRef(false);
  const gitLockedRef = useRef(gitLocked);
  gitLockedRef.current = gitLocked;
  const operationCursorRef = useRef<number | null>(null);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onSavedRef = useRef(onSaved);
  onDirtyChangeRef.current = onDirtyChange;
  onSavedRef.current = onSaved;
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

  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [localReload, setLocalReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pauseReason, setPauseReason] = useState<PauseReason>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<RecoveryRecord | null>(null);
  const [lineCount, setLineCount] = useState(1);

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
    return enqueueRecovery(() => api.deleteRecovery(projectId, path));
  }, [clearRecoveryTimer, enqueueRecovery, path, projectId]);

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
        void enqueueRecovery(() => api.writeRecovery(projectId, path, content, fingerprint));
      }, RECOVERY_SAVE_DELAY_MS);
    },
    [clearRecoveryTimer, enqueueRecovery, path, projectId, viewRef],
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
  }, [clearAutoSaveTimer, viewRef]);

  scheduleAutoSaveRef.current = scheduleAutoSave;

  useEffect(() => {
    const locked = gitLocked || operationLockedRef.current;
    if (locked) clearAutoSaveTimer();
    viewRef.current?.dispatch({
      effects: operationCompartment.reconfigure(
        locked ? Prec.highest([EditorState.readOnly.of(true), EditorView.editable.of(false)]) : [],
      ),
    });
    if (!locked && dirtyRef.current) scheduleAutoSaveRef.current();
  }, [gitLocked, clearAutoSaveTimer, operationCompartment, viewRef]);

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
            projectId,
            path,
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
    [clearAutoSaveTimer, deleteRecovery, pauseAutoSave, resumeAutoSave, path, projectId, viewRef],
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
  }, [recovery, viewRef]);

  const retryLoad = useCallback(() => {
    setRetryToken((value) => value + 1);
  }, []);

  const prepareFileOperation = useCallback(
    async (options?: { save?: boolean }): Promise<SaveResult> => {
      operationLockedRef.current = true;
      clearAutoSaveTimer();
      viewRef.current?.dispatch({
        effects: operationCompartment.reconfigure(
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
    [clearAutoSaveTimer, operationCompartment, save, viewRef],
  );

  const finishFileOperation = useCallback(
    (options?: { reload?: boolean }) => {
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
        effects: operationCompartment.reconfigure(
          gitLockedRef.current
            ? Prec.highest([EditorState.readOnly.of(true), EditorView.editable.of(false)])
            : [],
        ),
      });
      if (dirtyRef.current) scheduleAutoSaveRef.current();
    },
    [clearAutoSaveTimer, operationCompartment, reloadFromDisk, viewRef],
  );

  const resetEditorDocument = useCallback((content: TextFile) => {
    generationRef.current += 1;
    documentRef.current = content;
    const normalizedContent = normalizeDocumentText(content.content);
    baselineRef.current = normalizedContent;
    dirtyRef.current = false;
    setDirty(false);
    setLineCount(normalizedContent === "" ? 1 : normalizedContent.split("\n").length);
    return normalizedContent;
  }, []);

  const onDocumentChanged = useCallback(
    (view: EditorView) => {
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
    },
    [clearAutoSaveTimer],
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
      : api.readRecovery(projectId, path).catch(() => null);
    Promise.all([api.readFile(projectId, path), recoveryRequest])
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
    projectId,
    path,
    reloadToken,
    localReload,
    retryToken,
    clearAutoSaveTimer,
    deleteRecovery,
    resumeAutoSave,
    viewRef,
  ]);

  useEffect(() => {
    clearAutoSaveTimer();
    if (dirtyRef.current) scheduleAutoSaveRef.current();
  }, [preferences.autoSave, preferences.autoSaveDelay, clearAutoSaveTimer]);

  useEffect(() => {
    if (externalChangeToken === 0 || !dirtyRef.current) return;
    pauseAutoSave("external", t("该文件已在磁盘上被其他程序修改。"));
  }, [externalChangeToken, pauseAutoSave]);

  useEffect(() => {
    onDirtyChangeRef.current(dirty);
  }, [dirty]);

  useEffect(() => clearAutoSaveTimer, [clearAutoSaveTimer]);
  useEffect(() => clearRecoveryTimer, [clearRecoveryTimer]);

  return {
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
    onDocumentChanged,
    save,
    discardRecovery,
    reloadFromDisk,
    restoreRecovery,
    retryLoad,
    prepareFileOperation,
    finishFileOperation,
    clearAutoSaveTimer,
    resumeAutoSave,
  };
}
