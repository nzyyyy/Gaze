import { closeCompletion, currentCompletions, hasNextSnippetField } from "@codemirror/autocomplete";
import { isolateHistory } from "@codemirror/commands";
import {
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type EditorState,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type ViewUpdate,
} from "@codemirror/view";
import { aiCompletionApi as api } from "./ai-completion-api";
import { pendingLspVersion, synchronizedLspVersion } from "../lib/editor/diagnostics";
import { aiCompletionError } from "./ai-completion-config";

const LSP_WAIT = 400;
const CACHE_SIZE = 4;
const CACHE_TTL = 30_000;
const BACKOFF_WAIT = 15_000;

interface Options {
  projectId: string;
  path: string;
  language: string;
  reserved: (state: EditorState) => boolean;
  onError: (message: string) => void;
}

interface Suggestion {
  id: number;
  doc: Text;
  pos: number;
  text: string;
  cacheKey?: string;
}

const show = StateEffect.define<Suggestion | null>();
let nextId = Math.floor(performance.timeOrigin * 1000);

function consume(suggestion: Suggestion | null, transaction: Transaction): Suggestion | null {
  if (!suggestion || !transaction.isUserEvent("input.type") || !suggestion.cacheKey) return null;
  let inserted: string | undefined;
  let multiple = false;
  transaction.changes.iterChanges((from, to, _from, _to, text) => {
    if (inserted !== undefined) multiple = true;
    if (from === suggestion.pos && to === from && inserted === undefined)
      inserted = text.toString();
  });
  if (multiple) return null;
  if (!inserted || !suggestion.text.startsWith(inserted)) return null;
  const pos = transaction.changes.mapPos(suggestion.pos, 1);
  if (transaction.newSelection.ranges.length !== 1 || transaction.newSelection.main.head !== pos)
    return null;
  const text = suggestion.text.slice(inserted.length);
  return text ? { ...suggestion, doc: transaction.newDoc, pos, text } : null;
}

class SuggestionCache {
  private entries: { key: string; text: string; at: number }[] = [];

  get(key: string) {
    const index = this.entries.findIndex((entry) => entry.key === key);
    const entry = this.entries[index];
    if (!entry) return undefined;
    if (Date.now() - entry.at >= CACHE_TTL) {
      this.entries.splice(index, 1);
      return undefined;
    }
    this.entries.splice(index, 1);
    this.entries.push(entry);
    return entry.text;
  }

  put(key: string, text: string) {
    this.entries = this.entries.filter((entry) => entry.key !== key);
    this.entries.push({ key, text, at: Date.now() });
    this.entries = this.entries.slice(-CACHE_SIZE);
  }
}

class Ghost extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: Ghost) {
    return this.text === other.text;
  }

  get lineBreaks() {
    return this.text.split("\n").length - 1;
  }

  toDOM(view: EditorView) {
    const span = view.dom.ownerDocument.createElement("span");
    span.className = "cm-gaze-ai-suggestion";
    span.textContent = this.text;
    return span;
  }
}

const suggestionField = StateField.define<Suggestion | null>({
  create: () => null,
  update(suggestion, transaction) {
    if (transaction.docChanged) suggestion = consume(suggestion, transaction);
    if ((transaction.selection && !transaction.docChanged) || transaction.state.readOnly)
      suggestion = null;
    for (const effect of transaction.effects) {
      if (effect.is(show)) suggestion = effect.value;
    }
    return suggestion;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (suggestion) =>
      suggestion
        ? Decoration.set([
            Decoration.widget({ widget: new Ghost(suggestion.text), side: 1 }).range(
              suggestion.pos,
            ),
          ])
        : Decoration.none,
    ),
});

export function completionContext(doc: Text, pos: number) {
  const before = Array.from(doc.sliceString(Math.max(0, pos - 6001), pos));
  const after = Array.from(doc.sliceString(pos, Math.min(doc.length, pos + 2001)));
  let prefix = before.slice(-3000).join("");
  let suffix = after.slice(0, 1000).join("");
  if (before.length > 3000 && prefix.includes("\n")) {
    prefix = prefix.slice(prefix.indexOf("\n") + 1);
  }
  if (after.length > 1000 && suffix.includes("\n")) {
    suffix = suffix.slice(0, suffix.lastIndexOf("\n") + 1);
  }
  return { prefix, suffix };
}

const identifiers = (text: string) => text.match(/[_\p{ID_Start}][_\p{ID_Continue}]{2,}/gu) ?? [];

