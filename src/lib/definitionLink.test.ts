import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { definitionLink } from "./definitionLink";
import { matchLanguage } from "./language";
import type { NavigationResult } from "./types";

vi.mock("./api", () => ({
  api: {
    syncDocument: vi.fn(),
    findDefinitions: vi.fn(),
    resolveMarkdownLink: vi.fn(),
  },
}));
let view: EditorView;
let agent: ReturnType<typeof vi.spyOn>;
const found: NavigationResult = {
  source: "lsp" as const,
  message: null,
  locations: [
    {
      projectId: "p",
      path: "src/main.tsx",
      name: "foo",
      kind: "function",
      source: "lsp",
      line: 0,
      character: 0,
      endLine: 0,
      endCharacter: 3,
    },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  agent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mac");
  vi.mocked(api.syncDocument).mockResolvedValue(undefined);
  vi.mocked(api.findDefinitions).mockResolvedValue(found);
  vi.mocked(api.resolveMarkdownLink).mockResolvedValue({ path: "src/main.tsx", fragment: null });
});
afterEach(() => {
  view?.destroy();
  document.body.replaceChildren();
  agent.mockRestore();
});

async function editor(doc: string, path = "index.html") {
  const navigate = vi.fn(),
    openFile = vi.fn();
  const parent = document.createElement("div");
  document.body.append(parent);
  const language = await matchLanguage(path).description?.load();
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [language ?? [], definitionLink("p", path, () => true, navigate, openFile)],
    }),
  });
  ensureSyntaxTree(view.state, doc.length, 1000);
  const position = vi.spyOn(view, "posAtCoords");
  vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 0, right: 1000, top: 0, bottom: 20 });
  const hover = (pos: number) => {
    position.mockReturnValue(pos);
    fireEvent.mouseMove(view.contentDOM, { metaKey: true });
  };
  const click = () => fireEvent.mouseDown(view.contentDOM, { button: 0, metaKey: true });
  const link = () => view.contentDOM.querySelector(".cm-definition-link");
  return { navigate, openFile, hover, click, link };
}

it("treats a root-relative HTML src as one checked file link across every segment", async () => {
  const doc = '<script type="module" src="/src/main.tsx"></script>';
  const { hover, click, link, openFile, navigate } = await editor(doc);
  for (const part of ["/src", "main", "tsx"]) {
    hover(doc.indexOf(part) + 1);
    await waitFor(() => expect(link()).toHaveTextContent("/src/main.tsx"));
  }
  expect(api.resolveMarkdownLink).toHaveBeenCalledTimes(1);
  expect(api.resolveMarkdownLink).toHaveBeenCalledWith("p", "index.html", "/src/main.tsx");
  expect(api.findDefinitions).not.toHaveBeenCalled();
  click();
  await waitFor(() => expect(openFile).toHaveBeenCalledWith("src/main.tsx", null));
  expect(navigate).not.toHaveBeenCalled();
});

it("ignores HTML tags, attribute names, ordinary attribute values and text", async () => {
  const doc = '<meta name="viewport" content="width=device-width"><title>Hello</title>';
  const { hover, click, link, navigate, openFile } = await editor(doc);
  for (const part of ["meta", "name", "viewport", "width", "title", "Hello"]) {
    hover(doc.indexOf(part) + 1);
    click();
    expect(link()).toBeNull();
  }
  expect(api.findDefinitions).not.toHaveBeenCalled();
  expect(api.resolveMarkdownLink).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  expect(openFile).not.toHaveBeenCalled();
});

it.each(["missing.tsx", "https://example.test/main.tsx", "//example.test/main.tsx"])(
  "does not highlight or open unavailable/remote HTML paths: %s",
  async (href) => {
    vi.mocked(api.resolveMarkdownLink).mockRejectedValue(new Error("not a project file"));
    const doc = `<script src="${href}"></script>`;
    const { hover, click, link, openFile } = await editor(doc);
    hover(doc.indexOf(href) + 1);
    click();
    await Promise.resolve();
    await Promise.resolve();
    expect(link()).toBeNull();
    expect(openFile).not.toHaveBeenCalled();
  },
);

it.each(['import { foo } from "./lib/foo";', 'import("./lib/foo");', 'require("./lib/foo");'])(
  "uses the whole module specifier for %s",
  async (doc) => {
    const { hover, link, click, navigate } = await editor(doc, "a.ts");
    hover(doc.indexOf("lib") + 1);
    await waitFor(() => expect(link()).toHaveTextContent("./lib/foo"));
    expect(api.findDefinitions).toHaveBeenCalledTimes(1);
    click();
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(api.resolveMarkdownLink).not.toHaveBeenCalled();
  },
);

it("only highlights identifiers with definitions, and skips keywords, strings and comments", async () => {
  const doc = 'const text = "hello"; // comment\nmissing(); foo();';
  const { hover, click, link, navigate } = await editor(doc, "a.ts");
  for (const part of ["const", "hello", "comment"]) {
    hover(doc.indexOf(part) + 1);
    click();
    expect(link()).toBeNull();
  }
  expect(api.findDefinitions).not.toHaveBeenCalled();
  vi.mocked(api.findDefinitions).mockResolvedValueOnce({ ...found, locations: [] });
  hover(doc.indexOf("missing") + 1);
  click();
  await waitFor(() => expect(api.findDefinitions).toHaveBeenCalledTimes(1));
  expect(link()).toBeNull();
  expect(navigate).not.toHaveBeenCalled();
  hover(doc.indexOf("foo") + 1);
  await waitFor(() => expect(link()).toHaveTextContent("foo"));
  expect(api.syncDocument).toHaveBeenLastCalledWith("p", "a.ts", doc);
});

it.each(["release", "edit", "destroy"])("discards pending results after %s", async (change) => {
  let finish!: (value: typeof found) => void;
  vi.mocked(api.findDefinitions).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { hover, link } = await editor("foo();", "a.ts");
  hover(1);
  await waitFor(() => expect(api.findDefinitions).toHaveBeenCalledTimes(1));
  if (change === "release") fireEvent.keyUp(window, { key: "Meta" });
  if (change === "edit") view.dispatch({ changes: { from: 0, insert: "x" } });
  if (change === "destroy") view.destroy();
  finish(found);
  await Promise.resolve();
  await Promise.resolve();
  expect(link()).toBeNull();
});
