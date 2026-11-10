import { OperationButton } from "./components/OperationButton";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Decoration,
  Diff,
  Hunk,
  getChangeKey,
  parseDiff,
  type ChangeData,
  type FileData,
  type HunkData,
  type HunkTokens,
} from "react-diff-view";
import "react-diff-view/style/index.css";
import type { CommitFileChange, DiffFile, DiffHunk, OperationRequest } from "./api";
import { useI18n } from "./i18n";
import { ChangedFileList } from "./components/ChangedFileList";
import type { OperationFinished } from "./types";
import { useDiffTokens } from "./useDiffTokens";

const languageForPath = (path: string) => {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  return (
    {
      ts: "typescript",
      mts: "typescript",
      cts: "typescript",
      tsx: "tsx",
      js: "javascript",
      jsx: "jsx",
      mjs: "javascript",
      cjs: "javascript",
      json: "json",
      html: "markup",
      htm: "markup",
      xml: "markup",
      svg: "markup",
      css: "css",
      rs: "rust",
      py: "python",
      sh: "bash",
      bash: "bash",
      zsh: "bash",
      md: "markdown",
      markdown: "markdown",
      yaml: "yaml",
      yml: "yaml",
      toml: "ini",
    } as Record<string, string>
  )[extension];
};

const AT = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function islandKeyFromPatch(patch: string): string | undefined {
  const lines = patch.split("\n");
  const headerAt = lines.findIndex((line) => line.startsWith("@@"));
  if (headerAt < 0) return undefined;
  const match = AT.exec(lines[headerAt]!);
  if (!match) return undefined;
  let old = Number(match[1]);
  let next = Number(match[2]);
  let del = 0;
  let ins = 0;
  for (const line of lines.slice(headerAt + 1)) {
    if (line.startsWith("\\")) continue;
    if (line.startsWith("-")) {
      if (!del) del = old;
      old += 1;
    } else if (line.startsWith("+")) {
      if (!ins) ins = next;
      next += 1;
    } else {
      old += 1;
      next += 1;
    }
  }
  return `${del}:${ins}`;
}

function islandKeyFromChanges(changes: ChangeData[]): string {
  const del = changes.find((change) => change.type === "delete");
  const ins = changes.find((change) => change.type === "insert");
  return `${del?.type === "delete" ? del.lineNumber : 0}:${ins?.type === "insert" ? ins.lineNumber : 0}`;
}

function changeIslands(changes: ChangeData[]): ChangeData[][] {
  const islands: ChangeData[][] = [];
  let current: ChangeData[] = [];
  for (const change of changes) {
    if (change.type === "normal") {
      if (current.length) islands.push(current);
      current = [];
    } else current.push(change);
  }
  if (current.length) islands.push(current);
  return islands;
}

function newLineNumber(change: ChangeData): number | undefined {
  if (change.type === "insert") return change.lineNumber;
  if (change.type === "normal") return change.newLineNumber;
  return undefined;
}

function firstChangeHunks(
  fileHunks: { changes: ChangeData[] }[],
  owned: DiffHunk[],
): Map<string, DiffHunk> {
  const byKey = new Map<string, DiffHunk>();
  for (const hunk of owned) {
    const key = islandKeyFromPatch(hunk.patch);
    if (key) byKey.set(key, hunk);
  }
  const first = new Map<string, DiffHunk>();
  for (const hunk of fileHunks) {
    for (const island of changeIslands(hunk.changes)) {
      const match = byKey.get(islandKeyFromChanges(island));
      if (match && island[0]) first.set(getChangeKey(island[0]), match);
    }
  }
  return first;
}

type RenderGutter = NonNullable<React.ComponentProps<typeof Diff>["renderGutter"]>;
const DIFF_CHUNK_LINES = 100;

