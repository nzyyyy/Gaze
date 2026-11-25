import type { Diagnostic } from "@codemirror/lint";
import { AlertCircle, Info, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { t } from "../lib/i18n";

export type EditorProblem = Pick<Diagnostic, "message" | "severity"> & {
  from: number;
  to: number;
  line: number;
  column: number;
};

const severities = {
  error: { Icon: AlertCircle, label: "{0} 个错误" },
  warning: { Icon: TriangleAlert, label: "{0} 个警告" },
  info: { Icon: Info, label: "{0} 条提示" },
} as const;

function severityOf(problem: EditorProblem) {
  return problem.severity === "hint" ? "info" : problem.severity;
}

export function EditorProblems({
  problems,
  onSelect,
  onStep,
}: {
  problems: readonly EditorProblem[];
  onSelect: (problem: EditorProblem) => void;
  onStep: (previous: boolean) => void;
}) {
  const panelId = useId();
  const widget = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const problem of problems) counts[severityOf(problem)]++;
  const indicators = (["error", "warning", "info"] as const)
    .filter((severity) => counts[severity] > 0)
    .map((severity) => ({ severity, ...severities[severity], count: counts[severity] }));
  const summary = indicators.map(({ label, count }) => t(label, count)).join(" · ");

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector("button")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !widget.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  return (
    <div
      ref={widget}
      className="editor-problems"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.stopPropagation();
          event.preventDefault();
          setOpen(false);
          trigger.current?.focus();
        } else if (event.key === "F2" && !event.altKey && !event.ctrlKey && !event.metaKey) {
          event.stopPropagation();
          event.preventDefault();
          setOpen(false);
          onStep(event.shiftKey);
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="editor-problems-trigger"
        aria-label={t("当前文件问题：{0}", summary)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-tooltip={open ? undefined : summary}
        onClick={() => setOpen((previous) => !previous)}
      >
        {indicators.map(({ severity, Icon, count }) => (
          <span key={severity} className={`editor-problem-count is-${severity}`} aria-hidden>
            <Icon size={13} />
            {count}
          </span>
        ))}
      </button>
      {open && (
        <ul
          ref={panel}
          id={panelId}
          className="editor-problems-panel"
          aria-label={t("当前文件问题")}
        >
          {problems.map((problem, index) => {
            const severity = severityOf(problem);
            const { Icon, label } = severities[severity];
            return (
              <li key={`${problem.from}:${problem.to}:${index}`}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onSelect(problem);
                  }}
                >
                  <span
                    className={`editor-problem-count is-${severity}`}
                    role="img"
                    aria-label={t(label, 1)}
                  >
                    <Icon size={13} aria-hidden />
                  </span>
                  <span className="editor-problem-message">{problem.message}</span>
                  <span className="editor-problem-location">
                    {problem.line}:{problem.column}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
