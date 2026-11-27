import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { changeBlockAtLine, setChangeBlocks } from "../../git/editorChanges";
import type { EditorDiffAnchor, EditorDiffSnapshot } from "../../git/EditorDiff";
import { useFileBase } from "../../git/hooks/useFileBase";
import { computeChangeBlocksAsync } from "../../git/lineDiffClient";
import type { ChangeBlock } from "../../git/lineDiff";
import { t } from "../../lib/i18n";
import type { TextFile } from "../../lib/types";
import { normalizeDocumentText, type LoadedState } from "./documentModel";

const GIT_DIFF_DELAY_MS = 300;
const GIT_DIFF_MAX_BYTES = 1024 * 1024;
const GIT_DIFF_MAX_LINES = 20_000;

export interface UseGitChangeBlocksOptions {
  projectId: string;
  path: string;
  viewRef: RefObject<EditorView | null>;
  documentRef: RefObject<TextFile | null>;
  operationLockedRef: RefObject<boolean>;
  gitLockedRef: RefObject<boolean>;
  activeRef: RefObject<boolean>;
  active: boolean;
  loaded: LoadedState | null;
  editorPopupsBlocked: boolean;
  gitLocked: boolean;
  onOpenComparison?: (snapshot: EditorDiffSnapshot) => void;
}

export interface GitChangeContext {
  view: EditorView;
  state: EditorState;
}

