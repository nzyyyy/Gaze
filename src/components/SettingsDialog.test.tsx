import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { DEFAULT_FONT_SETTINGS } from "../lib/fonts";
import { DEFAULT_COLOR_SCHEMES } from "../lib/colorSchemes";
import { DEFAULT_PREFERENCES, type AppSettings } from "../lib/preferences";
import { DEFAULT_LAYOUT } from "../lib/layout";
import { SettingsDialog } from "./SettingsDialog";

const settings: AppSettings = {
  language: "zh-CN",
  theme: "system",
  fonts: DEFAULT_FONT_SETTINGS,
  colorSchemes: DEFAULT_COLOR_SCHEMES,
  preferences: DEFAULT_PREFERENCES,
};
function category(name: string) {
  return within(screen.getByRole("navigation", { name: "设置分类" })).getByRole("button", { name });
}

it("focuses the heading on open and keeps the close button reachable with Tab", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<SettingsDialog settings={settings} onSave={vi.fn()} onClose={onClose} />);
  expect(screen.getByRole("heading", { name: "设置" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "关闭设置" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onClose).toHaveBeenCalledOnce();
});

it("filters plugins by category and keeps pending switches available in global search", async () => {
  const user = userEvent.setup();
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<SettingsDialog settings={settings} onSave={onSave} onClose={vi.fn()} />);
  await user.click(category("插件"));
  const filters = within(screen.getByRole("group", { name: "插件分类" }));
  expect(filters.getByRole("button", { name: "全部", pressed: true })).toBeInTheDocument();
  expect(screen.getAllByRole("switch")).toHaveLength(7);

  const markdown = filters.getByRole("button", { name: "Markdown" });
  markdown.focus();
  await user.keyboard("{Enter}");
  expect(markdown).toHaveAttribute("aria-pressed", "true");
  for (const name of ["Mermaid", "Markdown 快捷插入", "KaTeX 数学公式"]) {
    expect(screen.getByRole("switch", { name })).toBeInTheDocument();
  }
  expect(screen.getAllByRole("switch")).toHaveLength(3);

  await user.click(filters.getByRole("button", { name: "语言支持" }));
  expect(screen.getByRole("switch", { name: "Python 语义支持" })).toBeInTheDocument();
  expect(screen.getAllByRole("switch")).toHaveLength(1);

  await user.click(filters.getByRole("button", { name: "开发工具" }));
  expect(screen.getByRole("switch", { name: "集成终端" })).toBeInTheDocument();
  await user.click(screen.getByRole("switch", { name: "Git 集成" }));
  await user.click(markdown);
  expect(screen.queryByRole("switch", { name: "Git 集成" })).not.toBeInTheDocument();
  expect(onSave).not.toHaveBeenCalled();
  await user.type(screen.getByRole("searchbox", { name: "搜索设置" }), "开发工具");
  expect(screen.getByRole("switch", { name: "Git 集成" })).not.toBeChecked();
  expect(screen.getByRole("switch", { name: "集成终端" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ preferences: { ...DEFAULT_PREFERENCES, gitEnabled: false } }),
    expect.any(Object),
  );
});

it("keeps AI configuration on a detail page and saves its draft after returning", async () => {
  const user = userEvent.setup();
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<SettingsDialog settings={settings} onSave={onSave} onClose={vi.fn()} />);
  await user.click(category("插件"));
  await user.click(screen.getByRole("button", { name: "开发工具" }));
  expect(screen.getByRole("switch", { name: "AI 行内补全" })).not.toBeChecked();
  expect(screen.queryByLabelText("Base URL")).not.toBeInTheDocument();
  const openDetail = () => screen.getByRole("button", { name: "配置 AI 行内补全" });
  openDetail().focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("heading", { name: "AI 行内补全" })).toHaveFocus();
  expect(screen.queryByRole("switch", { name: "Git 集成" })).not.toBeInTheDocument();
  const endpoint = "https://model.example";
  await user.type(screen.getByLabelText("Base URL"), endpoint);
  await user.type(screen.getByLabelText("模型 ID"), "test-model");
  await user.type(screen.getByLabelText("API Key", { exact: true }), "test-key");
  await user.click(screen.getByRole("button", { name: "返回插件列表" }));
  expect(screen.getByRole("button", { name: "开发工具", pressed: true })).toBeInTheDocument();
  expect(openDetail()).toHaveFocus();
  expect(screen.queryByLabelText("Base URL")).not.toBeInTheDocument();
  expect(onSave).not.toHaveBeenCalled();
  await user.click(openDetail());
  expect(screen.getByLabelText("Base URL")).toHaveValue(endpoint);
  expect(screen.getByLabelText("模型 ID")).toHaveValue("test-model");
  expect(screen.getByLabelText("API Key", { exact: true })).toHaveValue("test-key");
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      preferences: {
        ...DEFAULT_PREFERENCES,
        aiCompletionEnabled: true,
        aiCompletion: {
          protocol: "responses",
          url: endpoint,
          model: "test-model",
          apiKey: "test-key",
        },
      },
    }),
    expect.any(Object),
  );
});

