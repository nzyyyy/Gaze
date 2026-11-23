export const BUILTIN_PLUGIN_CATEGORIES = {
  markdown: "Markdown",
  languages: "语言支持",
  tools: "开发工具",
} as const;

export type BuiltinPluginCategory = keyof typeof BUILTIN_PLUGIN_CATEGORIES;

export const BUILTIN_PLUGINS = [
  {
    key: "mermaidEnabled",
    pluginCategory: "markdown",
    label: "Mermaid",
    description: "在 Markdown 预览中渲染 Mermaid 图表",
  },
  {
    key: "markdownInsertEnabled",
    pluginCategory: "markdown",
    label: "Markdown 快捷插入",
    description: "在 Markdown 编辑器中提供斜杠菜单和格式快捷键。",
  },
  {
    key: "markdownMathEnabled",
    pluginCategory: "markdown",
    label: "KaTeX 数学公式",
    description: "在 Markdown 预览中排版数学公式。",
  },
  {
    key: "pythonEnabled",
    pluginCategory: "languages",
    label: "Python 语义支持",
    description: "启用 Python 解释器选择、语义补全、诊断和导航。",
  },
  {
    key: "terminalEnabled",
    pluginCategory: "tools",
    label: "集成终端",
    description: "在 Gaze 中使用终端面板和终端快捷键。",
  },
  {
    key: "gitEnabled",
    pluginCategory: "tools",
    label: "Git 集成",
    description: "启用 Git 工作区、文件树状态和编辑器变更标记。",
  },
] as const;

export type BuiltinPluginKey = (typeof BUILTIN_PLUGINS)[number]["key"];
