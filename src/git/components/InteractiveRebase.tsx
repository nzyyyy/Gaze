import { Select } from "../../components/Select";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type BranchInfo,
  type RebaseAction,
  type RebaseCommit,
  type RebaseStep,
} from "../api";
import { useI18n } from "../i18n";
import { errorMessage, shortOid, type RunOperation } from "../types";

const ACTIONS: RebaseAction[] = ["pick", "reword", "squash", "fixup", "drop"];

export function InteractiveRebase({
  repositoryId,
  initialOnto,
  onClose,
  onRun,
}: {
  repositoryId: number;
  initialOnto?: string;
  onClose: () => void;
  onRun: RunOperation;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [onto, setOnto] = useState("");
  const [commits, setCommits] = useState<RebaseCommit[]>([]);
  const [steps, setSteps] = useState<RebaseStep[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
    };
  }, []);

  useEffect(() => {
    api
      .getBranches(repositoryId)
      .then((all) => {
        const local = all.filter((branch) => !branch.remote);
        setBranches(local);
        const current = local.find((branch) => branch.current);
        setOnto(initialOnto ?? current?.upstream ?? current?.name ?? "");
      })
      .catch((cause) => setError(errorMessage(cause)));
  }, [repositoryId]);

  useEffect(() => {
    if (!onto) {
      setCommits([]);
      setSteps([]);
      return;
    }
    setLoading(true);
    setError("");
    api
      .getRebaseCommits(repositoryId, onto)
      .then((list) => {
        setCommits(list);
        setSteps(
          list.map((commit) => ({
            oid: commit.oid,
            action: "pick" as RebaseAction,
            message: null,
          })),
        );
      })
      .catch((cause) => {
        setCommits([]);
        setSteps([]);
        setError(errorMessage(cause));
      })
      .finally(() => setLoading(false));
  }, [repositoryId, onto]);

  const subjectByOid = useMemo(
    () => new Map(commits.map((commit) => [commit.oid, commit.subject])),
    [commits],
  );

  const move = (index: number, delta: -1 | 1) =>
    setSteps((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });

  const setAction = (index: number, action: RebaseAction) =>
    setSteps((current) => current.map((step, i) => (i === index ? { ...step, action } : step)));
  const setMessage = (index: number, message: string) =>
    setSteps((current) => current.map((step, i) => (i === index ? { ...step, message } : step)));

  const startable = onto.trim() !== "" && steps.some((step) => step.action !== "drop");

  const start = () => {
    const plan = steps.map((step) =>
      step.action === "reword" && !step.message?.trim()
        ? { ...step, message: subjectByOid.get(step.oid) ?? "" }
        : step,
    );
    onRun({ type: "interactiveRebase", onto: onto.trim(), plan });
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="form-dialog rebase-dialog"
      aria-labelledby="rebase-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header>
        <h2 id="rebase-title">{t("interactiveRebase")}</h2>
      </header>
      <div className="dialog-field">
        <label id="rebase-onto-label" htmlFor="rebase-onto">
          {t("onto")}
        </label>
        <Select
          id="rebase-onto"
          autoFocus
          value={onto}
          onChange={setOnto}
          options={[
            ...(!branches.some((branch) => branch.name === onto) && onto
              ? [{ value: onto, label: onto }]
              : []),
            ...branches.map((branch) => ({
              value: branch.name,
              label: `${branch.name}${branch.current ? " *" : ""}`,
            })),
          ]}
        />
      </div>
      {loading && <p role="status">{t("loading")}</p>}
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
      {!loading && steps.length > 0 && (
        <div className="rebase-list">
          {steps.map((step, index) => (
            <div className="rebase-row" key={step.oid}>
              <span className="rebase-order">
                <button
                  type="button"
                  aria-label={`${t("moveCommitUp")} ${shortOid(step.oid)}`}
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`${t("moveCommitDown")} ${shortOid(step.oid)}`}
                  onClick={() => move(index, 1)}
                  disabled={index === steps.length - 1}
                >
                  ↓
                </button>
              </span>
              <Select<RebaseAction>
                id={`action-${step.oid}`}
                label={`${t("rebaseAction")} ${shortOid(step.oid)}`}
                value={step.action}
                onChange={(action) => setAction(index, action)}
                options={ACTIONS.map((action) => ({ value: action, label: t(action) }))}
              />
              <span className="rebase-commit">
                <code>{shortOid(step.oid)}</code>
                <span>{subjectByOid.get(step.oid)}</span>
              </span>
              {step.action === "reword" && (
                <input
                  name={`message-${step.oid}`}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-label={`${t("rewordMessage")} ${shortOid(step.oid)}`}
                  value={step.message ?? ""}
                  placeholder={subjectByOid.get(step.oid)}
                  onChange={(event) => setMessage(index, event.target.value)}
                />
              )}
            </div>
          ))}
        </div>
      )}
      {!loading && !error && steps.length === 0 && onto && <p>{t("noCommitsToRebase")}</p>}
      <footer>
        <button type="button" onClick={onClose}>
          {t("cancel")}
        </button>
        <button className="danger" onClick={start} disabled={!startable}>
          {t("startRebase")}
        </button>
      </footer>
    </dialog>
  );
}
