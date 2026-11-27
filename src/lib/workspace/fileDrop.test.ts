import { afterEach, describe, expect, it, vi } from "vitest";
import { fileDropTarget } from "./fileDrop";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function hit(markup: string, selector: string) {
  document.body.innerHTML = markup;
  const elementFromPoint = vi.fn().mockReturnValue(document.querySelector(selector));
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: elementFromPoint,
  });
  return elementFromPoint;
}

describe("file drop targets", () => {
  it.each([
    ["Macintosh", 2, 240, 160],
    ["Macintosh", 1, 240, 160],
    ["Windows NT 10.0", 2, 120, 80],
    ["Linux", 1.5, 160, 160 / 1.5],
  ])("uses the native coordinate units for %s at scale %s", (platform, ratio, x, y) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(platform);
    vi.stubGlobal("devicePixelRatio", ratio);
    const point = hit(
      '<div class="file-tree-pane"><div data-drop-project="p2" data-drop-parent="src"><button>row</button></div></div>',
      "button",
    );
    expect(fileDropTarget({ x: 240, y: 160 }, "p1")).toMatchObject({
      kind: "copy",
      projectId: "p2",
      parent: "src",
    });
    expect(point).toHaveBeenCalledWith(x, y);
  });

  it("keeps the hovered row and the copy destination under the pointer on macOS Retina", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh");
    vi.stubGlobal("devicePixelRatio", 2);
    const point = hit(
      '<div class="file-tree-pane"><div id="docs" data-drop-project="p1" data-drop-parent="docs"></div><div id="file" data-drop-project="p1" data-drop-parent=""></div></div>',
      "#file",
    );
    point.mockImplementation((_x: number, y: number) =>
      document.querySelector(y < 300 ? "#docs" : "#file"),
    );
    const target = fileDropTarget({ x: 120, y: 500 }, "p1");
    expect(target).toMatchObject({ kind: "copy", projectId: "p1", parent: "" });
    expect(target?.element.id).toBe("file");
  });

  it("uses the active project for tree whitespace, including an empty workspace", () => {
    hit('<div class="file-tree-pane"><div class="empty"></div></div>', ".empty");
    expect(fileDropTarget({ x: 10, y: 20 }, "p1", 1)).toMatchObject({
      kind: "copy",
      projectId: "p1",
      parent: "",
    });
    expect(fileDropTarget({ x: 10, y: 20 }, null, 1)).toMatchObject({
      kind: "copy",
      projectId: null,
      parent: "",
    });
  });

  it.each(["document-area", "tab-strip"])("opens original files in %s", (region) => {
    hit(`<div class="${region}"><span>target</span></div>`, "span");
    expect(fileDropTarget({ x: 1, y: 1 }, null, 1)?.kind).toBe("open");
  });

  it("ignores unrelated regions and menus", () => {
    hit('<div class="terminal-panel"></div>', ".terminal-panel");
    expect(fileDropTarget({ x: 1, y: 1 }, "p1", 1)).toBeNull();
    hit('<div class="document-area"><div role="menu"><button>item</button></div></div>', "button");
    expect(fileDropTarget({ x: 1, y: 1 }, "p1", 1)).toBeNull();
  });
});
