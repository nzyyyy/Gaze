import { diagnosticCount } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { api, type DiagnosticSnapshot } from "./api";
import { codeDiagnostics } from "./diagnostics";

vi.mock("./api", () => ({ api: { syncDocument: vi.fn(), onDiagnostics: vi.fn() } }));

afterEach(() => {
  vi.useRealTimers();
});

it("shows diagnostics for the unsaved snapshot and drops old results after editing", async () => {
  vi.useFakeTimers();
  let publish!: Parameters<typeof api.onDiagnostics>[0];
  const unlisten = vi.fn();
  vi.mocked(api.onDiagnostics).mockImplementation(async (callback) => {
    publish = callback;
    return unlisten;
  });
  const stamp = { session: "server", version: 1, items: null };
  vi.mocked(api.syncDocument)
    .mockResolvedValueOnce(stamp)
    .mockResolvedValueOnce({ ...stamp, version: 2 });
  const view = new EditorView({ doc: "😀 'wrong'", extensions: codeDiagnostics("p", "a.ts") });

  try {
    await vi.advanceTimersByTimeAsync(250);
    expect(api.syncDocument).toHaveBeenLastCalledWith("p", "a.ts", "😀 'wrong'");
    const items: DiagnosticSnapshot["items"] = [
      {
        start: { line: 0, character: 3 },
        end: { line: 0, character: 10 },
        severity: 1,
        message: "Type mismatch",
        source: "ts",
      },
    ];
    const wrong = { ...stamp, projectId: "p", path: "a.ts", items };
    publish({ ...wrong, path: "another.ts" });
    expect(diagnosticCount(view.state)).toBe(0);
    publish(wrong);
    expect(diagnosticCount(view.state)).toBe(1);
    expect(view.dom.querySelector(".cm-gutter-lint")).toBeNull();
    expect(view.dom.querySelector(".cm-lintRange-error")).toHaveTextContent("'wrong'");

    view.dispatch({ changes: { from: 3, to: 10, insert: "42" } });
    await vi.advanceTimersByTimeAsync(250);
    expect(api.syncDocument).toHaveBeenLastCalledWith("p", "a.ts", "😀 42");
    publish(wrong);
    expect(diagnosticCount(view.state)).toBe(0);
  } finally {
    view.destroy();
  }
  await Promise.resolve();
  expect(unlisten).toHaveBeenCalledOnce();
});
