# Gaze 示例项目

这是一个完全原创的小型 TypeScript 工作区，用于验证：

- TypeScript/TSX 语法高亮；
- LSP 定义、引用、实现和文档符号；
- ctags 文件大纲和多定义候选；
- `.gitignore` 排除和包含忽略文件的搜索；
- 中文文件名、中文标识符和 emoji 前后的 UTF-16 位置。

```ts
const square = new Square(3);
console.log(square.area());
```

在全局搜索中搜索 `totalArea` 或 `inspect`，然后在 `src/中文示例.ts` 或
`src/usage.ts` 中将光标放到符号上，按 F12。
