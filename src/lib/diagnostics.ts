import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import type { Text } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { api, type DiagnosticSnapshot } from "./api";
import { errorCode } from "./utils";

type LspVersion = Pick<DiagnosticSnapshot, "session" | "version">;

interface SyncTracker {
  record: { doc: Text; version: LspVersion } | null;
  /** A document sync is scheduled or in flight. */
  pending: boolean;
  /** The file has no language server, so no version will ever arrive. */
  unsupported: boolean;
  waiters: Set<() => void>;
}

const trackers = new WeakMap<EditorView, SyncTracker>();

function track(view: EditorView) {
  let tracker = trackers.get(view);
  if (!tracker) {
    tracker = { record: null, pending: true, unsupported: false, waiters: new Set() };
    trackers.set(view, tracker);
  }
  return tracker;
}

export function synchronizedLspVersion(view: EditorView): LspVersion | undefined {
  const record = trackers.get(view)?.record;
  return record?.doc === view.state.doc ? record.version : undefined;
}

/**
 * Waits for the document sync when one is still pending. Returns `undefined`
 * when the editor has no server or nothing left to wait for, so callers can
 * proceed immediately without an extra microtask.
 */
export function pendingLspVersion(
  view: EditorView,
  doc: Text,
  timeout: number,
): Promise<LspVersion | undefined> | undefined {
  const tracker = trackers.get(view);
  if (!tracker || tracker.unsupported || !tracker.pending) return undefined;
  if (tracker.record?.doc === doc) return Promise.resolve(tracker.record.version);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timer);
      tracker.waiters.delete(finish);
      resolve(tracker.record?.doc === doc ? tracker.record.version : undefined);
    };
    timer = setTimeout(finish, timeout);
    tracker.waiters.add(finish);
  });
}

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
        private syncing = false;
        private timer: ReturnType<typeof setTimeout> | undefined;
        private listen: Promise<(() => void) | undefined>;
        private snapshot: DiagnosticSnapshot | null = null;
        private received: DiagnosticSnapshot | null = null;

        constructor(private view: EditorView) {
          track(view);
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
          const tracker = trackers.get(this.view);
          if (tracker) {
            tracker.pending = false;
            tracker.waiters.forEach((resolve) => resolve());
            tracker.waiters.clear();
            trackers.delete(this.view);
          }
          void this.listen.then((unlisten) => unlisten?.());
        }

        /** Marks the sync as settled once nothing is queued or in flight. */
        private notify() {
          const tracker = track(this.view);
          tracker.pending = this.timer !== undefined || this.syncing;
          if (tracker.pending) return;
          tracker.waiters.forEach((resolve) => resolve());
          tracker.waiters.clear();
        }

        private schedule() {
          if (this.unavailable) return;
          clearTimeout(this.timer);
          track(this.view).pending = true;
          this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.sync();
          }, 250);
        }

        private async sync() {
          await this.listen;
          if (this.disposed || this.unavailable) {
            this.notify();
            return;
          }
          this.syncing = true;
          try {
            const { doc } = this.view.state;
            const snapshot = await api.syncDocument(projectId, path, doc.toString());
            if (this.disposed || this.view.state.doc !== doc || !snapshot) return;
            this.snapshot = snapshot;
            track(this.view).record = {
              doc,
              version: { session: snapshot.session, version: snapshot.version },
            };
            this.show(sameVersion(this.received, snapshot) ? this.received!.items : snapshot.items);
          } catch (error) {
            this.unavailable = ["toolMissing", "unsupported"].includes(errorCode(error) ?? "");
            if (this.unavailable) track(this.view).unsupported = true;
          } finally {
            this.syncing = false;
            this.notify();
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
