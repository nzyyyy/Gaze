import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { DEFAULT_FONT_SETTINGS } from "../lib/fonts";
import { DEFAULT_COLOR_SCHEMES } from "../lib/colorSchemes";
import { DEFAULT_PREFERENCES, type AppSettings } from "../lib/preferences";
import { DEFAULT_LAYOUT } from "../lib/layout";
import { SettingsDialog } from "./SettingsDialog";

const settings: AppSettings = {
  theme: "system",
  fonts: DEFAULT_FONT_SETTINGS,
  colorSchemes: DEFAULT_COLOR_SCHEMES,
  preferences: DEFAULT_PREFERENCES,
};
function category(name: string) {
  return within(screen.getByRole("navigation", { name: "设置分类" })).getByRole("button", { name });
}

it("uses the themed dropdown for theme modes and saves its selected value", async () => {
  const user = userEvent.setup();
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<SettingsDialog settings={settings} onSave={onSave} onClose={vi.fn()} />);
  const theme = screen.getByRole("combobox", { name: "主题模式" });
  expect(theme.tagName).toBe("BUTTON");
  expect(document.querySelector("select")).toBeNull();
  await user.click(theme);
  await user.keyboard("{End}{Enter}");
  expect(theme).toHaveTextContent("夜间模式");
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ theme: "dark" }),
    expect.any(Object),
  );
});

it("shows one category and preserves drafts across categories and searches", async () => {
  const user = userEvent.setup();
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<SettingsDialog settings={settings} onSave={onSave} onClose={vi.fn()} />);
  expect(screen.getByRole("button", { name: "GitHub Light" })).toBeInTheDocument();
  expect(screen.queryByRole("spinbutton", { name: "编辑器字号" })).not.toBeInTheDocument();
  await user.click(category("编辑器"));
  await user.clear(screen.getByRole("spinbutton", { name: "编辑器字号" }));
  await user.type(screen.getByRole("spinbutton", { name: "编辑器字号" }), "16");
  await user.click(screen.getByRole("switch", { name: "自动换行" }));
  expect(screen.getByRole("switch", { name: "内容缩略图" })).toBeChecked();
  await user.click(screen.getByRole("switch", { name: "内容缩略图" }));
  await user.click(category("终端"));
  await user.click(screen.getByRole("combobox", { name: "光标样式" }));
  await user.click(screen.getByRole("option", { name: "竖线" }));
  await user.type(screen.getByRole("searchbox", { name: "搜索设置" }), "字号");
  expect(screen.queryByRole("spinbutton", { name: "缩进宽度" })).not.toBeInTheDocument();
  expect(screen.getByRole("spinbutton", { name: "终端字号" })).toBeInTheDocument();
  expect(screen.getByRole("spinbutton", { name: "编辑器字号" })).toHaveValue(16);
  await user.click(category("编辑器"));
  expect(screen.getByRole("switch", { name: "自动换行" })).not.toBeChecked();
  expect(screen.getByRole("switch", { name: "内容缩略图" })).not.toBeChecked();
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  expect(onSave).toHaveBeenCalledWith(
    {
      ...settings,
      preferences: {
        ...DEFAULT_PREFERENCES,
        editorFontSize: 16,
        wordWrap: false,
        showMinimap: false,
        terminalCursorStyle: "bar",
      },
    },
    expect.any(Object),
  );
});

it("keeps font keyboard selection and disables controls while saving", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  let finish!: () => void;
  const onSave = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(<SettingsDialog settings={settings} onSave={onSave} onClose={onClose} />);
  await user.click(category("编辑器"));
  const editor = screen.getByRole("combobox", { name: "编辑器字体" });
  await user.click(editor);
  await user.keyboard("{End}{Escape}");
  expect(editor).toHaveAttribute("aria-expanded", "false");
  expect(editor).toHaveTextContent("Maple Mono");
  expect(onClose).not.toHaveBeenCalled();
  await user.keyboard("{ArrowDown}{End}{Enter}");
  expect(editor).toHaveTextContent("Consolas");
  expect(editor).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  for (const control of [
    ...screen.getAllByRole("combobox"),
    ...screen.getAllByRole("switch"),
    ...screen.getAllByRole("spinbutton"),
  ])
    expect(control).toBeDisabled();
  await act(async () => finish());
});

it("configures day and night independently and resets every category", async () => {
  const user = userEvent.setup();
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<SettingsDialog settings={settings} onSave={onSave} onClose={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Catppuccin Latte" }));
  await user.click(screen.getByRole("button", { name: "Nord Polar Night" }));
  await user.click(category("终端"));
  await user.click(screen.getByRole("combobox", { name: "光标样式" }));
  await user.click(screen.getByRole("option", { name: "下划线" }));
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  expect(onSave).toHaveBeenCalledWith(
    {
      ...settings,
      colorSchemes: { light: "catppuccin", dark: "nord" },
      preferences: { ...DEFAULT_PREFERENCES, terminalCursorStyle: "underline" },
    },
    expect.any(Object),
  );
  await user.click(screen.getByRole("button", { name: "恢复默认" }));
  expect(screen.getByRole("combobox", { name: "光标样式" })).toHaveTextContent("方块");
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  expect(onSave).toHaveBeenLastCalledWith(settings, DEFAULT_LAYOUT);
});

it("validates hidden category values and gives an empty search state", async () => {
  const user = userEvent.setup();
  const onSave = vi.fn();
  render(<SettingsDialog settings={settings} onSave={onSave} onClose={vi.fn()} />);
  await user.click(category("终端"));
  await user.clear(screen.getByRole("spinbutton", { name: "终端字号" }));
  await user.type(screen.getByRole("spinbutton", { name: "终端字号" }), "999");
  await user.click(category("外观"));
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  expect(screen.getByRole("alert")).toHaveTextContent("终端字号");
  expect(onSave).not.toHaveBeenCalled();
  await user.type(screen.getByRole("searchbox"), "unknown-setting");
  expect(screen.getByText(/没有匹配的设置/)).toBeInTheDocument();
});
