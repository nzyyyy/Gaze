/**
 * Settings › Editor › Auto Import, on top of LSP code actions:
 * an unresolved reference whose quick fixes contain exactly one import action
 * gets it applied automatically after typing pauses.
 *
 * Inspired by openidea's `src/editor/lsp/autoImport.ts`.
 */
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { api, type DiagnosticSnapshot } from "./api";
import type { CodeAction, LspRange } from "./types";
import { errorCode } from "./utils";

const IDLE_MS = 1500;
const IMPORT_TITLE = /\bimport\b/i;
const MAX_DIAGNOSTICS_PER_RUN = 8;
const MAX_TRIED = 500;

/** The single import fix among `actions`, if exactly one exists. */
export function unambiguousImport(actions: readonly CodeAction[]): CodeAction | null {
  const imports = actions.filter(
    (a) =>
      !a.disabledReason && IMPORT_TITLE.test(a.title) && (!a.kind || a.kind.startsWith("quickfix")),
  );
  return imports.length === 1 ? imports[0]! : null;
}

/** Whether any edit in `action` for `path` overlaps 0-based `line` in `doc`. */
export function editTouchesLineInDoc(
  action: CodeAction,
  path: string,
  line: number,
  doc: { lines: number; line(n: number): { from: number; to: number } },
): boolean {
  if (line < 0 || line >= doc.lines) return false;
  const lineInfo = doc.line(line + 1);
  for (const f of action.edit?.files ?? []) {
    if (f.path !== path) continue;
    for (const e of f.edits) {
      // e.from / e.to are UTF-16 offsets; lineInfo.from / .to are also UTF-16
      // offsets in CodeMirror's Text. We compare directly.
      if (e.from <= lineInfo.to && e.to >= lineInfo.from) return true;
    }
  }
  return false;
}

/** Convert a CodeMirror offset range to an LSP range. */
function offsetsToLspRange(
  doc: { lineAt(pos: number): { from: number; number: number } },
  from: number,
  to: number,
): LspRange {
  const startLine = doc.lineAt(from);
  const endLine = doc.lineAt(to);
  return {
    start: { line: startLine.number - 1, character: from - startLine.from },
    end: { line: endLine.number - 1, character: to - endLine.from },
  };
}

export function autoImportExtension(projectId: string, path: string) {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | undefined;
      private unlisten: (() => void) | undefined;
      private tried = new Set<string>();
      private running = false;
      private unavailable = false;
      private disposed = false;
      private latestDiagnostics: DiagnosticSnapshot["items"] = null;

      constructor(private view: EditorView) {
        void api
          .onDiagnostics((batch) => {
            if (this.disposed || batch.projectId !== projectId || batch.path !== path) return;
            this.latestDiagnostics = batch.items;
            this.schedule();
          })
          .then((fn) => {
            if (this.disposed) fn();
            else this.unlisten = fn;
          })
          .catch(() => undefined);
        this.schedule();
      }

      update(u: ViewUpdate) {
        if (u.docChanged) this.schedule();
      }

      private schedule() {
        if (this.unavailable || this.disposed) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.run(), IDLE_MS);
      }

      private async run() {
        if (this.running || this.disposed || this.unavailable) return;
        const view = this.view;
        if (!view.dom.isConnected || !view.hasFocus) return;
        const diagnostics = this.latestDiagnostics;
        if (!diagnostics?.length) return;
        this.running = true;
        try {
          const caretLine = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
          const errors = diagnostics.filter((d) => d.severity === 1);
          for (const d of errors.slice(0, MAX_DIAGNOSTICS_PER_RUN)) {
            if (this.disposed) return;
            // Skip the diagnostic on the caret line: the user is still typing.
            if (d.start.line <= caretLine && caretLine <= d.end.line) continue;
            const key = `${d.start.line}:${d.start.character}:${d.message}`;
            if (this.tried.has(key)) continue;
            this.tried.add(key);
            const doc = view.state.doc;
            const from = doc.line(d.start.line + 1).from + d.start.character;
            const to = doc.line(d.end.line + 1).from + d.end.character;
            const range = offsetsToLspRange(doc, from, to);
            const result = await api.lspCodeActions(projectId, path, doc.toString(), range, [
              "quickfix",
            ]);
            if (this.disposed) return;
            const fix = unambiguousImport(result.actions);
            if (fix?.edit && !editTouchesLineInDoc(fix, path, caretLine, doc)) {
              this.applyEdit(fix);
              return;
            }
          }
          if (this.tried.size > MAX_TRIED) this.tried.clear();
        } catch (error) {
          const code = errorCode(error);
          if (code === "toolMissing" || code === "unsupported") {
            this.unavailable = true;
          }
        } finally {
          this.running = false;
        }
      }

      private applyEdit(action: CodeAction) {
        const view = this.view;
        const doc = view.state.doc;
        const changes = (action.edit?.files ?? [])
          .filter((f) => f.path === path)
          .flatMap((f) => f.edits)
          .map((e) => ({ from: e.from, to: e.to, insert: e.insert }));
        if (!changes.length) return;
        // Validate offsets are within the document.
        const valid = changes.every((c) => c.from >= 0 && c.to <= doc.length && c.from <= c.to);
        if (!valid) return;
        view.dispatch({ changes });
      }

      destroy() {
        this.disposed = true;
        clearTimeout(this.timer);
        this.unlisten?.();
      }
    },
  );
}
