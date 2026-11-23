import { completionStatus, startCompletion } from "@codemirror/autocomplete";
import { history, undo } from "@codemirror/commands";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { codeCompletion } from "../lib/completion";
import { aiInlineCompletion, completionContext } from "./ai-completion";
import type { AiCompletionReply } from "./ai-completion-config";

vi.mock("../lib/api", () => ({
  api: {
    requestAiCompletion: vi.fn(),
    cancelAiCompletion: vi.fn(),
    completeCode: vi.fn(),
    resolveCompletion: vi.fn(),
  },
}));

let view: EditorView;
let host: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.mocked(api.cancelAiCompletion).mockResolvedValue(undefined);
  vi.mocked(api.completeCode).mockResolvedValue({
    items: [
      {
        label: "format",
        insertText: "format",
        detail: null,
        documentation: null,
        kind: null,
        filterText: null,
        edit: null,
        additionalEdits: [],
      },
    ],
  });
});

afterEach(() => {
  view?.destroy();
  host?.remove();
  vi.useRealTimers();
});

function open(reserved = () => false) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const ai = new Compartment();
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      extensions: [
        history(),
        codeCompletion("p", "example.ts", undefined, true, true),
        ai.of(
          aiInlineCompletion({
            projectId: "p",
            path: "example.ts",
            language: "TypeScript",
            reserved,
            onError: vi.fn(),
          }),
        ),
      ],
    }),
  });
  view.focus();
  return ai;
}

function type(text: string) {
  const from = view.state.selection.main.head;
  view.dispatch({
    changes: { from, insert: text },
    selection: { anchor: from + text.length },
    userEvent: "input.type",
  });
}

function key(key: string) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

function ghost() {
  return host.querySelector(".cm-gaze-ai-suggestion")?.textContent;
}

it.each(["Tab", "Enter"])(
  "shows both sources and accepts the intended result with %s",
  async (accept) => {
    open();
    vi.mocked(api.requestAiCompletion).mockResolvedValue({ type: "suggestion", text: "o()" });
    type("fo");
    startCompletion(view);
    await vi.advanceTimersByTimeAsync(300);
    expect(completionStatus(view.state)).toBe("active");
    expect(host.querySelector(".cm-tooltip-autocomplete")).not.toBeNull();
    expect(ghost()).toBe("o()");
    key("ArrowDown");
    expect(ghost()).toBe("o()");
    expect(api.requestAiCompletion).toHaveBeenCalledTimes(1);
    key(accept);
    expect(view.state.doc.toString()).toBe(accept === "Tab" ? "foo()" : "format");
    expect(ghost()).toBeUndefined();
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("fo");
  },
);

it("invalidates in-flight and out-of-order replies when typing, moving or switching away", async () => {
  const ai = open();
  let older!: (reply: AiCompletionReply) => void;
  let newer!: (reply: AiCompletionReply) => void;
  vi.mocked(api.requestAiCompletion)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          older = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          newer = resolve;
        }),
    );
  type("con");
  await vi.advanceTimersByTimeAsync(299);
  expect(api.requestAiCompletion).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  const first = vi.mocked(api.requestAiCompletion).mock.calls[0]![0].id;
  type("s");
  expect(api.cancelAiCompletion).toHaveBeenCalledWith(first);
  await vi.advanceTimersByTimeAsync(300);
  newer({ type: "suggestion", text: "t x = 1" });
  await Promise.resolve();
  older({ type: "suggestion", text: "sole.log()" });
  await Promise.resolve();
  expect(ghost()).toBe("t x = 1");
  view.dispatch({ selection: { anchor: 0 } });
  expect(ghost()).toBeUndefined();

  vi.mocked(api.requestAiCompletion).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        newer = resolve;
      }),
  );
  type("x");
  await vi.advanceTimersByTimeAsync(300);
  view.dispatch({ effects: ai.reconfigure([]) });
  newer({ type: "suggestion", text: "late" });
  await Promise.resolve();
  expect(ghost()).toBeUndefined();
});

it("requests a suggestion on demand with the platform modifier", () => {
  open();
  vi.mocked(api.requestAiCompletion).mockResolvedValue({ type: "suggestion", text: " = 1" });
  type("count");
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(api.requestAiCompletion).toHaveBeenCalledOnce();
  expect(vi.mocked(api.requestAiCompletion).mock.calls[0]![0]).toMatchObject({
    manual: true,
    prefix: "count",
  });
});

it("waits for IME commit and suppresses the reserved editor context", async () => {
  let reserved = false;
  open(() => reserved);
  vi.mocked(api.requestAiCompletion).mockResolvedValue({ type: "suggestion", text: " = 1" });
  view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  type("名称");
  await vi.advanceTimersByTimeAsync(400);
  expect(api.requestAiCompletion).not.toHaveBeenCalled();
  view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(400);
  expect(api.requestAiCompletion).toHaveBeenCalledOnce();
  reserved = true;
  type("x");
  await vi.advanceTimersByTimeAsync(400);
  expect(api.requestAiCompletion).toHaveBeenCalledOnce();
  expect(ghost()).toBeUndefined();
});

it("keeps both bounded context segments and UTF-16 cursor alignment", () => {
  const text = "😀".repeat(3500) + "\n  return target" + "\n" + "界".repeat(1200);
  const doc = EditorState.create({ doc: text }).doc;
  const pos = text.indexOf("target");
  const { prefix, suffix } = completionContext(doc, pos);
  expect(prefix).toBe("  return ");
  expect(suffix).toBe("target\n");
});
