import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  readMarkdownImage: vi.fn(),
  resolveMarkdownLink: vi.fn(),
  openExternalUrl: vi.fn(),
}));
vi.mock("../lib/platform/api", () => ({ api: apiMock }));
vi.mock("../plugins/mermaid/render", () => ({
  renderMermaid: vi.fn(
    async (code: string) =>
      `<svg viewBox="0 0 800 400" data-code="${encodeURIComponent(code)}"></svg>`,
  ),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  convertFileSrc: (filePath: string, protocol = "asset") =>
    `${protocol}://localhost/${encodeURIComponent(filePath)}`,
}));

import { renderMermaid } from "../plugins/mermaid/render";
import MarkdownPreview from "./MarkdownPreview";
import { pluginApi, type InstalledPlugin } from "../plugins/api";
import { PluginProvider } from "../plugins/runtime";
import { DEFAULT_PREFERENCES } from "../lib/settings/preferences";
import { ExternalPlugins } from "./ExternalPlugins";

const props = {
  projectId: "p1",
  documentPath: "docs/README.md",
  active: true,
  onNotice: vi.fn(),
  onOpenFile: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  apiMock.openExternalUrl.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MarkdownPreview", () => {
  it("builds a hierarchical outline from rendered headings and navigates duplicate anchors", async () => {
    const user = userEvent.setup();
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    render(
      <>
        <h2 id="gaze-markdown-中文标题-1">Outside</h2>
        <MarkdownPreview
          {...props}
          content={
            "Guide\n=====\n\n## 中文**标题**\n\n### Nested `code`\n\n## 中文标题\n\n```md\n# Not a heading\n```"
          }
        />
      </>,
    );
    const links = within(screen.getByRole("navigation", { name: "目录" })).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Guide",
      "中文标题",
      "Nested code",
      "中文标题",
    ]);
    expect(links[2]!.closest("li")).toHaveStyle({ paddingLeft: "24px" });
    expect(links[3]).toHaveAttribute("href", "#gaze-markdown-中文标题-1");
    await user.click(links[3]!);
    expect(scroll.mock.contexts[0]).toBe(screen.getAllByRole("heading", { name: "中文标题" })[1]);
    expect(apiMock.resolveMarkdownLink).not.toHaveBeenCalled();
  });

  it("collapses and reopens the outline using the keyboard", async () => {
    const user = userEvent.setup();
    render(<MarkdownPreview {...props} content="# Guide" />);
    const toggle = screen.getByRole("button", { name: "收起目录" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", screen.getByRole("navigation").id);
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开目录" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await user.keyboard(" ");
    expect(screen.getByRole("navigation")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Guide" })).toBeVisible();
  });

  it("resizes the outline by dragging its divider and collapses it past the threshold", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1024,
      height: 600,
      x: 0,
      y: 0,
      top: 0,
      bottom: 600,
      left: 0,
      right: 1024,
      toJSON: () => ({}),
    });
    const { container } = render(<MarkdownPreview {...props} content="# Guide" />);
    const separator = screen.getByRole("separator", { name: "调整目录宽度" });
    const outline = container.querySelector<HTMLElement>(".markdown-outline")!;
    let captured = false;
    separator.setPointerCapture = vi.fn(() => {
      captured = true;
    });
    separator.hasPointerCapture = vi.fn(() => captured);
    separator.releasePointerCapture = vi.fn(() => {
      captured = false;
    });
    const pointer = (type: string, clientX: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX, button: 0 });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireEvent(separator, event);
    };

    pointer("pointerdown", 220);
    pointer("pointermove", 300);
    expect(outline).toHaveStyle({ flexBasis: "300px" });
    expect(separator).toHaveAttribute("aria-valuenow", "300");
    pointer("pointermove", 40);
    expect(outline).toHaveClass("is-collapsed");
    expect(separator).toHaveAttribute("aria-valuenow", "0");
    pointer("pointerup", 40);
    expect(screen.getByRole("button", { name: "展开目录" })).toBeInTheDocument();
  });

  it("updates the outline after edits and hides it for documents without headings", () => {
    const { rerender } = render(<MarkdownPreview {...props} content="Plain text" />);
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "收起目录" })).not.toBeInTheDocument();
    rerender(<MarkdownPreview {...props} content="## Updated" />);
    expect(
      within(screen.getByRole("navigation")).getByRole("link", { name: "Updated" }),
    ).toHaveAttribute("href", "#gaze-markdown-updated");
    rerender(<MarkdownPreview {...props} content="Plain text again" />);
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it.each([
    ["**功能与场景：**在 Docker 中运行", "功能与场景："],
    ["这是**（重点）**内容", "（重点）"],
    ["**功能与场景：**", "功能与场景："],
  ])("renders CJK bold emphasis in %s", (content, bold) => {
    render(<MarkdownPreview {...props} content={content} />);
    expect(screen.getByText(bold).tagName).toBe("STRONG");
    expect(screen.getByRole("region")).not.toHaveTextContent("**");
  });

  it("keeps emphasis markers literal in code and when escaped", () => {
    const { container } = render(
      <MarkdownPreview
        {...props}
        content={
          "`**功能与场景：**在`\n\n```md\n**功能与场景：**在\n```\n\n\\*\\*功能与场景：\\*\\*在"
        }
      />,
    );
    expect(container.querySelectorAll("code")).toHaveLength(2);
    expect(container.querySelector("strong")).toBeNull();
    expect(screen.getByRole("region")).toHaveTextContent("**功能与场景：**在");
  });

  it("renders common Markdown and GFM while dropping unsafe HTML", () => {
    const { container } = render(
      <MarkdownPreview
        {...props}
        content={
          '# Guide\n\n**bold** and ~~old~~\n\n> quote\n\n- [x] complete\n- item\n\n| Name | Value |\n| --- | --- |\n| one | two |\n\n```ts\nconst x = 1;\n```\n\n<kbd>Ctrl</kbd>\n<script>alert(1)</script>\n<iframe src="https://example.com"></iframe>'
        }
      />,
    );
    expect(screen.getByRole("heading", { name: "Guide" })).toHaveAttribute(
      "id",
      "gaze-markdown-guide",
    );
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("old").tagName).toBe("DEL");
    expect(screen.getByText("quote").closest("blockquote")).not.toBeNull();
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByRole("table")).toHaveTextContent("one");
    expect(container.querySelector("pre")?.textContent).toContain("const x = 1;");
    expect(container.querySelector("kbd")).toHaveTextContent("Ctrl");
    expect(container.querySelector("script, iframe")).toBeNull();
  });

  it("hot toggles the math plugin independently of code highlighting", async () => {
    const content = "$x^2$\n\n```ts\nconst x = 1;\n```";
    const list = vi.spyOn(pluginApi, "list").mockResolvedValue([]);
    const preview = (markdownMathEnabled: boolean) => (
      <PluginProvider preferences={{ ...DEFAULT_PREFERENCES, markdownMathEnabled }}>
        <MarkdownPreview {...props} content={content} />
      </PluginProvider>
    );
    const { container, rerender } = render(preview(true));
    await waitFor(() => expect(container.querySelector(".katex")).not.toBeNull());
    expect(container.querySelector("pre code .token.keyword")?.textContent).toBe("const");
    rerender(preview(false));
    expect(container.querySelector(".katex")).toBeNull();
    expect(screen.getByText("$x^2$")).toBeInTheDocument();
    expect(container.querySelector("pre code .token.keyword")?.textContent).toBe("const");
    rerender(preview(true));
    expect(container.querySelector(".katex")).not.toBeNull();
    list.mockRestore();
  });

  it("zooms Mermaid without rebuilding the SVG or rerendering the diagram", async () => {
    const user = userEvent.setup();
    const content = "```mermaid\nflowchart TB\n  A --> B\n```\n\n![local](chart.png)";
    const { container, rerender } = render(<MarkdownPreview {...props} content={content} />);
    const image = screen.getByRole("img", { name: "local" });
    rerender(<MarkdownPreview {...props} content={content} active={false} />);
    expect(screen.getByRole("img", { name: "local" })).toBe(image);
    const svg = await waitFor(() => {
      const node = container.querySelector(".markdown-mermaid-canvas > svg");
      expect(node).not.toBeNull();
      return node!;
    });
    expect(svg.getAttribute("data-code")).toBe(encodeURIComponent("flowchart TB\n  A --> B"));
    const canvas = svg.parentElement;
    expect(canvas).toHaveStyle({ width: "100%", maxWidth: "800px", aspectRatio: "800 / 400" });
    const reset = screen.getByRole("button", { name: "恢复适应宽度" });
    await user.click(screen.getByRole("button", { name: "放大图表" }));
    expect(canvas).toHaveStyle({ width: "125%", maxWidth: "1000px" });
    expect(reset).toHaveTextContent("125%");
    rerender(<MarkdownPreview {...props} content={content + "\n\nMore text"} />);
    expect(reset).toHaveTextContent("125%");
    await user.click(screen.getByRole("button", { name: "缩小图表" }));
    await user.click(screen.getByRole("button", { name: "缩小图表" }));
    expect(canvas).toHaveStyle({ width: "75%" });
    await user.click(reset);
    expect(canvas).toHaveStyle({ width: "100%" });
    expect(canvas?.firstElementChild).toBe(svg);
    expect(renderMermaid).toHaveBeenCalledTimes(1);
  });

  it("renders Mermaid source while the plugin is off and renders a diagram when re-enabled", async () => {
    const code = "flowchart TB\n  A --> B";
    const content = `\`\`\`mermaid\n${code}\n\`\`\``;
    const { container, rerender } = render(
      <MarkdownPreview {...props} content={content} mermaidEnabled={false} />,
    );
    expect(container.querySelector("pre code.language-mermaid")?.textContent).toBe(`${code}\n`);
    expect(renderMermaid).not.toHaveBeenCalled();

    rerender(<MarkdownPreview {...props} content={content} mermaidEnabled />);
    expect(await screen.findByRole("figure", { name: "Mermaid 图表" })).toBeInTheDocument();

    rerender(<MarkdownPreview {...props} content={content} mermaidEnabled={false} />);
    expect(screen.queryByRole("figure", { name: "Mermaid 图表" })).not.toBeInTheDocument();
    expect(container.querySelector("pre code.language-mermaid")?.textContent).toBe(`${code}\n`);
    expect(renderMermaid).toHaveBeenCalledTimes(1);
  });

  it("cancels pending Mermaid work when the plugin is disabled and drops a late result", async () => {
    let finish!: (svg: string) => void;
    const renderDiagram = vi.mocked(renderMermaid);
    renderDiagram.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const content = "```mermaid\nflowchart TB\n  A --> B\n```";
    const { rerender } = render(<MarkdownPreview {...props} content={content} />);
    expect(renderDiagram).toHaveBeenCalledOnce();
    const signal = renderDiagram.mock.calls[0]![1];

    rerender(<MarkdownPreview {...props} content={content} mermaidEnabled={false} />);
    expect(signal.aborted).toBe(true);
    await act(async () => finish('<svg viewBox="0 0 800 400"></svg>'));
    expect(screen.queryByRole("figure", { name: "Mermaid 图表" })).not.toBeInTheDocument();
  });

  it("defers an offscreen Mermaid diagram and discards a result after leaving the viewport", async () => {
    let intersect!: (visible: boolean) => void;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", function (callback: IntersectionObserverCallback) {
      const observer = { observe, disconnect } as unknown as IntersectionObserver;
      intersect = (isIntersecting) => {
        act(() => {
          callback(
            [{ isIntersecting, boundingClientRect: { width: 800 } } as IntersectionObserverEntry],
            observer,
          );
        });
      };
      return observer;
    });
    let finish!: (svg: string) => void;
    const renderDiagram = vi.mocked(renderMermaid);
    renderDiagram.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    render(<MarkdownPreview {...props} content={"```mermaid\nflowchart TB\n  A --> B\n```"} />);
    expect(observe).toHaveBeenCalledTimes(1);
    intersect(false);
    expect(renderDiagram).not.toHaveBeenCalled();

    intersect(true);
    const signal = renderDiagram.mock.calls[0]![1];
    intersect(false);
    expect(signal.aborted).toBe(true);
    await act(async () => finish('<svg viewBox="0 0 800 400"></svg>'));
    expect(screen.queryByRole("figure", { name: "Mermaid 图表" })).not.toBeInTheDocument();

    intersect(true);
    expect(await screen.findByRole("figure", { name: "Mermaid 图表" })).toBeInTheDocument();
    expect(disconnect).toHaveBeenCalled();
  });

  it("uses scoped protocol URLs for local images and blocks remote images by default", async () => {
    render(
      <MarkdownPreview
        {...props}
        content={
          "![local](../images/a.png)\n\n![remote](https://example.com/a.png)\n\n![unsafe](data:text/html,bad)"
        }
      />,
    );
    const local = await screen.findByRole("img", { name: "local" });
    const url = new URL(local.getAttribute("src")!);
    expect(url.protocol).toBe("gaze-image:");
    expect(url.host).toBe("localhost");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      projectId: "p1",
      documentPath: "docs/README.md",
      src: "../images/a.png",
    });
    expect(local).toHaveAttribute("loading", "lazy");
    expect(local).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(apiMock.readMarkdownImage).not.toHaveBeenCalled();
    expect(screen.queryByRole("img", { name: "remote" })).not.toBeInTheDocument();
    expect(screen.getByRole("region")).toHaveTextContent("[远程图片已阻止：remote]");
    expect(screen.getByRole("button", { name: "允许本项目加载远程图片" })).toBeInTheDocument();
    fireEvent.error(local);
    expect(screen.getByText("[图片无法显示：local]")).toBeInTheDocument();
    expect(await screen.findByText("[图片无法显示：unsafe]")).toBeInTheDocument();
  });

  it("loads remote images after per-project trust without sharing it across projects", async () => {
    const user = userEvent.setup();
    const content = "![remote](https://example.com/a.png)";
    const { rerender, unmount } = render(
      <MarkdownPreview {...props} projectId="remote-p1" content={content} />,
    );
    await user.click(screen.getByRole("button", { name: "允许本项目加载远程图片" }));
    const remote = screen.getByRole("img", { name: "remote" });
    expect(remote).toHaveAttribute("src", "https://example.com/a.png");
    expect(remote).toHaveAttribute("loading", "lazy");
    expect(remote).toHaveAttribute("referrerpolicy", "no-referrer");
    rerender(<MarkdownPreview {...props} projectId="remote-p2" content={content} />);
    expect(screen.queryByRole("img", { name: "remote" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "允许本项目加载远程图片" })).toBeInTheDocument();
    unmount();
    render(<MarkdownPreview {...props} projectId="remote-p1" content={content} />);
    expect(screen.getByRole("img", { name: "remote" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "允许本项目加载远程图片" }),
    ).not.toBeInTheDocument();
  });

  it("limits mounted images and exposes an accessible fallback for the overflow", () => {
    const content = Array.from(
      { length: 51 },
      (_, index) => `![image-${index}](image-${index}.png)`,
    ).join("\n\n");
    const { container } = render(
      <MarkdownPreview {...props} projectId="image-limit" content={content} />,
    );
    expect(container.querySelectorAll("img")).toHaveLength(50);
    expect(screen.getByRole("img", { name: "image-49" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "image-50" })).not.toBeInTheDocument();
    expect(screen.getByText("[图片超过预览数量上限：image-50]")).toBeInTheDocument();
    expect(apiMock.readMarkdownImage).not.toHaveBeenCalled();
  });

  it("routes file and web links, confines anchors to its preview, and reports failures", async () => {
    const user = userEvent.setup();
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    apiMock.resolveMarkdownLink.mockResolvedValue({ path: "docs/next.md", fragment: "next" });
    render(
      <>
        <h1 id="gaze-markdown-guide">Outside</h1>
        <MarkdownPreview
          {...props}
          content={
            "# Guide\n\n[anchor](#guide) [file](next.md#next) [web](https://example.com) [unsafe](javascript:alert%281%29) [bad](file:///etc/passwd)"
          }
        />
      </>,
    );
    await user.click(screen.getByRole("link", { name: "anchor" }));
    expect(scroll.mock.contexts[0]).toBe(screen.getByRole("heading", { name: "Guide" }));
    await user.click(screen.getByRole("link", { name: "file" }));
    expect(apiMock.resolveMarkdownLink).toHaveBeenCalledWith(
      "p1",
      "docs/README.md",
      "next.md#next",
    );
    expect(props.onOpenFile).toHaveBeenCalledWith("p1", "docs/next.md", "next");
    await user.click(screen.getByRole("link", { name: "web" }));
    expect(apiMock.openExternalUrl).toHaveBeenCalledWith("https://example.com/");
    expect(screen.queryByRole("link", { name: "unsafe" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "bad" })).not.toBeInTheDocument();
    apiMock.resolveMarkdownLink.mockRejectedValueOnce(new Error("文件不存在"));
    await user.click(screen.getByRole("link", { name: "file" }));
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith("文件不存在"));
  });

  it("follows requested heading anchors after rendering", () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    render(
      <MarkdownPreview
        {...props}
        content="# 中文标题"
        request={{ fragment: "中文标题", nonce: 1 }}
      />,
    );
    expect(scroll.mock.contexts[0]).toBe(screen.getByRole("heading", { name: "中文标题" }));
  });
});

