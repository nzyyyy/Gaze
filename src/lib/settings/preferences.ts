import { t } from "../i18n";
import {
  BUILTIN_PLUGINS,
  type BuiltinPluginCategory,
  type BuiltinPluginKey,
} from "../../plugins/builtins";
import type { ColorSchemes } from "./colorSchemes";
import type { FontSettings } from "./fonts";
import type { ThemePreference } from "../types";
import type { AiCompletionConfig } from "../../plugins/ai-completion-config";
import type { ShortcutOverrides } from "../shortcuts";

export interface Preferences extends Record<BuiltinPluginKey, boolean> {
  editorFontSize: number;
  editorLineHeight: number;
  tabSize: number;
  wordWrap: boolean;
  lineNumbers: boolean;
  showIndentGuides: boolean;
  showStickyScroll: boolean;
  highlightActiveLine: boolean;
  codeFolding: boolean;
  matchBrackets: boolean;
  indentWithTab: boolean;
  autoImportEnabled: boolean;
  quickDocumentationOnHover: boolean;
  autoParameterInfo: boolean;
  autoSave: boolean;
  autoSaveDelay: number;
  searchCaseSensitive: boolean;
  searchRegex: boolean;
  searchHidden: boolean;
  searchIgnored: boolean;
  terminalFontSize: number;
  terminalLineHeight: number;
  terminalScrollback: number;
  terminalCursorBlink: boolean;
  showStatusBar: boolean;
  showLanguage: boolean;
  showEncoding: boolean;
  showLineCount: boolean;
  showTerminalButton: boolean;
  windowGlassEnabled: boolean;
  windowSurfaceOpacity: number;
  terminalCursorStyle: "block" | "underline" | "bar";
  aiCompletion: AiCompletionConfig;
  shortcuts: ShortcutOverrides;
}

export interface AppSettings {
  language: import("../i18n").Language;
  theme: ThemePreference;
  fonts: FontSettings;
  colorSchemes: ColorSchemes;
  preferences: Preferences;
}

export const DEFAULT_PREFERENCES: Preferences = {
  editorFontSize: 13.5,
  editorLineHeight: 1.65,
  tabSize: 4,
  wordWrap: true,
  lineNumbers: true,
  showIndentGuides: true,
  showStickyScroll: true,
  showMinimap: true,
  highlightActiveLine: true,
  codeFolding: true,
  matchBrackets: true,
  indentWithTab: true,
  autoImportEnabled: false,
  quickDocumentationOnHover: false,
  autoParameterInfo: true,
  autoSave: true,
  autoSaveDelay: 800,
  searchCaseSensitive: false,
  searchRegex: false,
  searchHidden: false,
  searchIgnored: false,
  terminalFontSize: 13,
  terminalLineHeight: 1,
  terminalScrollback: 5000,
  terminalCursorBlink: true,
  showStatusBar: true,
  showLanguage: true,
  showEncoding: true,
  showLineCount: true,
  showTerminalButton: true,
  windowGlassEnabled: true,
  windowSurfaceOpacity: 0.8,
  terminalCursorStyle: "block",
  mermaidEnabled: true,
  markdownInsertEnabled: true,
  markdownMathEnabled: true,
  pathCompletionEnabled: true,
  pythonEnabled: true,
  typescriptEnabled: true,
  aiCompletionEnabled: false,
  aiCompletion: { protocol: "responses", url: "", model: "", apiKey: "" },
  shortcuts: {},
};

export const SETTINGS_CATEGORIES = [
  { id: "appearance", label: "外观" },
  { id: "editor", label: "编辑器" },
  { id: "files", label: "文件与保存" },
  { id: "search", label: "搜索" },
  { id: "terminal", label: "终端" },
  { id: "layout", label: "窗口与布局" },
  { id: "keymap", label: "快捷键" },
  { id: "plugins", label: "插件" },
] as const;
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number]["id"];

type KeysOfType<T> = {
  [K in keyof Preferences]: Preferences[K] extends T ? K : never;
}[keyof Preferences];
interface FieldInfo {
  category: SettingsCategory;
  label: string;
  description: string;
  pluginCategory?: BuiltinPluginCategory;
}
export type PreferenceField = FieldInfo &
  (
    | { key: KeysOfType<number>; type: "number" | "range"; min: number; max: number; step: number }
    | { key: KeysOfType<boolean>; type: "boolean" }
  );

