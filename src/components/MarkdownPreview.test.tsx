import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  readMarkdownImage: vi.fn(),
  resolveMarkdownLink: vi.fn(),
  openExternalUrl: vi.fn(),
}));
vi.mock("../lib/api", () => ({ api: apiMock }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  convertFileSrc: (filePath: string, protocol = "asset") =>
    `${protocol}://localhost/${encodeURIComponent(filePath)}`,
}));

import MarkdownPreview from "./MarkdownPreview";

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
afterEach(() => vi.restoreAllMocks());

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

  it("renders common Markdown and GFM without enabling HTML or task editing", () => {
    render(
      <MarkdownPreview
        {...props}
        content={
          '# Guide\n\n**bold** and ~~old~~\n\n> quote\n\n- [x] complete\n- item\n\n| Name | Value |\n| --- | --- |\n| one | two |\n\n```ts\nconst x = 1;\n```\n\n<script>alert(1)</script>\n<iframe src="https://example.com"></iframe>'
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
    expect(screen.getByText("const x = 1;").closest("pre")).not.toBeNull();
    expect(document.querySelector("script, iframe")).toBeNull();
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
