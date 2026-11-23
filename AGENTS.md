# Gaze 工作区指南

## 项目与结构

Gaze 是跨平台桌面代码阅读与就地编辑工具，不是完整 IDE。技术栈为 Tauri 2、React 19、TypeScript、CodeMirror 6 和 Rust/Tokio；详细功能、外部工具依赖及限制见 `README.md`。

- `src/App.tsx`：工作区、标签页、分栏及全局操作协调。
- `src/components/`：编辑器、文件树、搜索、Markdown 等 UI；`src/lib/`：IPC 封装、共享类型和前端逻辑；`src/git/`：Git UI；`src/plugins/`：内置插件定义与功能。
- `src-tauri/src/lib.rs`：Tauri 命令、状态和生命周期；`src-tauri/src/git_workspace/`、`lsp/`：Git 与 LSP 后端。
- `fixtures/demo/`：手工验证用示例项目，不要写入真实用户数据或本机配置。

## 常用命令

使用 pnpm（Node.js >= 20.19），依赖锁定在 `pnpm-lock.yaml` 和 `src-tauri/Cargo.lock`。

```bash
pnpm install --frozen-lockfile
pnpm tauri dev                 # 桌面开发；Vite 固定端口 1420
pnpm typecheck
pnpm test                      # Vitest；单文件：pnpm test -- src/lib/utils.test.ts
pnpm format:check              # 仅格式化改动文件时避免全仓写入
pnpm build                     # TypeScript 检查 + 前端构建
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build               # 打包桌面应用
```

按改动范围运行前端和 Rust 检查；仓库没有独立 lint 脚本，Rust 使用 Clippy。部分集成测试需要本机 `rg`、Universal Ctags、Git 或语言服务器。

## 修改边界与约定

- 前端通过 `src/lib/api.ts` 调用 Tauri IPC，共享载荷在 `src/lib/types.ts`；新增或修改命令时同步 Rust 参数/返回模型、前端类型与相关测试。Git 使用各自的前后端模块。
- 保持异步后端边界：文件遍历、索引、SQLite、子进程等不得阻塞 UI；搜索、LSP、终端和文件监听需要处理取消、过期响应及资源清理。
- 文件写入必须保留原子写入、编码/换行/权限和磁盘指纹冲突检查；不得静默覆盖外部修改、跳过失败或自动恢复未保存内容。路径访问须防止穿越和目录符号链接循环。
- Git 操作作用于整个仓库，保存/写锁/快照校验是数据安全约束；提交、推送、分支切换等不得擅自替用户执行。内置插件开关须同时尊重前端入口和对应后端服务的启停。
- TypeScript 开启 strict、未使用检查及 `noUncheckedIndexedAccess`；使用相对导入、双引号和分号，遵循现有 Prettier 配置。沿用现有中文 UI 文案、i18n 和平台快捷键处理，不引入新的设计体系。
- 桌面目标为 Safari 15 兼容的 WebView；macOS 有原生菜单与窗口样式。Windows/Linux 代码路径需保留，但当前完整实机验证以 macOS arm64 为主。
- 不提交本机绝对路径、凭据、`.env` 或用户工作区数据。功能或行为变化时更新 `README.md`；Git 迁移背景见 `docs/git/migration-assessment.md`。

## 工作流程硬性要求

- **不要私自新建 Git 分支**；在用户当前分支工作，只有用户明确要求时才创建或切换分支。
- **打包只构建 app 包，不构建 DMG，也不要挂载 DMG。** macOS 使用 `pnpm tauri build`；`src-tauri/tauri.macos.conf.json` 已将 targets 限定为 `app`，不要改成 `all` 或添加 `dmg`。
