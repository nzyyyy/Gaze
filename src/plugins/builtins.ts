export const BUILTIN_PLUGIN_CATEGORIES = {
  markdown: "Markdown",
  languages: "语言支持",
  tools: "开发工具",
  editor: "编辑器",
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
    key: "typescriptEnabled",
    pluginCategory: "languages",
    label: "JavaScript / TypeScript 语义支持",
    description: "启用 JavaScript、TypeScript、JSX 和 TSX 的语义补全、诊断和导航。",
  },
  {
    key: "showMinimap",
    pluginCategory: "editor",
    label: "内容缩略图",
    description: "在右侧显示语法配色缩略图，支持点击、拖动定位和悬停代码预览。",
  },
  {
    key: "aiCompletionEnabled",
    pluginCategory: "tools",
    label: "AI 行内补全",
    description: "在 LSP 候选旁显示 AI 灰字。Tab 采纳 AI 建议，Enter 采纳列表候选。",
  },
] as const;

export type BuiltinPluginKey = (typeof BUILTIN_PLUGINS)[number]["key"];
