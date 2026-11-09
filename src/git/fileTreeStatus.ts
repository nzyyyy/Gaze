import { t as tr } from "../lib/i18n";
import type { FileChange } from "./models";

export interface GitDecoration {
  kind: "modified" | "added" | "deleted" | "renamed" | "conflict";
  label: string;
}

export function fileTreeStatus(files: FileChange[], prefix: string) {
  const result = new Map<string, GitDecoration>();
  const relative = (path: string) => {
    const clean = path.replace(/\/$/, "");
    return !prefix ? clean : clean.startsWith(prefix + "/") ? clean.slice(prefix.length + 1) : null;
  };
  const parent = (path: string, conflict: boolean) => {
    let current = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    while (true) {
      if (result.get(current)?.kind !== "conflict")
        result.set(current, {
          kind: conflict ? "conflict" : "modified",
          label: conflict ? tr("包含 Git 冲突") : tr("包含 Git 变更"),
        });
      if (!current) break;
      current = current.includes("/") ? current.slice(0, current.lastIndexOf("/")) : "";
    }
  };
  for (const file of files) {
    if (file.ignored) continue;
    const path = relative(file.path);
    if (path !== null) {
      const conflict = file.conflict;
      const kind = conflict
        ? "conflict"
        : file.kind === "untracked" || file.kind === "added" || file.kind === "copied"
          ? "added"
          : file.kind === "deleted"
            ? "deleted"
            : file.kind === "renamed"
              ? "renamed"
              : "modified";
      const label = conflict
        ? tr("Git 冲突")
        : file.kind === "untracked"
          ? tr("未跟踪")
          : kind === "added"
            ? tr("已新增")
            : kind === "deleted"
              ? tr("已删除")
              : kind === "renamed"
                ? tr("已重命名")
                : tr("已修改");
      result.set(path, {
        kind,
        label:
          label +
          (file.staged
            ? file.unstaged
              ? tr("（部分暂存）")
              : tr("（已暂存）")
            : tr("（未暂存）")),
      });
      parent(path, conflict);
    }
    if (file.originalPath) {
      const oldPath = relative(file.originalPath);
      if (oldPath !== null) parent(oldPath, false);
    }
  }
  return result;
}
