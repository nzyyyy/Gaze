import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
