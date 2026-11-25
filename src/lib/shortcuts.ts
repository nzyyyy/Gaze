import { keymap, type EditorView, type KeyBinding } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { t } from "./i18n";

/**
 * A shortcut is stored as `Mod+…+Key`, where `Mod` is ⌘ and `Ctrl` is ⌃, which
 * are separate keys on macOS. Gaze only ships the macOS keymap.
 */
export type ShortcutGroup = "global" | "files" | "editor";
export type NavigationTarget = "back" | "forward" | "definition" | "references" | "implementation";

export interface ShortcutCommand {
  id: string;
  group: ShortcutGroup;
  label: string;
  key: string | null;
}

/** Customised keys only; `""` removes the shortcut of that command. */
export type ShortcutOverrides = Record<string, string>;
/** Resolved key per command; `null` means unbound. */
export type ShortcutBindings = Record<string, string | null | undefined>;

export const SHORTCUT_GROUPS: { id: ShortcutGroup; label: string }[] = [
  { id: "global", label: "全局" },
  { id: "files", label: "文件操作" },
  { id: "editor", label: "编辑器" },
];

// Defaults follow the IntelliJ IDEA macOS keymap; file operations keep ⌘C/⌘V.
// The terminal stays on ⌃` because macOS reserves ⌘` for window cycling.
export const SHORTCUT_COMMANDS = [
  { id: "settings", group: "global", label: "打开设置", key: "Mod+Comma" },
  { id: "open-file", group: "global", label: "打开文件…", key: "Mod+KeyO" },
  {
    id: "import-project",
    group: "global",
    label: "导入项目目录…",
    key: "Mod+Alt+KeyO",
  },
  {
    id: "quick-open",
    group: "global",
    label: "快速打开",
    key: "Mod+Shift+KeyO",
  },
  { id: "save", group: "global", label: "保存", key: "Mod+KeyS" },
  { id: "close-tab", group: "global", label: "关闭标签页", key: "Mod+KeyW" },
  { id: "quit", group: "global", label: "退出 Gaze", key: "Mod+KeyQ" },
  { id: "find", group: "global", label: "文件内查找", key: "Mod+KeyF" },
  {
    id: "search-workspace",
    group: "global",
    label: "工作区搜索",
    key: "Mod+Shift+KeyF",
  },
  { id: "git", group: "global", label: "Git 管理", key: "Mod+Digit9" },
  { id: "sidebar-files", group: "global", label: "文件侧栏", key: "Mod+Digit1" },
  { id: "sidebar-search", group: "global", label: "搜索侧栏", key: "Mod+Digit3" },
  { id: "sidebar-symbols", group: "global", label: "符号与大纲", key: "Mod+Digit7" },
  {
    id: "toggle-split",
    group: "global",
    label: "切换右侧编辑区",
    key: "Mod+Backslash",
  },
  { id: "terminal", group: "global", label: "终端", key: "Ctrl+Backquote" },
  { id: "back", group: "global", label: "后退", key: "Mod+BracketLeft" },
  { id: "forward", group: "global", label: "前进", key: "Mod+BracketRight" },
  // ⌘B stays in the editor keymap so Markdown keeps its bold shortcut.
  { id: "definition", group: "global", label: "跳转到定义", key: "Mod+KeyB" },
  { id: "references", group: "global", label: "查找引用", key: "Alt+F7" },
  {
    id: "implementation",
    group: "global",
    label: "查找实现",
    key: "Mod+Alt+KeyB",
  },
  { id: "copy-file", group: "files", label: "复制文件", key: "Mod+KeyC" },
  { id: "paste-file", group: "files", label: "粘贴文件", key: "Mod+KeyV" },
  { id: "delete-file", group: "files", label: "移到废纸篓", key: "Mod+Backspace" },
  { id: "new-file", group: "files", label: "新建文件", key: "Mod+KeyN" },
  { id: "new-folder", group: "files", label: "新建文件夹", key: "Mod+Shift+KeyN" },
  { id: "rename", group: "files", label: "重命名", key: "Shift+F6" },
  { id: "quick-fix", group: "editor", label: "快速修复", key: "Alt+Enter" },
  { id: "format-code", group: "editor", label: "格式化代码", key: "Mod+Alt+KeyL" },
  { id: "organize-imports", group: "editor", label: "整理导入", key: "Mod+Ctrl+Alt+KeyO" },
  { id: "parameter-info", group: "editor", label: "参数提示", key: "Mod+KeyP" },
  { id: "quick-documentation", group: "editor", label: "快速文档", key: "F1" },
  { id: "next-problem", group: "editor", label: "下一个问题", key: "F2" },
  { id: "prev-problem", group: "editor", label: "上一个问题", key: "Shift+F2" },
  { id: "extend-selection", group: "editor", label: "扩大选区", key: "Alt+ArrowUp" },
  { id: "shrink-selection", group: "editor", label: "缩小选区", key: "Alt+ArrowDown" },
] as const satisfies readonly ShortcutCommand[];

export type ShortcutCommandId = (typeof SHORTCUT_COMMANDS)[number]["id"];

const MODIFIERS = ["Mod", "Ctrl", "Alt", "Shift"] as const;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const PUNCTUATION = {
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Backslash: "\\",
  Comma: ",",
  Minus: "-",
  Equal: "=",
  Period: ".",
  Semicolon: ";",
  Slash: "/",
  Quote: "'",
} as const;
const NAMED_KEYS = {
  Enter: "Enter",
  Space: "Space",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
} as const;
const MAC_KEYS: Record<string, string> = {
  Backspace: "⌫",
  Delete: "⌦",
  Enter: "⏎",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};
