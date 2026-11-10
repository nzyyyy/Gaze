import { t as tr } from "../../lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type OperationEvent,
  type OperationRequest,
  type RepositorySummary,
  type SessionLogLine,
} from "../api";
import type { PrepareGitOperation } from "../editorOperations";
import {
  errorMessage,
  type OperationFinished,
  type OperationOutcome,
  type Pending,
} from "../types";

export function useGitOperations(
  repository: RepositorySummary | undefined,
  prepare: PrepareGitOperation,
  refresh: () => Promise<void>,
  onNotice?: (message: string) => void,
) {
  const [pending, setPending] = useState<Pending>();
  const [busy, setBusy] = useState(false);
  const [operationId, setOperationId] = useState<number>();
  const [logs, setLogs] = useState<SessionLogLine[]>([]);
  const [status, setStatus] = useState("");
  const [outputOpen, setOutputOpen] = useState(false);
  const reserved = useRef(false);
  const repositoryIdRef = useRef(repository?.id);
  repositoryIdRef.current = repository?.id;
  const completions = useRef(new Map<number, (outcome: OperationOutcome) => void>());
  const early = useRef(new Map<number, OperationOutcome>());
  const ready = useRef<Promise<() => void> | null>(null);
  const pendingRoot = useRef("");
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;
  // Git emits one event per output line; render at most once per frame instead.
  const logBuffer = useRef<SessionLogLine[]>([]);
  const logFrame = useRef<number | null>(null);
  const flushLogs = useCallback(() => {
    const batch = logBuffer.current;
    if (batch.length === 0) return;
    logBuffer.current = [];
    setLogs((lines) => [...lines, ...batch].slice(-500));
  }, []);
  const appendLog = useCallback(
    (line: SessionLogLine) => {
      logBuffer.current.push(line);
      if (logBuffer.current.length > 500) logBuffer.current.shift();
      if (logFrame.current !== null) return;
      logFrame.current = window.requestAnimationFrame(() => {
        logFrame.current = null;
        flushLogs();
      });
    },
    [flushLogs],
  );
  useEffect(
    () => () => {
      if (logFrame.current !== null) window.cancelAnimationFrame(logFrame.current);
      logFrame.current = null;
    },
    [],
  );
  const reportError = useCallback(
    (message: string) => {
      setStatus(message);
      setOutputOpen(true);
      appendLog({ timestamp: new Date().toISOString(), kind: "error", message });
    },
    [appendLog],
  );

  useEffect(() => {
    let disposed = false;
    const subscription = api.onOperationEvent((event: OperationEvent) => {
      if (disposed || event.repositoryId !== repositoryIdRef.current) return;
      appendLog({
        timestamp: new Date().toISOString(),
        kind: event.kind,
        message: event.message,
      });
      if (event.kind !== "finished") return;
      const outcome = event.outcome ?? "failed";
      const complete = completions.current.get(event.operationId);
      if (complete) {
        completions.current.delete(event.operationId);
        complete(outcome);
      } else {
        early.current.set(event.operationId, outcome);
        if (early.current.size > 20) early.current.delete(early.current.keys().next().value!);
      }
      setStatus(event.message);
      if (outcome === "succeeded") noticeRef.current?.(tr("Git 操作已完成。"));
      else setOutputOpen(true);
    });
    ready.current = subscription;
    return () => {
      disposed = true;
      void subscription.then((stop) => stop()).catch(() => {});
    };
  }, [appendLog]);

  const execute = useCallback(
    async (
      repositoryId: number,
      root: string,
      request: OperationRequest,
      confirmed: boolean,
      onFinished?: OperationFinished,
    ) => {
      let settle: Awaited<ReturnType<PrepareGitOperation>> | undefined;
      let outcome: OperationOutcome = "failed";
      setBusy(true);
      try {
        await ready.current;
        settle = await prepare(root, request);
        const result = await api.startOperation(repositoryId, request, confirmed);
        setOperationId(result.operationId);
        outcome = await new Promise<OperationOutcome>((resolve) => {
          const completed = early.current.get(result.operationId);
          if (completed) {
            early.current.delete(result.operationId);
            resolve(completed);
          } else completions.current.set(result.operationId, resolve);
        });
      } catch (error) {
        reportError(errorMessage(error));
      } finally {
        try {
          await settle?.(outcome);
        } catch (error) {
          reportError(errorMessage(error));
        }
        reserved.current = false;
        setBusy(false);
        setOperationId(undefined);
        onFinished?.(outcome);
        await refresh();
      }
    },
    [prepare, refresh, reportError],
  );

  const run = useCallback(
    async (request: OperationRequest, onFinished?: OperationFinished) => {
      if (!repository || reserved.current) {
        onFinished?.("failed");
        return;
      }
      reserved.current = true;
      try {
        const preview = await api.previewOperation(repository.id, request);
        if (preview.requiresConfirmation) {
          pendingRoot.current = repository.path;
          setPending({ repositoryId: repository.id, request, preview, onFinished });
        } else await execute(repository.id, repository.path, request, false, onFinished);
      } catch (error) {
        reserved.current = false;
        onFinished?.("failed");
        reportError(errorMessage(error));
      }
    },
    [repository, execute, reportError],
  );

  useEffect(() => {
    if (pending && pending.repositoryId !== repository?.id) {
      pending.onFinished?.("cancelled");
      setPending(undefined);
      reserved.current = false;
    }
  }, [repository?.id, pending]);

  const cancelPending = () => {
    pending?.onFinished?.("cancelled");
    setPending(undefined);
    reserved.current = false;
  };
  const confirmPending = () => {
    if (!pending) return;
    const current = pending;
    setPending(undefined);
    void execute(
      current.repositoryId,
      pendingRoot.current,
      current.request,
      true,
      current.onFinished,
    );
  };
  const cancel = () => {
    if (operationId != null)
      void api.cancelOperation(operationId).catch((error) => reportError(errorMessage(error)));
  };
  const clearLogs = () => {
    logBuffer.current = [];
    setLogs([]);
  };
  const exportLogs = async () => {
    try {
      if (await api.exportSessionLog("gaze-git-session.log", logs))
        setStatus(tr("Git 日志已导出。"));
    } catch (error) {
      reportError(errorMessage(error));
    }
  };
  return {
    run,
    pending,
    cancelPending,
    confirmPending,
    busy,
    operationId,
    cancel,
    status,
    logs,
    outputOpen,
    setOutputOpen,
    reportError,
    clearLogs,
    exportLogs,
  };
}
