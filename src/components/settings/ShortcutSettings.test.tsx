import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { resolveShortcuts } from "../../lib/shortcuts";
import { DEFAULT_PREFERENCES, type Preferences } from "../../lib/settings/preferences";
import { DEFAULT_FONT_SETTINGS } from "../../lib/settings/fonts";
import { DEFAULT_COLOR_SCHEMES } from "../../lib/settings/colorSchemes";
import { SettingsDialog } from "./SettingsDialog";

afterEach(() => vi.restoreAllMocks());

function renderDialog(preferences: Partial<Preferences> = {}, isMac = true) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <SettingsDialog
      isMac={isMac}
      settings={{
        language: "zh-CN",
        theme: "system",
        fonts: DEFAULT_FONT_SETTINGS,
        colorSchemes: DEFAULT_COLOR_SCHEMES,
        preferences: { ...DEFAULT_PREFERENCES, ...preferences },
      }}
      onSave={onSave}
      onClose={vi.fn()}
    />,
  );
  return onSave;
}

async function openShortcuts(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    within(screen.getByRole("navigation", { name: "设置分类" })).getByRole("button", {
      name: "快捷键",
    }),
  );
  return screen.getByRole("region", { name: "快捷键" });
}

const key = (section: HTMLElement, name: string) =>
  within(section).getByRole("button", { name }) as HTMLButtonElement;

it("lists every command with its configured key and records a new combination", async () => {
  const user = userEvent.setup();
  const onSave = renderDialog();
  const section = await openShortcuts(user);
  const bindings = resolveShortcuts({});
  const keys = section.querySelectorAll(".shortcut-key");
  expect(keys).toHaveLength(Object.keys(bindings).length);
  expect(key(section, "打开设置")).toHaveTextContent("⌘,");
  expect(key(section, "保存")).toHaveTextContent("⌘S");
  expect(key(section, "跳转到定义")).toHaveTextContent("⌘B");
  expect(key(section, "复制文件")).toHaveTextContent("⌘C");
  expect(key(section, "终端")).toHaveTextContent("⌃`");
  expect(bindings.save).toBe("Mod+KeyS");

  const save = key(section, "保存");
  await user.click(save);
  expect(save).toHaveTextContent("请按下新的快捷键…");
  await user.keyboard("{Shift>}{Meta>}{S}/");
  await user.keyboard("{/S}{/Meta}{/Shift}");
  expect(save).toHaveTextContent("⇧⌘S");

  // A lone key or only modifiers is not a shortcut.
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  expect(onSave.mock.calls[0]![0].preferences.shortcuts).toEqual({ save: "Mod+Shift+KeyS" });
});

it("rejects typing keys, lets Backspace clear a key and Escape cancel", async () => {
  const user = userEvent.setup();
  const onSave = renderDialog();
  const section = await openShortcuts(user);
  const find = key(section, "文件内查找");
  await user.click(find);
  await user.keyboard("{a}");
  expect(within(section).getByRole("alert")).toHaveTextContent("请搭配 ⌘、⌥、⌃，或使用功能键。");
  expect(find).toHaveTextContent("请按下新的快捷键…");
  await user.keyboard("{Shift>}{A}{/Shift}");
  expect(within(section).getByRole("alert")).toHaveTextContent("请搭配 ⌘、⌥、⌃，或使用功能键。");
  expect(find).toHaveTextContent("请按下新的快捷键…");
  await user.keyboard("{Escape}");
  expect(find).toHaveTextContent("⌘F");
  expect(within(section).queryByRole("alert")).toBeNull();

  await user.click(find);
  await user.keyboard("{Backspace}");
  expect(find).toHaveTextContent("未设置");
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  expect(onSave.mock.calls[0]![0].preferences.shortcuts).toEqual({ find: "" });
});

it("marks shared keys and refuses to save until they are resolved", async () => {
  const user = userEvent.setup();
  const onSave = renderDialog();
  const section = await openShortcuts(user);
  const save = key(section, "保存");
  await user.click(save);
  await user.keyboard("{Meta>}{B}{/Meta}");
  expect(save).toHaveTextContent("⌘B");
  const alerts = within(section).getAllByRole("alert");
  expect(alerts).toHaveLength(2);
  expect(alerts.map((alert) => alert.textContent)).toEqual(["与 跳转到定义 冲突", "与 保存 冲突"]);

  await user.click(screen.getByRole("button", { name: "保存设置" }));
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByText("快捷键冲突：“保存”和“跳转到定义”都使用了 ⌘B。")).toHaveAttribute(
    "role",
    "alert",
  );
});

it("restores the defaults for all commands at once", async () => {
  const user = userEvent.setup();
  const onSave = renderDialog({ shortcuts: { save: "F8", git: "" } });
  const section = await openShortcuts(user);
  expect(key(section, "保存")).toHaveTextContent("F8");
  expect(key(section, "Git 管理")).toHaveTextContent("未设置");
  await user.click(screen.getByRole("button", { name: "恢复默认快捷键" }));
  expect(key(section, "保存")).toHaveTextContent("⌘S");
  expect(key(section, "Git 管理")).toHaveTextContent("⌘9");
  await user.click(screen.getByRole("button", { name: "保存设置" }));
  expect(onSave.mock.calls[0]![0].preferences.shortcuts).toEqual({});
});