it("finds the AI plugin by its detail fields and restores search results on back", async () => {
  const user = userEvent.setup();
  render(<SettingsDialog settings={settings} onSave={vi.fn()} onClose={vi.fn()} />);
  const search = screen.getByRole("searchbox", { name: "搜索设置" });
  await user.type(search, "Base URL");
  expect(screen.queryByLabelText("Base URL")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "配置 AI 行内补全" }));
  expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "返回插件列表" }));
  expect(search).toHaveValue("Base URL");
  expect(screen.getByRole("button", { name: "配置 AI 行内补全" })).toHaveFocus();
});

it("selects Codex by default and finds and saves both palettes", async () => {
  const user = userEvent.setup();
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<SettingsDialog settings={settings} onSave={onSave} onClose={vi.fn()} />);
  await user.type(screen.getByRole("searchbox", { name: "搜索设置" }), "Codex");
  for (const name of ["Codex Light", "Codex Dark"]) {
    expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
  }
  await user.click(screen.getByRole("button", { name: "GitHub Light" }));
  await user.click(screen.getByRole("button", { name: "Codex Light" }));
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ colorSchemes: { light: "codex", dark: "codex" } }),
    expect.any(Object),
  );
});

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

it("saves appearance settings despite fractional or out-of-range stored panel sizes", async () => {
  const user = userEvent.setup();
  const onSave = vi.fn().mockResolvedValue(undefined);
  localStorage.setItem(
    "gaze:layout",
    JSON.stringify({ sidebarWidth: 199.5, terminalHeight: 240.5, outputHeight: 1001 }),
  );
  try {
    render(<SettingsDialog settings={settings} onSave={onSave} onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "保存设置" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onSave).toHaveBeenCalledWith(settings, {
      ...DEFAULT_LAYOUT,
      sidebarWidth: 200,
      terminalHeight: 241,
      outputHeight: 1000,
    });
  } finally {
    localStorage.removeItem("gaze:layout");
  }
});

it("identifies an invalid panel size even after switching categories", async () => {
  const user = userEvent.setup();
  const onSave = vi.fn();
  render(<SettingsDialog settings={settings} onSave={onSave} onClose={vi.fn()} />);
  await user.click(category("窗口与布局"));
  fireEvent.change(screen.getByRole("spinbutton", { name: "终端面板高度" }), {
    target: { value: "240.5" },
  });
  await user.click(category("外观"));
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  expect(screen.getByRole("alert")).toHaveTextContent("终端面板高度：请输入 120–1000 之间的整数。");
  expect(onSave).not.toHaveBeenCalled();
});

it("configures glass opacity on macOS and restores its defaults", async () => {
  const user = userEvent.setup();
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<SettingsDialog settings={settings} isMac onSave={onSave} onClose={vi.fn()} />);
  const toggle = screen.getByRole("switch", { name: "浮层玻璃效果" });
  const slider = screen.getByRole("slider", { name: "浮层背景不透明度" });
  expect(toggle).toBeChecked();
  expect(slider).toBeEnabled();
  expect(slider).toHaveValue("0.8");
  await user.click(toggle);
  expect(slider).toBeDisabled();
  await user.click(toggle);
  expect(slider).toBeEnabled();
  fireEvent.change(slider, { target: { value: "0.65" } });
  expect(slider).toHaveValue("0.65");
  expect(screen.getByText("65%")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      preferences: expect.objectContaining({
        windowGlassEnabled: true,
        windowSurfaceOpacity: 0.65,
      }),
    }),
    expect.any(Object),
  );
  await user.click(screen.getByRole("button", { name: "恢复默认" }));
  expect(toggle).toBeChecked();
  expect(slider).toHaveValue("0.8");
  expect(slider).toBeEnabled();
});

it("disables glass controls outside macOS", () => {
  render(<SettingsDialog settings={settings} onSave={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole("switch", { name: "浮层玻璃效果" })).toBeDisabled();
  expect(screen.getByRole("slider", { name: "浮层背景不透明度" })).toBeDisabled();
});

it("saves the selected language and searches translated settings", async () => {
  const { setLanguage } = await import("../lib/i18n");
  const user = userEvent.setup();
  const onSave = vi.fn().mockResolvedValue(undefined);
  const view = render(<SettingsDialog settings={settings} onSave={onSave} onClose={vi.fn()} />);
  await user.click(screen.getByRole("combobox", { name: "语言" }));
  await user.click(screen.getByRole("option", { name: "English" }));
  expect(screen.getByRole("heading", { name: "设置" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ language: "en" }),
    expect.any(Object),
  );
  act(() => setLanguage("en"));
  try {
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Editor" })).toBeInTheDocument();
    expect(screen.getByText("Project files Search workspace Settings Gaze")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Editor" }));
    expect(screen.getByText(/\/\/ Comment · 0O 1lI/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.getByText(/~\/projects\/gaze/)).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search settings" }), "font size");
    expect(screen.getByRole("spinbutton", { name: "Editor font size" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Terminal font size" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Plugins" }));
    const filters = within(screen.getByRole("group", { name: "Plugin categories" }));
    expect(filters.getByRole("button", { name: "Language support" })).toBeInTheDocument();
    expect(filters.getByRole("button", { name: "Developer tools" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Mermaid" })).toHaveAccessibleDescription(
      "Render Mermaid diagrams in Markdown previews",
    );
  } finally {
    view.unmount();
    act(() => setLanguage("zh-CN"));
  }
});