function LargeDiff({
  file,
  tokens,
  preamble,
  renderGutter,
}: {
  file: FileData;
  tokens: HunkTokens | null;
  preamble: string;
  renderGutter: RenderGutter;
}) {
  const chunks = useMemo(
    () =>
      file.hunks.flatMap((hunk) => {
        const result: { hunk: HunkData; showHeader: boolean }[] = [];
        for (let start = 0; start < hunk.changes.length; start += DIFF_CHUNK_LINES) {
          result.push({
            hunk: { ...hunk, changes: hunk.changes.slice(start, start + DIFF_CHUNK_LINES) },
            showHeader: start === 0,
          });
        }
        return result;
      }),
    [file],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const scroller = root?.closest(".diff-lines");
    if (!(scroller instanceof HTMLDivElement)) return;
    setScrollElement(scroller);
    setScrollMargin(
      root!.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
    );
  }, []);
  const virtualizer = useVirtualizer({
    count: chunks.length,
    getScrollElement: () => scrollElement,
    estimateSize: (index) => {
      const { hunk, showHeader } = chunks[index]!;
      const preambleLines = index === 0 && preamble ? preamble.split("\n").length : 0;
      return (hunk.changes.length + preambleLines + Number(showHeader)) * 18;
    },
    getItemKey: (index) => {
      const { hunk } = chunks[index]!;
      return `${hunk.oldStart}:${hunk.oldLines}:${hunk.newStart}:${hunk.newLines}:${index}`;
    },
    overscan: 2,
    scrollMargin,
    initialRect: { width: 0, height: 600 },
  });

  return (
    <div
      ref={rootRef}
      data-virtualized="true"
      style={{ height: virtualizer.getTotalSize(), position: "relative" }}
    >
      {virtualizer.getVirtualItems().map((row) => {
        const { hunk, showHeader } = chunks[row.index]!;
        return (
          <div
            key={row.key}
            ref={virtualizer.measureElement}
            data-index={row.index}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${row.start - scrollMargin}px)`,
            }}
          >
            <Diff
              diffType={file.type}
              hunks={[hunk]}
              viewType="unified"
              tokens={tokens}
              className="gitdock-diff"
              renderGutter={renderGutter}
            >
              {() =>
                [
                  row.index === 0 && (
                    <Decoration key="file-header">
                      <pre>{preamble}</pre>
                    </Decoration>
                  ),
                  showHeader && (
                    <Decoration key={`header-${row.index}`}>
                      <div className="hunk-decoration">
                        <code>{hunk.content}</code>
                      </div>
                    </Decoration>
                  ),
                  <Hunk key={row.key} hunk={hunk} />,
                ].filter(Boolean) as React.ReactElement[]
              }
            </Diff>
          </div>
        );
      })}
    </div>
  );
}

function FileDiff({
  diff,
  snapshotId,
  busy,
  onHunk,
  onRun,
  readOnly,
}: {
  diff: DiffFile;
  snapshotId?: number;
  busy: boolean;
  onHunk: (type: "stageHunk" | "unstageHunk" | "discardHunk", hunkId: string) => void;
  onRun: (request: OperationRequest, onFinished?: OperationFinished) => void | Promise<void>;
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  const file = useMemo(() => {
    const start = diff.patch.indexOf("diff --git ");
    return start < 0 ? undefined : parseDiff(diff.patch.slice(start))[0];
  }, [diff.patch]);
  const language = languageForPath(diff.path);
  const tokens = useDiffTokens(file, language);
  const preamble = diff.patch.slice(0, diff.patch.indexOf("@@")).trimEnd();
  const islandStarts = useMemo(
    () => (file ? firstChangeHunks(file.hunks, diff.hunks) : new Map<string, DiffHunk>()),
    [file, diff.hunks],
  );
  if (diff.binary || diff.tooLarge)
    return (
      <div className="canvas-empty">
        <h2>{diff.binary ? t("binaryDiff") : t("diffTooLarge")}</h2>
        {!readOnly && (
          <OperationButton
            onClick={() => onRun({ type: "runDifftool", path: diff.path, staged: diff.staged })}
          >
            {t("openDifftool")}
          </OperationButton>
        )}
      </div>
    );
  if (!file?.hunks.length)
    return (
      <div className="raw-diff">
        {diff.patch.split("\n").map((line, index) => (
          <div className="meta" key={index}>
            <span>{index + 1}</span>
            <code>{line || " "}</code>
          </div>
        ))}
      </div>
    );
  const renderGutter: RenderGutter = ({ change, side }) => {
    if (side === "old") {
      const owned = islandStarts.get(getChangeKey(change));
      if (readOnly || !owned || snapshotId == null) return null;
      if (diff.staged)
        return (
          <OperationButton
            type="button"
            className="diff-stage unstage"
            aria-label={t("unstageHunk")}
            disabled={busy}
            onClick={() => onHunk("unstageHunk", owned.id)}
          >
            −
          </OperationButton>
        );
      return (
        <span className="diff-hunk-actions">
          <OperationButton
            type="button"
            className="diff-stage"
            aria-label={t("stageHunk")}
            disabled={busy}
            onClick={() => onHunk("stageHunk", owned.id)}
          >
            +
          </OperationButton>
          <OperationButton
            type="button"
            className="diff-stage discard"
            aria-label={t("discardHunk")}
            disabled={busy}
            onClick={() => onHunk("discardHunk", owned.id)}
          >
            ↶
          </OperationButton>
        </span>
      );
    }
    const line = newLineNumber(change);
    return line == null ? null : String(line);
  };
  const lineCount = file.hunks.reduce((count, hunk) => count + hunk.changes.length, 0);
  if (lineCount > 500)
    return (
      <LargeDiff file={file} tokens={tokens} preamble={preamble} renderGutter={renderGutter} />
    );
  return (
    <Diff
      diffType={file.type}
      hunks={file.hunks}
      viewType="unified"
      tokens={tokens}
      className="gitdock-diff"
      renderGutter={renderGutter}
    >
      {(hunks) =>
        hunks
          .flatMap((hunk, index) => [
            index === 0 && (
              <Decoration key="file-header">
                <pre>{preamble}</pre>
              </Decoration>
            ),
            <Decoration key={`header-${hunk.content}`}>
              <div className="hunk-decoration">
                <code>{hunk.content}</code>
              </div>
            </Decoration>,
            <Hunk key={hunk.content} hunk={hunk} />,
          ])
          .filter(Boolean) as React.ReactElement[]
      }
    </Diff>
  );
}

export function DiffView({
  diff,
  companionDiff,
  snapshotId,
  onBack,
  onRun,
  onHunkSettled,
  fileActions,
  onFileHistory,
  onBlame,
  ignoreWhitespace,
  onToggleWhitespace,
  caption,
}: {
  diff: DiffFile;
  companionDiff?: DiffFile;
  snapshotId?: number;
  onBack: () => void;
  onRun: (request: OperationRequest, onFinished?: OperationFinished) => void | Promise<void>;
  onHunkSettled?: () => void | Promise<void>;
  fileActions?: boolean;
  onFileHistory?: (path: string) => void;
  onBlame?: (path: string) => void;
  ignoreWhitespace?: boolean;
  onToggleWhitespace?: () => void;
  caption?: string;
}) {
  const { t } = useI18n();
  const [hunkBusy, setHunkBusy] = useState(false);
  const sections = companionDiff
    ? diff.staged
      ? [diff, companionDiff]
      : [companionDiff, diff]
    : [diff];
  const runHunk = (type: "stageHunk" | "unstageHunk" | "discardHunk", hunkId: string) => {
    if (snapshotId == null || hunkBusy) return;
    setHunkBusy(true);
    onRun({ type, snapshotId, hunkId }, (outcome) => {
      void (async () => {
        try {
          if (outcome === "succeeded") await onHunkSettled?.();
        } finally {
          setHunkBusy(false);
        }
      })();
    });
  };
  const label = (section: DiffFile) => (section.staged ? "INDEX ↔ HEAD" : "WORKTREE ↔ INDEX");
  return (
    <div className="diff-view">
      <header className="canvas-header">
        <button onClick={onBack}>← {t("back")}</button>
        <strong data-tooltip={diff.path}>{diff.path}</strong>
        {fileActions && (
          <div className="file-actions">
            <button onClick={() => onFileHistory?.(diff.path)}>{t("fileHistory")}</button>
            <button onClick={() => onBlame?.(diff.path)}>{t("blame")}</button>
          </div>
        )}
        {onToggleWhitespace && (
          <button
            className="diff-whitespace-toggle"
            aria-pressed={ignoreWhitespace}
            data-tooltip={t("ignoreWhitespace")}
            onClick={onToggleWhitespace}
          >
            {t("ignoreWhitespace")}
          </button>
        )}
        <span>{caption ?? (companionDiff ? undefined : label(diff))}</span>
      </header>
      <div className="diff-lines">
        {sections.map((section) => (
          <section className="diff-section" key={section.staged ? "staged" : "unstaged"}>
            {companionDiff && <div className="diff-section-label">{label(section)}</div>}
            <FileDiff
              diff={section}
              snapshotId={snapshotId}
              busy={hunkBusy}
              onHunk={runHunk}
              onRun={onRun}
            />
          </section>
        ))}
      </div>
    </div>
  );
}

export function BranchComparisonView({
  comparison,
  onBack,
}: {
  comparison: { patch: string };
  onBack: () => void;
}) {
  const { t } = useI18n();
  const files = useMemo(
    () =>
      comparison.patch
        .split(/(?=^diff --git )/m)
        .filter((patch) => patch.startsWith("diff --git "))
        .flatMap((patch) => {
          const file = parseDiff(patch)[0];
          if (!file) return [];
          const binary = file.isBinary || /^Binary files .+ differ$/m.test(patch);
          let additions = 0;
          let deletions = 0;
          for (const hunk of file.hunks) {
            for (const change of hunk.changes) {
              if (change.type === "insert") additions += 1;
              if (change.type === "delete") deletions += 1;
            }
          }
          return {
            path: file.type === "delete" ? file.oldPath : file.newPath,
            originalPath: file.type === "rename" || file.type === "copy" ? file.oldPath : null,
            additions: binary ? null : additions,
            deletions: binary ? null : deletions,
            staged: false,
            binary,
            tooLarge: false,
            patch,
            hunks: [],
          } satisfies DiffFile & CommitFileChange;
        }),
    [comparison],
  );
  const [selection, setSelection] = useState<{ comparison: typeof comparison; path: string }>();
  const selected =
    selection?.comparison === comparison
      ? files.find((file) => file.path === selection.path)
      : undefined;
  return (
    <div className="branch-comparison">
      <header className="canvas-header">
        <button onClick={selected ? () => setSelection(undefined) : onBack}>← {t("back")}</button>
        <strong>{selected?.path ?? t("branchComparison")}</strong>
        {selected && <span>{t("branchComparison")}</span>}
      </header>
      {files.length === 0 ? (
        <div className="canvas-empty" role="status">
          {t("noDifferences")}
        </div>
      ) : selected ? (
        <section className="diff-lines" aria-label={selected.path}>
          <section className="diff-section">
            <FileDiff diff={selected} busy={false} onHunk={() => {}} onRun={() => {}} readOnly />
          </section>
        </section>
      ) : (
        <ChangedFileList files={files} onOpenFile={(path) => setSelection({ comparison, path })} />
      )}
    </div>
  );
}
