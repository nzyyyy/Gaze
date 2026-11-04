import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { ContextMenu, type MenuTarget } from "./ContextMenu";
import type { DirEntry, Project } from "../lib/types";
import { errorMessage, parentPath } from "../lib/utils";
import { operationEntries, type FileOperation } from "./FileOperationDialog";

export interface TreeMenuTarget extends MenuTarget {
  project: Project;
  entry?: DirEntry;
  entries?: DirEntry[];
}

export function FileTreeMenu({
  target,
  onClose,
  onOperation,
  onRemoveProject,
  onPaste,
  onNotice,
  pasteBusy,
}: {
  target: TreeMenuTarget;
  onClose: () => void;
  onOperation: (operation: FileOperation) => void;
  onRemoveProject: (project: Project) => void;
  onPaste: (project: Project, parent: string) => void;
  onNotice: (message: string) => void;
  pasteBusy: boolean;
}) {
  const { project, entry } = target;
  const nativeSupported = /Mac/.test(navigator.userAgent);
  const [canPaste, setCanPaste] = useState(false);
  useEffect(() => {
    if (!nativeSupported) return;
    let cancelled = false;
    api
      .hasFileClipboard()
      .then((value) => {
        if (!cancelled) setCanPaste(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [nativeSupported]);
  const nativeAction = (action: () => Promise<void>, message?: string) => {
    onClose();
    void action()
      .then(() => {
        if (message) onNotice(message);
      })
      .catch((error) => onNotice(errorMessage(error)));
  };
  const choose = (operation: FileOperation) => {
    onClose();
    onOperation(operation);
  };
  if (entry && target.entries && target.entries.length > 1) {
    const entries = operationEntries({ kind: "move", project, entry, entries: target.entries });
    return (
      <ContextMenu target={target} label="文件操作" onClose={onClose}>
        <button
          role="menuitem"
          onClick={() => choose({ kind: "move", project, entry: entries[0]!, entries })}
        >
          移动所选 {entries.length} 项到…
        </button>
        <button
          role="menuitem"
          className="text-danger"
          onClick={() => choose({ kind: "trash", project, entry: entries[0]!, entries })}
        >
          将所选 {entries.length} 项移到废纸篓
        </button>
      </ContextMenu>
    );
  }
  const parent = !entry
    ? ""
    : entry.isDir && !entry.isSymlink
      ? entry.path
      : parentPath(entry.path);
  return (
    <ContextMenu target={target} label="文件操作" onClose={onClose}>
      <button
        role="menuitem"
        onClick={() => choose({ kind: "createFile", project, parentPath: parent })}
      >
        新建文件
      </button>
      <button
        role="menuitem"
        onClick={() => choose({ kind: "createDirectory", project, parentPath: parent })}
      >
        新建文件夹
      </button>
      {entry && (
        <button
          role="menuitem"
          disabled={!nativeSupported}
          onClick={() => nativeAction(() => api.copyEntry(project.id, entry.path), "已复制文件")}
        >
          复制
        </button>
      )}
      <button
        role="menuitem"
        disabled={!nativeSupported || !canPaste || pasteBusy || !!(entry?.isDir && entry.isSymlink)}
        onClick={() => {
          onClose();
          onPaste(project, parent);
        }}
      >
        粘贴
      </button>
      <button
        role="menuitem"
        disabled={!nativeSupported}
        onClick={() =>
          nativeAction(
            () => api.copyEntryPath(project.id, entry?.path ?? "", false),
            "已复制绝对路径",
          )
        }
      >
        复制绝对路径
      </button>
      <button
        role="menuitem"
        disabled={!nativeSupported}
        onClick={() =>
          nativeAction(
            () => api.copyEntryPath(project.id, entry?.path ?? "", true),
            "已复制相对路径",
          )
        }
      >
        复制相对路径
      </button>
      <button
        role="menuitem"
        disabled={!nativeSupported}
        onClick={() => nativeAction(() => api.revealEntry(project.id, entry?.path ?? ""))}
      >
        在访达中打开
      </button>
      {entry ? (
        <>
          <button role="menuitem" onClick={() => choose({ kind: "rename", project, entry })}>
            重命名
          </button>
          <button role="menuitem" onClick={() => choose({ kind: "move", project, entry })}>
            移动到…
          </button>
          <button
            role="menuitem"
            className="text-danger"
            onClick={() => choose({ kind: "trash", project, entry })}
          >
            移到废纸篓
          </button>
        </>
      ) : (
        <button
          role="menuitem"
          onClick={() => {
            onClose();
            onRemoveProject(project);
          }}
        >
          从工作区移除
        </button>
      )}
    </ContextMenu>
  );
}
