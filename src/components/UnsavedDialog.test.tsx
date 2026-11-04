import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { UnsavedDialog } from "./UnsavedDialog";

function renderDialog(overrides: Partial<Parameters<typeof UnsavedDialog>[0]> = {}) {
  const props = {
    title: "退出 Gaze？",
    message: "以下文件有未保存的修改。",
    files: ["Demo/src/a.ts"],
    saveLabel: "重试保存并退出",
    discardLabel: "放弃修改并退出",
    busy: false,
    error: null,
    onSave: vi.fn(),
    onDiscard: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<UnsavedDialog {...props} />);
  return props;
}

describe("UnsavedDialog", () => {
  it("offers save, discard and cancel actions", async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    expect(screen.getByRole("dialog", { name: "退出 Gaze？" })).toBeInTheDocument();
    expect(screen.getByText("Demo/src/a.ts")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试保存并退出" }));
    expect(props.onSave).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "放弃修改并退出" }));
    expect(props.onDiscard).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancels with Escape and shows save errors", async () => {
    const user = userEvent.setup();
    const props = renderDialog({ error: "文件已在磁盘上修改。" });

    expect(screen.getByText("文件已在磁盘上修改。")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables actions while saving", () => {
    renderDialog({ busy: true });
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重试保存并退出" })).toBeDisabled();
  });

  it("cycles dialog focus and restores the previous focus on close", async () => {
    const user = userEvent.setup();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    renderDialog();
    const cancel = screen.getByRole("button", { name: "取消" });
    const discard = screen.getByRole("button", { name: "放弃修改并退出" });
    const save = screen.getByRole("button", { name: "重试保存并退出" });

    expect(cancel).toHaveFocus();
    await user.tab();
    expect(discard).toHaveFocus();
    await user.tab();
    expect(save).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(save).toHaveFocus();

    cleanup();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