const MAC_MODIFIERS: Record<string, string> = { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };
const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Mod"];
const KEY_NAMES = new Set<string>([
  ...LETTERS.map((letter) => `Key${letter}`),
  ...Array.from({ length: 10 }, (_, digit) => `Digit${digit}`),
  ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
  ...Object.keys(PUNCTUATION),
  ...Object.keys(NAMED_KEYS),
]);
const MODIFIER_CODES = /^(?:Shift|Control|Alt|Meta)(?:Left|Right)?$/;

export function defaultShortcut(id: string): string | null {
  return SHORTCUT_COMMANDS.find((item) => item.id === id)?.key ?? null;
}

/** Returns the canonical form, `null` for an unbound or invalid value. */
export function normalizeShortcut(value: string): string | null {
  const tokens = value
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean);
  const key = tokens[tokens.length - 1];
  if (!key || !KEY_NAMES.has(key)) return null;
  const modifiers = new Set<string>();
  for (const token of tokens.slice(0, -1)) {
    const modifier = (MODIFIERS as readonly string[]).includes(token) ? token : null;
    if (!modifier) return null;
    modifiers.add(modifier);
  }
  const shortcut = [...MODIFIERS.filter((modifier) => modifiers.has(modifier)), key].join("+");
  return shortcutNeedsModifier(shortcut) ? null : shortcut;
}

export function resolveShortcuts(overrides: ShortcutOverrides | undefined): ShortcutBindings {
  const bindings: ShortcutBindings = {};
  for (const command of SHORTCUT_COMMANDS) {
    const override = overrides?.[command.id];
    bindings[command.id] =
      override === undefined ? command.key : (normalizeShortcut(override) ?? null);
  }
  return bindings;
}

type ShortcutEvent = Partial<
  Pick<KeyboardEvent, "code" | "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">
>;

export function shortcutFromEvent(event: ShortcutEvent): string | null {
  const key = event.code || keyName(event.key ?? "");
  if (!key || !KEY_NAMES.has(key)) return null;
  const parts: string[] = [];
  if (event.metaKey) parts.push("Mod");
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

function keyName(key: string) {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^\d$/.test(key)) return `Digit${key}`;
  if (key === " ") return "Space";
  if (key.length !== 1) return key;
  const name = (Object.keys(PUNCTUATION) as (keyof typeof PUNCTUATION)[]).find(
    (name) => PUNCTUATION[name] === key,
  );
  return name ?? key;
}

/** A modifier is required except for function keys. Shift alone must leave text input intact. */
export function shortcutNeedsModifier(shortcut: string): boolean {
  const [modifier, key] = shortcut.split("+");
  if (!key) return !/^F\d{1,2}$/.test(shortcut);
  return (
    modifier === "Shift" &&
    (key === "Space" ||
      /^(?:Key[A-Z]|Digit\d)$/.test(key) ||
      Object.prototype.hasOwnProperty.call(PUNCTUATION, key))
  );
}

export function isModifierKey(event: Pick<KeyboardEvent, "code" | "key">) {
  return MODIFIER_CODES.test(event.code) || /^(?:Shift|Control|Alt|Meta)$/.test(event.key);
}

function symbol(key: string): string | undefined {
  return PUNCTUATION[key as keyof typeof PUNCTUATION];
}

export function shortcutLabel(shortcut: string | null | undefined): string {
  if (!shortcut) return t("未设置");
  const tokens = shortcut.split("+");
  const key = tokens[tokens.length - 1]!;
  const printed = /^Key([A-Z])$/.exec(key)?.[1] ?? /^Digit(\d)$/.exec(key)?.[1] ?? symbol(key);
  return [
    // Apple's order: Control, Option, Shift, Command.
    ...[...tokens.slice(0, -1)]
      .sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b))
      .map((modifier) => MAC_MODIFIERS[modifier as keyof typeof MAC_MODIFIERS] ?? modifier),
    printed ?? MAC_KEYS[key] ?? key,
  ].join("");
}

/**
 * Key binding that matches the exact configured keys. CodeMirror folds Shift
 * into single-character names, which would merge e.g. Ctrl+W and Ctrl+Shift+W.
 */
export function shortcutBinding(
  shortcut: string | null | undefined,
  run: (view: EditorView) => boolean,
  scope?: string,
): KeyBinding | null {
  if (!shortcut) return null;
  return {
    any: (view, event) => (shortcutFromEvent(event) === shortcut ? run(view) : false),
    scope,
  };
}

/** A keymap of the configured keys for the given commands. */
export function shortcutKeymap(
  shortcuts: ShortcutBindings,
  commands: Record<string, (view: EditorView) => boolean>,
  scope?: string,
): Extension {
  return keymap.of(
    Object.keys(commands).flatMap((id) => {
      const bound = shortcutBinding(shortcuts[id], commands[id]!, scope);
      return bound ? [bound] : [];
    }),
  );
}

export function matchShortcut(
  event: ShortcutEvent,
  bindings: ShortcutBindings,
): ShortcutCommandId | null {
  const shortcut = shortcutFromEvent(event);
  if (!shortcut) return null;
  return SHORTCUT_COMMANDS.find(({ id }) => bindings[id] === shortcut)?.id ?? null;
}

/** `[key, ids]` for every key assigned to more than one command. */
export function shortcutConflicts(bindings: ShortcutBindings): [string, string[]][] {
  const owners = new Map<string, string[]>();
  for (const { id } of SHORTCUT_COMMANDS) {
    const shortcut = bindings[id];
    if (!shortcut) continue;
    owners.set(shortcut, [...(owners.get(shortcut) ?? []), id]);
  }
  return [...owners].filter(([, ids]) => ids.length > 1);
}

export function shortcutCommandLabel(id: string): string {
  return t(SHORTCUT_COMMANDS.find((command) => command.id === id)?.label ?? id);
}