export function useGitChangeBlocks({
  projectId,
  path,
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
}: UseGitChangeBlocksOptions) {
  const gitBase = useFileBase(projectId, path, active);
  const gitBaseRef = useRef<string | null>(null);
  const gitSnapshotRef = useRef<{ doc: Text; base: string; blocks: ChangeBlock[] } | null>(null);
  const gitDiffTimerRef = useRef<number | null>(null);
  const gitDiffRequestRef = useRef(0);
  const gitSelectRef = useRef<(block: ChangeBlock, element: HTMLElement) => void>(() => undefined);
  const [gitBlocks, setGitBlocks] = useState<ChangeBlock[]>([]);
  const [changePopup, setChangePopup] = useState<{
    block: ChangeBlock;
    anchor: EditorDiffAnchor;
    view: EditorView;
    snapshot: NonNullable<typeof gitSnapshotRef.current>;
  } | null>(null);

  gitBaseRef.current = gitBase;

  const refreshGitChanges = useCallback(
    (view: EditorView) => {
      const request = ++gitDiffRequestRef.current;
      if (!activeRef.current) return;
      const base = gitBaseRef.current;
      const doc = view.state.doc;
      const tooLarge = doc.length > GIT_DIFF_MAX_BYTES || doc.lines > GIT_DIFF_MAX_LINES;
      const apply = (blocks: ChangeBlock[]) => {
        if (
          request !== gitDiffRequestRef.current ||
          viewRef.current !== view ||
          !activeRef.current ||
          view.state.doc !== doc ||
          gitBaseRef.current !== base
        )
          return;
        gitSnapshotRef.current = base === null ? null : { doc, base, blocks };
        setGitBlocks(blocks);
        view.dispatch({ effects: setChangeBlocks.of(blocks) });
      };
      if (base == null || tooLarge) {
        apply([]);
        return;
      }
      void computeChangeBlocksAsync(base, doc.toString()).then(apply, () => apply([]));
    },
    [activeRef, viewRef],
  );

  const jumpToChange = useCallback(
    (block: ChangeBlock) => {
      const view = viewRef.current;
      if (!view) return;
      const doc = view.state.doc;
      const line = doc.line(Math.min(Math.max(1, block.from), doc.lines));
      view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
      view.focus();
    },
    [viewRef],
  );

  const scheduleGitDiff = useCallback(
    (view: EditorView) => {
      if (gitBaseRef.current === null) return;
      if (gitDiffTimerRef.current !== null) window.clearTimeout(gitDiffTimerRef.current);
      gitDiffTimerRef.current = window.setTimeout(() => {
        gitDiffTimerRef.current = null;
        if (viewRef.current === view) refreshGitChanges(view);
      }, GIT_DIFF_DELAY_MS);
    },
    [refreshGitChanges, viewRef],
  );
  const scheduleGitDiffRef = useRef(scheduleGitDiff);
  scheduleGitDiffRef.current = scheduleGitDiff;

  const openChangePopup = useCallback(
    (block: ChangeBlock, anchor: EditorDiffAnchor) => {
      const view = viewRef.current;
      const snapshot = gitSnapshotRef.current;
      if (
        !view ||
        !snapshot ||
        snapshot.doc !== view.state.doc ||
        snapshot.base !== gitBaseRef.current ||
        !snapshot.blocks.includes(block)
      )
        return;
      setChangePopup({ block, anchor, view, snapshot });
    },
    [viewRef],
  );
  gitSelectRef.current = openChangePopup;

  const closeChangePopup = useCallback(
    (restoreFocus = false) => {
      setChangePopup(null);
      if (restoreFocus) viewRef.current?.focus();
    },
    [viewRef],
  );

  const currentChangePopup = () => {
    if (
      changePopup &&
      changePopup.view === viewRef.current &&
      changePopup.snapshot.doc === changePopup.view.state.doc &&
      changePopup.snapshot.base === gitBaseRef.current
    )
      return changePopup;
    closeChangePopup();
    return null;
  };

  const revertChange = () => {
    const popup = currentChangePopup();
    const view = viewRef.current;
    if (
      !popup ||
      !view ||
      !documentRef.current?.editable ||
      operationLockedRef.current ||
      gitLockedRef.current
    )
      return;
    const { block } = popup;
    const doc = view.state.doc;
    const nextLine = block.from + block.newLines.length;
    const insert = block.oldLines.join("\n");
    // Keep the separator with the replaced lines, including changes at EOF.
    const changes =
      doc.length === 0
        ? { from: 0, insert: normalizeDocumentText(popup.snapshot.base) }
        : nextLine <= doc.lines
          ? {
              from: doc.line(block.from).from,
              to: doc.line(nextLine).from,
              insert: block.oldLines.length ? `${insert}\n` : "",
            }
          : {
              from: block.from > 1 ? doc.line(block.from - 1).to : 0,
              to: doc.length,
              insert: block.oldLines.length && block.from > 1 ? `\n${insert}` : insert,
            };
    view.dispatch({ changes, userEvent: "delete.revert", scrollIntoView: false });
    closeChangePopup(true);
  };

  const openComparison = (wrap: boolean) => {
    const popup = currentChangePopup();
    if (!popup) return;
    const { doc, blocks } = popup.snapshot;
    onOpenComparison?.({ doc, blocks, selected: blocks.indexOf(popup.block), wrap });
    closeChangePopup();
  };

  const getChangeAtContext = (contextMenu: GitChangeContext | null) =>
    contextMenu &&
    gitSnapshotRef.current?.doc === contextMenu.state.doc &&
    gitSnapshotRef.current.base === gitBase
      ? changeBlockAtLine(
          contextMenu.view,
          contextMenu.state.doc.lineAt(contextMenu.state.selection.main.head).number,
        )
      : undefined;

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (gitDiffTimerRef.current !== null) {
      window.clearTimeout(gitDiffTimerRef.current);
      gitDiffTimerRef.current = null;
    }
    refreshGitChanges(view);
  }, [active, gitBase, loaded, refreshGitChanges, viewRef]);

  useEffect(
    () => () => {
      if (gitDiffTimerRef.current !== null) window.clearTimeout(gitDiffTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    setChangePopup(null);
  }, [active, gitBase, loaded, editorPopupsBlocked, gitLocked]);

  return {
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
  };
}

function changeLabel(block: ChangeBlock): string {
  const added = block.newLines.length;
  const removed = block.oldLines.length;
  if (block.kind === "added") return t("新增 {0} 行", added);
  if (block.kind === "deleted") return t("删除 {0} 行", removed);
  return t("修改 {0} 行（原 {1} 行）", added, removed);
}
