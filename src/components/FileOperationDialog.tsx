import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, Folder, LoaderCircle } from "lucide-react";

import { api } from "../lib/api";
import type { DirEntry, Project } from "../lib/types";
import { errorMessage, parentPath } from "../lib/utils";

export type FileOperation =
  | { kind: "createFile" | "createDirectory"; project: Project; parentPath: string }
  | { kind: "rename"; project: Project; entry: DirEntry }
  | { kind: "move" | "trash"; project: Project; entry: DirEntry; entries?: DirEntry[] };

export interface BatchFileOperationResult {
  results: { source: DirEntry; entry?: DirEntry; error?: string }[];
}
export type FileOperationResult = DirEntry | BatchFileOperationResult | void;

export function operationEntries(operation: FileOperation): DirEntry[] {
  if (!("entry" in operation)) return [];
  const entries =
    "entries" in operation && operation.entries ? operation.entries : [operation.entry];
  const unique = [...new Map(entries.map((entry) => [entry.path, entry])).values()];
  const directories = new Set(
    unique.filter((entry) => entry.isDir && !entry.isSymlink).map((entry) => entry.path),
  );
  return unique.filter((entry) => {
    let parent = parentPath(entry.path);
    while (parent) {
      if (directories.has(parent)) return false;
      parent = parentPath(parent);
    }
    return true;
  });
}

const titles = {
  createFile: "新建文件",
  createDirectory: "新建文件夹",
  rename: "重命名",
  move: "移动到文件夹",
  trash: "移到废纸篓",
};

export function FileOperationDialog({
  operation,
  onSubmit,
  onClose,
}: {
  operation: FileOperation;
  onSubmit: (value: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(operation.kind === "rename" ? operation.entry.name : "");
  const [directory, setDirectory] = useState(
    "entry" in operation ? parentPath(operation.entry.path) : "",
  );
  const [listing, setListing] = useState<{ path: string; entries: DirEntry[] } | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const dialogRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const nameId = useId();
  const isMove = operation.kind === "move";
  const isTrash = operation.kind === "trash";
  const entries = operationEntries(operation);
  const subject =
    entries.length > 1 ? `所选 ${entries.length} 项` : `「${entries[0]?.path ?? ""}」`;

  useEffect(() => {
    const previous = document.activeElement;
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    } else {
      // Without a text field, start on the confirm button so Enter confirms and Escape cancels.
      const dialog = dialogRef.current;
      (
        dialog?.querySelector<HTMLElement>('button[type="submit"]:not(:disabled)') ??
        dialog?.querySelector<HTMLElement>("button:not(:disabled)")
      )?.focus();
    }
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (!isMove) return;
    let cancelled = false;
    setListingError(null);
    api
      .listDirectory(operation.project.id, directory)
      .then((result) => {
        if (!cancelled) setListing({ path: directory, entries: result.entries });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setListingError(errorMessage(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [directory, isMove, operation.project.id]);

  const ready = !isMove || (listing?.path === directory && !listingError);
  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting.current) onClose();
      }}
    >
      <form
        className="dialog file-operation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            if (!submitting.current) onClose();
          }
          if (event.key === "Tab") {
            const controls = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled), input:not(:disabled)",
              ),
            ];
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            }
            if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current || !ready) return;
          submitting.current = true;
          setBusy(true);
          setError(null);
          try {
            await onSubmit(isMove ? directory : name);
            onClose();
          } catch (reason) {
            setError(errorMessage(reason));
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
      >
        <div className="dialog-body">
          <h2 id={titleId}>{titles[operation.kind]}</h2>
          {isTrash ? (
            <p>
              将{subject}
              {entries.some((entry) => entry.isDir && !entry.isSymlink) ? "及其全部内容" : ""}
              移到系统废纸篓？可在系统废纸篓中恢复。
            </p>
          ) : isMove ? (
            <>
              <p>
                移动{subject}到：
                {directory || operation.project.name + "（项目根目录）"}
              </p>
              <div className="folder-picker" aria-label="目标文件夹">
                <button
                  type="button"
                  className="button button-small"
                  disabled={busy || !directory}
                  onClick={() => setDirectory(parentPath(directory))}
                >
                  <ChevronLeft size={14} />
                  上一级
                </button>
                {listingError ? (
                  <p role="alert">{listingError}</p>
                ) : listing?.path !== directory ? (
                  <p role="status">正在读取文件夹…</p>
                ) : (
                  <div className="folder-picker-list">
                    {listing.entries
                      .filter((entry) => entry.isDir && !entry.isSymlink)
                      .map((entry) => (
                        <button
                          type="button"
                          className="folder-picker-row"
                          key={entry.path}
                          disabled={
                            busy ||
                            entries.some(
                              (source) =>
                                entry.path === source.path ||
                                entry.path.startsWith(source.path + "/"),
                            )
                          }
                          onClick={() => setDirectory(entry.path)}
                        >
                          <Folder size={15} />
                          {entry.name}
                        </button>
                      ))}
                    {!listing.entries.some((entry) => entry.isDir && !entry.isSymlink) && (
                      <p>没有子文件夹</p>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <label htmlFor={nameId}>名称</label>
              <input
                id={nameId}
                className="file-name-input"
                ref={inputRef}
                value={name}
                disabled={busy}
                required
                autoComplete="off"
                onChange={(event) => setName(event.target.value)}
              />
            </>
          )}
          {entries.length > 1 && (
            <ul className="file-operation-selection" aria-label="操作项目">
              {entries.map((entry) => (
                <li key={entry.path}>{entry.path}</li>
              ))}
            </ul>
          )}
          {error && (
            <p className="dialog-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className={`button ${isTrash ? "button-danger" : "button-primary"}`}
            disabled={busy || !ready || (!isTrash && !isMove && !name.trim())}
          >
            {busy && <LoaderCircle size={13} className="spin" />}
            {isMove ? "移动到此文件夹" : titles[operation.kind]}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
