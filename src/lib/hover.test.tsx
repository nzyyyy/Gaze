import { act } from "react";
import { EditorState } from "@codemirror/state";
import type { EditorView, Tooltip } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { lspHoverSource } from "./hover";

vi.mock("./api", () => ({ api: { hoverCode: vi.fn() } }));
afterEach(() => {
  document.body.replaceChildren();
  vi.resetAllMocks();
});

function editor(text = "/* 😀 */ findUser(1)") {
  const dom = document.createElement("div");
  document.body.append(dom);
  return { state: EditorState.create({ doc: text }), dom } as unknown as EditorView;
}

it("requests unsaved text with UTF-16 positions and renders safe documentation", async () => {
  const view = editor();
  vi.mocked(api.hoverCode).mockResolvedValue([
    { value: "function findUser(id: number): User", language: "typescript", kind: "markdown" },
    {
      value: "**Find user** ![tracking](https://example.test/image) [link](javascript:alert(1))",
      language: null,
      kind: "markdown",
    },
    { value: "<img src=x onerror=alert(1)>", language: null, kind: "plaintext" },
  ]);
  const tip = (await lspHoverSource("p", "a.ts")(view, 11, 1)) as Tooltip;
  expect(api.hoverCode).toHaveBeenCalledWith("p", "a.ts", view.state.doc.toString(), {
    line: 0,
    character: 11,
  });
  expect([tip.pos, tip.end]).toEqual([9, 17]);
  let tooltip!: ReturnType<Tooltip["create"]>;
  await act(async () => {
    tooltip = tip.create(view);
    document.body.append(tooltip.dom);
  });
  expect(tooltip.dom.querySelector("pre")).toHaveTextContent("function findUser");
  expect(tooltip.dom.querySelector("strong")).toHaveTextContent("Find user");
  expect(tooltip.dom).toHaveTextContent("<img src=x onerror=alert(1)>");
  expect(tooltip.dom.querySelector("img, a, script")).toBeNull();
  await act(async () => tooltip.destroy?.());
});

it("ignores whitespace, outward word boundaries and unavailable servers", async () => {
  const view = editor();
  const source = lspHoverSource("p", "a.ts");
  expect(await source(view, 8, 1)).toBeNull();
  expect(await source(view, 9, -1)).toBeNull();
  expect(await source(view, 17, 1)).toBeNull();
  expect(api.hoverCode).not.toHaveBeenCalled();
  vi.mocked(api.hoverCode).mockRejectedValue({ code: "toolMissing" });
  expect(await source(view, 11, 1)).toBeNull();
});

it.each(["edit", "destroy", "empty"])("ignores %s responses", async (change) => {
  const view = editor();
  let finish!: (value: Awaited<ReturnType<typeof api.hoverCode>>) => void;
  vi.mocked(api.hoverCode).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = lspHoverSource("p", "a.ts")(view, 11, 1);
  if (change === "edit")
    Object.assign(view, { state: view.state.update({ changes: { from: 0, insert: "x" } }).state });
  if (change === "destroy") view.dom.remove();
  finish(change === "empty" ? [] : [{ value: "old", kind: "plaintext", language: null }]);
  expect(await pending).toBeNull();
});