export const PREFERENCE_FIELDS: PreferenceField[] = [
  {
    key: "windowGlassEnabled",
    type: "boolean",
    category: "appearance",
    label: "浮层玻璃效果",
    description: "为 Quick Open、设置、菜单、Hover 和通知添加局部模糊背景；仅 macOS 可用。",
  },
  {
    key: "windowSurfaceOpacity",
    type: "range",
    category: "appearance",
    label: "浮层背景不透明度",
    description: "数值越低，浮层背后的模糊内容越明显；文字和控件保持清晰。范围 50%–100%。",
    min: 0.5,
    max: 1,
    step: 0.05,
  },
  {
    key: "editorFontSize",
    type: "number",
    category: "editor",
    label: "编辑器字号",
    description: "代码文字大小，单位 px。",
    min: 10,
    max: 32,
    step: 0.5,
  },
  {
    key: "editorLineHeight",
    type: "number",
    category: "editor",
    label: "编辑器行高",
    description: "相对于字号的倍数。",
    min: 1.2,
    max: 2.4,
    step: 0.05,
  },
  {
    key: "tabSize",
    type: "number",
    category: "editor",
    label: "缩进宽度",
    description: "Tab 显示宽度及新文件的缩进宽度；已有文件优先沿用原缩进。",
    min: 1,
    max: 8,
    step: 1,
  },
  {
    key: "wordWrap",
    type: "boolean",
    category: "editor",
    label: "自动换行",
    description: "长行在编辑区边缘折行，大文件仍保持纯文本保护。",
  },
  {
    key: "lineNumbers",
    type: "boolean",
    category: "editor",
    label: "显示行号",
    description: "在编辑器左侧显示行号。",
  },
  {
    key: "showIndentGuides",
    type: "boolean",
    category: "editor",
    label: "显示缩进参考线",
    description: "用竖线标记代码的缩进层级。",
  },
  {
    key: "highlightActiveLine",
    type: "boolean",
    category: "editor",
    label: "高亮当前行",
    description: "突出显示光标所在的行。",
  },
  {
    key: "codeFolding",
    type: "boolean",
    category: "editor",
    label: "代码折叠",
    description: "显示代码折叠按钮。",
  },
  {
    key: "matchBrackets",
    type: "boolean",
    category: "editor",
    label: "括号匹配",
    description: "高亮成对的括号。",
  },
  {
    key: "indentWithTab",
    type: "boolean",
    category: "editor",
    label: "Tab 键缩进",
    description: "按 Tab 键缩进代码；关闭后可用 Tab 移动焦点。",
  },
  {
    key: "showStickyScroll",
    type: "boolean",
    category: "editor",
    label: "代码标题吸顶",
    description: "滚动时固定当前代码块的标题。",
  },
  {
    key: "quickDocumentationOnHover",
    type: "boolean",
    category: "editor",
    label: "悬停显示快速文档",
    description: "鼠标停在符号上时显示说明。也可以按 {0} 查看文档。",
  },
  {
    key: "autoParameterInfo",
    type: "boolean",
    category: "editor",
    label: "自动显示参数提示",
    description: "进入函数调用后约 1 秒显示。也可以按 {0} 查看。",
  },
  {
    key: "autoImportEnabled",
    type: "boolean",
    category: "editor",
    label: "自动导入",
    description: "遇到未解析的符号时，若语言服务器提供唯一的导入修复，自动应用。",
  },
  {
    key: "autoSave",
    type: "boolean",
    category: "files",
    label: "自动保存",
    description: "编辑停顿或窗口失焦时保存。关闭后需手动保存，关闭文件或退出前仍会尝试保存。",
  },
  {
    key: "autoSaveDelay",
    type: "number",
    category: "files",
    label: "自动保存延迟",
    description: "停止输入后等待的毫秒数；连续保存仍保留最短间隔保护。",
    min: 200,
    max: 10000,
    step: 100,
  },
  {
    key: "searchCaseSensitive",
    type: "boolean",
    category: "search",
    label: "默认区分大小写",
    description: "搜索面板仍可临时切换。",
  },
  {
    key: "searchRegex",
    type: "boolean",
    category: "search",
    label: "默认使用正则表达式",
    description: "将新搜索作为正则表达式处理。",
  },
  {
    key: "searchHidden",
    type: "boolean",
    category: "search",
    label: "默认包含隐藏文件",
    description: "搜索点号开头的文件和目录。",
  },
  {
    key: "searchIgnored",
    type: "boolean",
    category: "search",
    label: "默认包含忽略文件",
    description: "搜索被 .gitignore 忽略的文件。",
  },
  {
    key: "terminalFontSize",
    type: "number",
    category: "terminal",
    label: "终端字号",
    description: "终端文字大小，单位 px。",
    min: 10,
    max: 32,
    step: 1,
  },
  {
    key: "terminalLineHeight",
    type: "number",
    category: "terminal",
    label: "终端行高",
    description: "相对于字号的倍数。",
    min: 1,
    max: 2,
    step: 0.1,
  },
  {
    key: "terminalScrollback",
    type: "number",
    category: "terminal",
    label: "终端回滚行数",
    description: "保留的历史输出行数，较大的值会占用更多内存。",
    min: 100,
    max: 100000,
    step: 100,
  },
  {
    key: "terminalCursorBlink",
    type: "boolean",
    category: "terminal",
    label: "光标闪烁",
    description: "让终端光标周期性闪烁。",
  },
  {
    key: "showStatusBar",
    type: "boolean",
    category: "layout",
    label: "显示状态栏",
    description: "显示窗口底部的文件信息与保存状态。",
  },
  {
    key: "showLanguage",
    type: "boolean",
    category: "layout",
    label: "显示文件语言",
    description: "在状态栏显示当前文件语言。",
  },
  {
    key: "showEncoding",
    type: "boolean",
    category: "layout",
    label: "显示文件编码",
    description: "在状态栏显示当前文件编码。",
  },
  {
    key: "showLineCount",
    type: "boolean",
    category: "layout",
    label: "显示文件行数",
    description: "在状态栏显示总行数。",
  },
  {
    key: "showTerminalButton",
    type: "boolean",
    category: "layout",
    label: "显示终端按钮",
    description: "在状态栏显示终端入口；快捷键仍可使用。",
  },
  ...BUILTIN_PLUGINS.map<PreferenceField>((plugin) => ({
    ...plugin,
    type: "boolean",
    category: "plugins",
  })),
];

export function preferencesError(preferences: Preferences): string | null {
  for (const field of PREFERENCE_FIELDS) {
    if (field.type === "boolean") continue;
    const value = preferences[field.key];
    const steps = (value - field.min) / field.step;
    if (
      !Number.isFinite(value) ||
      value < field.min ||
      value > field.max ||
      Math.abs(steps - Math.round(steps)) > 0.00001
    ) {
      return t(
        "{0}：请输入 {1}–{2} 之间、步长为 {3} 的数值。",
        t(field.label),
        field.min,
        field.max,
        field.step,
      );
    }
  }
  return null;
}