function usefulSuggestion(state: EditorState, pos: number, text: string) {
  if (
    !text.trim() ||
    [...text.trim()].every((character) => ")]};,".includes(character)) ||
    text.length > 4096
  )
    return false;
  const line = state.doc.lineAt(pos);
  const typed = state.doc.sliceString(line.from, pos).match(/[\p{L}\p{N}_$]+$/u)?.[0];
  return !currentCompletions(state).some((item) => {
    if (!("insertion" in item) || typeof item.insertion !== "string") return false;
    const insertion = typed ? item.insertion.slice(typed.length) : item.insertion;
    return typed && item.insertion.startsWith(typed) && insertion === text;
  });
}

function inputChanged(transaction: Transaction) {
  return (
    transaction.docChanged &&
    (transaction.isUserEvent("input.type") ||
      transaction.isUserEvent("delete.backward") ||
      (transaction.annotation(Transaction.userEvent) === "input" &&
        transaction.newDoc.lines > transaction.startState.doc.lines))
  );
}

export function aiInlineCompletion(options: Options) {
  const plugin = ViewPlugin.fromClass(
    class {
      pending: number | null = null;
      displayed: number | null = null;
      readonly cache = new SuggestionCache();
      blockedUntil = 0;
      timer: ReturnType<typeof setTimeout> | undefined;
      disposed = false;
      composing = false;
      composed = false;
      lastError = "";
      edits: { text: string; at: number }[] = [];
      window: Window | null;
      private blur = () => this.invalidate();

      constructor(readonly view: EditorView) {
        this.window = view.dom.ownerDocument.defaultView;
        this.window?.addEventListener("blur", this.blur);
      }

      eligible() {
        const { state } = this.view;
        return (
          !this.disposed &&
          !this.composing &&
          !this.view.compositionStarted &&
          this.view.hasFocus &&
          this.view.dom.isConnected &&
          !state.readOnly &&
          state.facet(EditorView.editable) &&
          state.selection.ranges.length === 1 &&
          state.selection.main.empty &&
          !options.reserved(state)
        );
      }

      invalidate() {
        this.cancelRequest();
        this.hideSuggestion();
      }

      cancelRequest() {
        clearTimeout(this.timer);
        this.timer = undefined;
        if (this.pending !== null) {
          void api.cancelAiCompletion(this.pending).catch(() => undefined);
          this.pending = null;
        }
      }

      hideSuggestion() {
        this.displayed = null;
        const previous = this.view.state.field(suggestionField, false);
        if (previous) {
          queueMicrotask(() => {
            if (!this.disposed && this.view.state.field(suggestionField, false) === previous) {
              this.view.dispatch({ effects: show.of(null) });
            }
          });
        }
      }

      display(doc: Text, pos: number, text: string, cacheKey?: string) {
        const id = ++nextId;
        this.displayed = id;
        this.view.dispatch({ effects: show.of({ id, doc, pos, text, cacheKey }) });
      }

      update(update: ViewUpdate) {
        const previous = update.startState.field(suggestionField, false);
        const suggestion = update.state.field(suggestionField, false);
        if (suggestion?.cacheKey && suggestion.doc !== previous?.doc) {
          this.cache.put(suggestion.cacheKey, suggestion.text);
        }
        const reused =
          suggestion != null &&
          suggestion.id === this.displayed &&
          suggestion.doc === update.state.doc;
        if (
          suggestion &&
          !update.docChanged &&
          !update.selectionSet &&
          !usefulSuggestion(update.state, suggestion.pos, suggestion.text)
        ) {
          this.hideSuggestion();
          return;
        }
        if (
          (update.docChanged && !reused) ||
          (update.selectionSet && !reused) ||
          (update.focusChanged && !this.view.hasFocus) ||
          update.state.readOnly
        ) {
          this.invalidate();
        }
        if (!update.transactions.some(inputChanged)) return;
        const line = update.state.doc.lineAt(update.state.selection.main.head);
        const text = update.state.doc.sliceString(line.from, Math.min(line.to, line.from + 450));
        if (text.trim()) {
          this.edits = [
            { text, at: Date.now() },
            ...this.edits.filter((item) => item.text !== text),
          ].slice(0, 8);
        }
        if (this.composing || this.view.compositionStarted) {
          this.composed = true;
        } else if (!reused) {
          this.schedule();
        }
      }

      schedule() {
        clearTimeout(this.timer);
        if (Date.now() < this.blockedUntil) return;
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.request(false);
        }, 300);
      }

      async request(manual: boolean) {
        if (!this.eligible()) return;
        this.invalidate();
        const { state } = this.view;
        const doc = state.doc;
        const pos = state.selection.main.head;
        const line = doc.lineAt(pos);
        const { prefix, suffix } = completionContext(doc, pos);
        if (!manual && !prefix.trim() && !suffix.trim()) return;
        const symbols = new Set(identifiers(prefix.slice(-350) + suffix.slice(0, 100)));
        const recentEdits = this.edits
          .filter(
            ({ text, at }) =>
              Date.now() - at < 5 * 60_000 &&
              !prefix.includes(text) &&
              !suffix.includes(text) &&
              identifiers(text).some((word) => symbols.has(word)),
          )
          .slice(0, 2)
          .map(({ text }) => text);
        const cacheKey = JSON.stringify([prefix, suffix, recentEdits]);
        const cached = this.cache.get(cacheKey);
        if (cached) {
          if (usefulSuggestion(state, pos, cached)) this.display(doc, pos, cached, cacheKey);
          return;
        }
        const id = ++nextId;
        this.pending = id;
        try {
          // Diagnostics sync after edits, so wait briefly for a version that matches this buffer.
          let lspVersion = synchronizedLspVersion(this.view);
          if (!lspVersion && !manual) {
            const pending = pendingLspVersion(this.view, doc, LSP_WAIT);
            if (pending) lspVersion = await pending;
          }
          if (!this.current(id, doc, pos)) return;
          const reply = await api.requestAiCompletion({
            id,
            projectId: options.projectId,
            path: options.path,
            language: options.language,
            cursor: { line: line.number - 1, character: pos - line.from },
            lspVersion,
            prefix,
            suffix,
            recentEdits,
            manual,
          });
          if (!this.current(id, doc, pos)) return;
          if (reply.type === "error") {
            if (reply.kind === "rateLimited" || reply.kind === "backoff") {
              this.blockedUntil = Date.now() + Math.min(reply.retryAfterMs ?? BACKOFF_WAIT, 60_000);
            }
            if (reply.kind === "configuration" || reply.kind === "authentication") {
              this.blockedUntil = Number.POSITIVE_INFINITY;
            }
            // Surface each kind of failure once so a broken setup is never silent.
            if (manual || this.lastError !== reply.kind) {
              this.lastError = reply.kind;
              options.onError(aiCompletionError(reply.kind));
            }
          } else {
            this.lastError = "";
            this.blockedUntil = 0;
            if (reply.type === "suggestion" && usefulSuggestion(this.view.state, pos, reply.text)) {
              this.cache.put(cacheKey, reply.text);
              this.display(doc, pos, reply.text, cacheKey);
            }
          }
        } catch {
          if (manual && this.current(id, doc, pos))
            options.onError(aiCompletionError("unavailable"));
        } finally {
          if (this.pending === id) this.pending = null;
        }
      }

      current(id: number, doc: Text, pos: number) {
        return (
          this.pending === id &&
          this.eligible() &&
          this.view.state.doc === doc &&
          this.view.state.selection.main.head === pos
        );
      }

      destroy() {
        this.disposed = true;
        this.invalidate();
        this.window?.removeEventListener("blur", this.blur);
      }
    },
    {
      eventHandlers: {
        compositionstart() {
          this.composing = true;
          this.composed = false;
          this.invalidate();
        },
        compositionend() {
          this.composing = false;
          if (this.composed) this.schedule();
        },
      },
    },
  );

  return [
    suggestionField,
    plugin,
    EditorView.baseTheme({
      ".cm-gaze-ai-suggestion": {
        color: "var(--text-muted, #888)",
        opacity: "0.77",
        whiteSpace: "pre-wrap",
        pointerEvents: "none",
      },
    }),
    Prec.highest(
      keymap.of([
        {
          key: "Mod-Shift-Enter",
          run(view) {
            const controller = view.plugin(plugin);
            if (!controller?.eligible()) return false;
            void controller.request(true);
            return true;
          },
        },
        {
          key: "Tab",
          run(view) {
            const controller = view.plugin(plugin);
            const suggestion = view.state.field(suggestionField, false);
            if (
              !suggestion ||
              !controller?.eligible() ||
              controller.displayed !== suggestion.id ||
              hasNextSnippetField(view.state) ||
              view.state.doc !== suggestion.doc ||
              view.state.selection.main.head !== suggestion.pos
            )
              return false;
            view.dispatch({
              changes: { from: suggestion.pos, insert: suggestion.text },
              selection: { anchor: suggestion.pos + suggestion.text.length },
              annotations: [Transaction.userEvent.of("input.complete"), isolateHistory.of("full")],
            });
            closeCompletion(view);
            return true;
          },
        },
        {
          key: "Escape",
          run(view) {
            const controller = view.plugin(plugin);
            const pending = controller?.pending != null || controller?.timer !== undefined;
            const visible = view.state.field(suggestionField, false);
            if (!pending && !visible) return false;
            controller?.invalidate();
            if (visible) view.dispatch({ effects: show.of(null) });
            closeCompletion(view);
            return true;
          },
        },
      ]),
    ),
  ];
}
