import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SearchPanel } from "./SearchPanel";
import { api } from "../lib/api";
import { DEFAULT_PREFERENCES } from "../lib/preferences";

vi.mock("../lib/api", () => ({
  api: {
    onSearchEvent: vi.fn().mockResolvedValue(() => undefined),
    startSearch: vi.fn().mockResolvedValue(undefined),
    cancelSearch: vi.fn().mockResolvedValue(undefined),
    continueSearch: vi.fn().mockResolvedValue(undefined),
    previewReplace: vi.fn(),
    applyReplace: vi.fn(),
  },
}));

describe("SearchPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("applies saved search defaults and updates them without remounting", () => {
    const props = { active: true, focusSignal: 0, capabilities: null, onOpenLocation: vi.fn() };
    const { rerender } = render(
      <SearchPanel
        {...props}
        preferences={{
          ...DEFAULT_PREFERENCES,
          searchCaseSensitive: true,
          searchHidden: true,
          searchIgnored: true,
          searchRegex: true,
        }}
      />,
    );
    for (const title of [
      "区分大小写",
      "使用正则表达式",
      "包含隐藏文件",
      "包含被 .gitignore 忽略的文件",
    ]) {
      expect(screen.getByRole("button", { name: title })).toHaveAttribute("aria-pressed", "true");
    }
    rerender(<SearchPanel {...props} preferences={DEFAULT_PREFERENCES} />);
    expect(screen.getByRole("button", { name: "包含隐藏文件" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
  it("passes project scope and glob filters to workspace search", async () => {
    vi.useFakeTimers();
    try {
      render(
        <SearchPanel
          active
          focusSignal={0}
          capabilities={null}
          projects={[
            { id: "p1", name: "One", root: "/one" },
            { id: "p2", name: "Two", root: "/two" },
          ]}
          activeProjectId="p1"
          onOpenLocation={vi.fn()}
        />,
      );
      fireEvent.change(screen.getByLabelText("在工作区中搜索"), {
        target: { value: "needle" },
      });
      fireEvent.change(screen.getByLabelText("搜索范围"), { target: { value: "current" } });
      fireEvent.change(screen.getByLabelText("包含文件"), {
        target: { value: "src/**, *.ts" },
      });
      fireEvent.change(screen.getByLabelText("排除文件"), {
        target: { value: "src/generated/**" },
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(api.startSearch).toHaveBeenLastCalledWith(
        expect.any(String),
        "needle",
        expect.objectContaining({
          projectIds: ["p1"],
          includeGlobs: ["src/**", "*.ts"],
          excludeGlobs: ["src/generated/**"],
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an in-flight preview and ignores its late result", async () => {
    let finish!: (value: unknown) => void;
    const onPreviewReplace = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          finish = resolve;
        }),
    );
    const onCancelReplace = vi.fn();
    render(
      <SearchPanel
        active
        focusSignal={0}
        capabilities={null}
        onOpenLocation={vi.fn()}
        onPreviewReplace={onPreviewReplace}
        onApplyReplace={vi.fn()}
        onCancelReplace={onCancelReplace}
      />,
    );
    fireEvent.change(screen.getByLabelText("在工作区中搜索"), { target: { value: "needle" } });
    onCancelReplace.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "预览替换" }));
    const cancel = screen.getByRole("button", { name: "取消替换" });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    expect(onCancelReplace).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "取消替换" })).not.toBeInTheDocument();
    await act(async () =>
      finish({
        files: [
          {
            projectId: "p1",
            path: "a.txt",
            fingerprint: { size: 6, modifiedNs: "1" },
            matchCount: 1,
            lines: [],
          },
        ],
        skipped: [],
        truncated: false,
      }),
    );
    expect(screen.queryByText("1 个文件，1 处匹配")).not.toBeInTheDocument();
  });

  it("previews replacement and applies the confirmed files", async () => {
    const preview = {
      files: [
        {
          projectId: "p1",
          path: "src/a.ts",
          fingerprint: { size: 12, modifiedNs: "1" },
          matchCount: 2,
          lines: [{ lineNumber: 0, before: "needle", after: "value" }],
        },
      ],
      skipped: [],
      truncated: false,
    };
    vi.mocked(api.previewReplace).mockResolvedValue(preview);
    const onApplyReplace = vi.fn().mockResolvedValue({
      outcomes: [
        { projectId: "p1", path: "src/a.ts", status: "applied", matchCount: 2, message: null },
      ],
    });
    render(
      <SearchPanel
        active
        focusSignal={0}
        capabilities={null}
        onOpenLocation={vi.fn()}
        onPreviewReplace={(query, replacement, options) =>
          api.previewReplace("preview-request", query, replacement, options)
        }
        onApplyReplace={onApplyReplace}
        onCancelReplace={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("在工作区中搜索"), { target: { value: "needle" } });
    fireEvent.change(screen.getByLabelText("替换为"), { target: { value: "value" } });
    fireEvent.click(screen.getByRole("button", { name: "预览替换" }));
    expect(await screen.findByText("1 个文件，2 处匹配")).toBeInTheDocument();
    expect(screen.getByLabelText("替换 p1/src/a.ts")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "应用替换" }));
    expect(await screen.findByText("已替换 2 处；1 个文件已处理。")).toBeInTheDocument();
    expect(onApplyReplace).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "needle",
        replacement: "value",
        targets: [
          { projectId: "p1", path: "src/a.ts", fingerprint: { size: 12, modifiedNs: "1" } },
        ],
      }),
    );
  });

  it("offers one-click undo after a successful replacement", async () => {
    const outcome = {
      projectId: "p1",
      path: "src/a.ts",
      status: "applied",
      matchCount: 1,
      message: null,
    };
    const onPreviewReplace = vi.fn().mockResolvedValue({
      files: [
        {
          projectId: "p1",
          path: "src/a.ts",
          fingerprint: { size: 6, modifiedNs: "1" },
          matchCount: 1,
          lines: [],
        },
      ],
      skipped: [],
      truncated: false,
    });
    const onApplyReplace = vi.fn().mockResolvedValue({ outcomes: [outcome] });
    const onUndoReplace = vi.fn().mockResolvedValue({ outcomes: [outcome] });
    render(
      <SearchPanel
        active
        focusSignal={0}
        capabilities={null}
        onOpenLocation={vi.fn()}
        onPreviewReplace={onPreviewReplace}
        onApplyReplace={onApplyReplace}
        onUndoReplace={onUndoReplace}
      />,
    );
    fireEvent.change(screen.getByLabelText("在工作区中搜索"), { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: "预览替换" }));
    await screen.findByText("1 个文件，1 处匹配");
    fireEvent.click(screen.getByRole("button", { name: "应用替换" }));
    const undo = await screen.findByRole("button", { name: "撤销上次替换" });
    fireEvent.click(undo);
    expect(await screen.findByText("已恢复 1 个文件。")).toBeInTheDocument();
    expect(onUndoReplace).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "撤销上次替换" })).not.toBeInTheDocument();
  });

  it("shows every candidate and excludes unchecked files from the application", async () => {
    const files = Array.from({ length: 21 }, (_, index) => ({
      projectId: "p1",
      path: `${index}.txt`,
      fingerprint: { size: 1, modifiedNs: "1" },
      matchCount: 1,
      lines: [{ lineNumber: 0, before: "a", after: "b" }],
    }));
    const onPreviewReplace = vi.fn().mockResolvedValue({ files, skipped: [], truncated: false });
    const onApplyReplace = vi.fn().mockResolvedValue({ outcomes: [] });
    render(
      <SearchPanel
        active
        focusSignal={0}
        capabilities={null}
        onOpenLocation={vi.fn()}
        onPreviewReplace={onPreviewReplace}
        onApplyReplace={onApplyReplace}
        onCancelReplace={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("在工作区中搜索"), { target: { value: "a" } });
    fireEvent.click(screen.getByRole("button", { name: "预览替换" }));
    expect(await screen.findByLabelText("替换 p1/20.txt")).toBeChecked();
    expect(screen.getAllByRole("checkbox")).toHaveLength(21);
    fireEvent.click(screen.getByLabelText("替换 p1/20.txt"));
    fireEvent.click(screen.getByRole("button", { name: "应用替换" }));
    await waitFor(() => expect(onApplyReplace).toHaveBeenCalledOnce());
    const targets = onApplyReplace.mock.calls[0]![0].targets;
    expect(targets).toHaveLength(20);
    expect(targets).not.toContainEqual(expect.objectContaining({ path: "20.txt" }));
  });

  it("keeps operation results even if preferences change while applying and counts only successful matches", async () => {
    let finish!: (value: unknown) => void;
    const onApplyReplace = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          finish = resolve;
        }),
    );
    const onPreviewReplace = vi.fn().mockResolvedValue({
      files: [
        {
          projectId: "p1",
          path: "a.txt",
          fingerprint: { size: 6, modifiedNs: "1" },
          matchCount: 4,
          lines: [],
        },
      ],
      skipped: [],
      truncated: false,
    });
    const props = {
      active: true,
      focusSignal: 0,
      capabilities: null,
      onOpenLocation: vi.fn(),
      onPreviewReplace,
      onApplyReplace,
      onCancelReplace: vi.fn(),
    };
    const { rerender } = render(<SearchPanel {...props} />);
    fireEvent.change(screen.getByLabelText("在工作区中搜索"), { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: "预览替换" }));
    await screen.findByText("1 个文件，4 处匹配");
    fireEvent.click(screen.getByRole("button", { name: "应用替换" }));
    await waitFor(() => expect(onApplyReplace).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "取消替换" })).toBeDisabled();
    for (const label of ["在工作区中搜索", "替换为", "搜索范围", "包含文件", "排除文件"])
      expect(screen.getByLabelText(label)).toBeDisabled();
    expect(screen.getByRole("button", { name: "区分大小写" })).toBeDisabled();
    rerender(
      <SearchPanel
        {...props}
        preferences={{ ...DEFAULT_PREFERENCES, searchCaseSensitive: true }}
      />,
    );
    await act(async () =>
      finish({
        outcomes: [
          { projectId: "p1", path: "a.txt", status: "applied", matchCount: 1, message: null },
          {
            projectId: "p1",
            path: "b.txt",
            status: "conflict",
            matchCount: 3,
            message: "external conflict",
          },
        ],
      }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("external conflict");
    expect(screen.getByText("已替换 1 处；2 个文件已处理。")).toBeInTheDocument();
  });

  it("cancels confirmation when leaving search and disallows truncated replacements", async () => {
    const onPreviewReplace = vi.fn().mockResolvedValue({
      files: [
        {
          projectId: "p1",
          path: "a.txt",
          fingerprint: { size: 1, modifiedNs: "1" },
          matchCount: 5001,
          lines: [],
        },
      ],
      skipped: [],
      truncated: true,
    });
    const props = {
      active: true,
      focusSignal: 0,
      capabilities: null,
      onOpenLocation: vi.fn(),
      onPreviewReplace,
      onApplyReplace: vi.fn(),
      onCancelReplace: vi.fn(),
    };
    const { rerender, unmount } = render(<SearchPanel {...props} />);
    fireEvent.change(screen.getByLabelText("在工作区中搜索"), { target: { value: "a" } });
    fireEvent.click(screen.getByRole("button", { name: "预览替换" }));
    await screen.findByText("1 个文件，5001 处匹配");
    expect(screen.getByRole("button", { name: "应用替换" })).toBeDisabled();
    props.onCancelReplace.mockClear();
    rerender(<SearchPanel {...props} active={false} />);
    expect(props.onCancelReplace).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("在工作区中搜索")).not.toBeDisabled();
    unmount();
    expect(props.onCancelReplace).toHaveBeenCalledTimes(2);
  });

  it("disables content search and explains when ripgrep is unavailable", () => {
    render(
      <SearchPanel
        active
        focusSignal={0}
        capabilities={{
          rgAvailable: false,
          ctagsAvailable: true,
          ctagsMessage: null,
          configMessage: null,
          lspServers: [],
        }}
        onOpenLocation={vi.fn()}
      />,
    );
    expect(screen.getByText("未找到 ripgrep（rg）")).toBeInTheDocument();
    expect(screen.getByLabelText("在工作区中搜索")).toBeDisabled();
  });
});
