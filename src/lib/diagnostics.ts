import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import type { Text } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { api, type DiagnosticSnapshot } from "./api";
import { errorCode } from "./utils";

function sameVersion(a: DiagnosticSnapshot | null, b: DiagnosticSnapshot | null) {
  return a && b && a.session === b.session && a.version === b.version;
}

export function codeDiagnostics(projectId: string, path: string) {
  return [
    lintGutter(),
    ViewPlugin.fromClass(
      class {
        private disposed = false;
        private unavailable = false;
        private timer: ReturnType<typeof setTimeout> | undefined;
        private listen: Promise<(() => void) | undefined>;
        private snapshot: DiagnosticSnapshot | null = null;
        private received: DiagnosticSnapshot | null = null;

        constructor(private view: EditorView) {
          this.listen = Promise.resolve()
            .then(() =>
              api.onDiagnostics((batch) => {
                if (this.disposed || batch.projectId !== projectId || batch.path !== path) return;
                this.received = batch;
                if (sameVersion(this.snapshot, batch)) this.show(batch.items);
              }),
            )
            .catch(() => undefined);
          this.schedule();
        }

        update(update: ViewUpdate) {
          if (!update.docChanged) return;
          this.snapshot = null;
          this.received = null;
          const doc = update.state.doc;
          queueMicrotask(() => {
            if (!this.disposed && this.view.state.doc === doc && !this.snapshot) this.show(null);
          });
          this.schedule();
        }

        destroy() {
          this.disposed = true;
          clearTimeout(this.timer);
          void this.listen.then((unlisten) => unlisten?.());
        }

        private schedule() {
          if (this.unavailable) return;
          clearTimeout(this.timer);
          this.timer = setTimeout(() => void this.sync(), 250);
        }

        private async sync() {
          await this.listen;
          if (this.disposed || this.unavailable) return;
          const { doc } = this.view.state;
          try {
            const snapshot = await api.syncDocument(projectId, path, doc.toString());
            if (this.disposed || this.view.state.doc !== doc || !snapshot) return;
            this.snapshot = snapshot;
            this.show(sameVersion(this.received, snapshot) ? this.received!.items : snapshot.items);
          } catch (error) {
            this.unavailable = ["toolMissing", "unsupported"].includes(errorCode(error) ?? "");
          }
        }

        private show(items: DiagnosticSnapshot["items"]) {
          this.view.dispatch(
            setDiagnostics(this.view.state, editorDiagnostics(this.view.state.doc, items)),
          );
        }
      },
    ),
  ];
}

export function editorDiagnostics(doc: Text, items: DiagnosticSnapshot["items"]): Diagnostic[] {
  return (items ?? []).flatMap(({ start, end, severity, message, source }) => {
    if (start.line < 0 || end.line < start.line || end.line >= doc.lines) return [];
    const first = doc.line(start.line + 1);
    const last = doc.line(end.line + 1);
    if (
      start.character < 0 ||
      start.character > first.length ||
      end.character < 0 ||
      end.character > last.length
    )
      return [];
    const from = first.from + start.character;
    const to = last.from + end.character;
    if (from > to) return [];
    return [
      {
        from,
        to,
        severity:
          severity === 1 ? "error" : severity === 2 ? "warning" : severity === 4 ? "hint" : "info",
        message,
        source: source ?? undefined,
      },
    ];
  });
}