describe("external Markdown plugins", () => {
  const plugin: InstalledPlugin = {
    manifest: {
      id: "example.csv",
      name: "CSV",
      version: "1",
      apiVersion: 1,
      runtime: "javaScript",
      entry: "plugin.js",
      contributes: [{ kind: "markdown", language: "csv" }],
    },
    revision: "csv-version",
    enabled: true,
  };

  it("renders structured data and cancels pending work when disabled", async () => {
    const list = vi.spyOn(pluginApi, "list").mockResolvedValue([plugin]);
    const enable = vi.spyOn(pluginApi, "enable").mockResolvedValue([{ ...plugin, enabled: false }]);
    let finish!: (value: { kind: "text"; text: string }) => void;
    const run = vi
      .spyOn(pluginApi, "run")
      .mockResolvedValueOnce({ kind: "table", headers: ["Name"], rows: [["<img src=bad>"]] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    try {
      const view = (code: string) => (
        <PluginProvider preferences={DEFAULT_PREFERENCES}>
          <ExternalPlugins />
          <MarkdownPreview {...props} content={code} />
        </PluginProvider>
      );
      const { rerender } = render(view("```csv\nName\nGaze\n```"));
      expect(await screen.findByRole("cell", { name: "<img src=bad>" })).toBeInTheDocument();
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      rerender(view("```csv\nName\nChanged\n```"));
      await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
      const signal = run.mock.calls[1]![2];
      fireEvent.click(screen.getByRole("button", { name: "停用插件 CSV" }));
      await screen.findByRole("button", { name: "启用插件 CSV" });
      await waitFor(() => expect(signal.aborted).toBe(true));
      await act(async () => finish({ kind: "text", text: "Late output" }));
      expect(screen.queryByText("Late output")).not.toBeInTheDocument();
      expect(screen.getByText("Name Changed")).toBeInTheDocument();
    } finally {
      list.mockRestore();
      enable.mockRestore();
      run.mockRestore();
    }
  });

  it("requires an explicit second action to grant native authority", async () => {
    const native = {
      ...plugin,
      enabled: false,
      manifest: { ...plugin.manifest, name: "Native", runtime: "native" as const, contributes: [] },
    };
    const list = vi.spyOn(pluginApi, "list").mockResolvedValue([native]);
    const enable = vi.spyOn(pluginApi, "enable").mockResolvedValue([{ ...native, enabled: true }]);
    try {
      render(
        <PluginProvider preferences={DEFAULT_PREFERENCES}>
          <ExternalPlugins />
        </PluginProvider>,
      );
      fireEvent.click(await screen.findByRole("button", { name: "启用插件 Native" }));
      expect(enable).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "授权并启用" }));
      expect(await screen.findByRole("button", { name: "停用插件 Native" })).toBeInTheDocument();
      expect(enable).toHaveBeenCalledWith(native, true, true, expect.any(Array));
    } finally {
      list.mockRestore();
      enable.mockRestore();
    }
  });
});
