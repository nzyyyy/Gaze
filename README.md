# Gaze

Gaze 是一个精简、跨平台的桌面代码阅读与就地编辑工具。它专注于同时处理多个项目、快速定位文件和符号，不尝试成为完整 IDE。

![Gaze icon](src-tauri/icons/128x128.png)

## 已实现功能

- 多项目工作区：原生目录选择器导入、项目切换/折叠/移除、SQLite 恢复上次工作区。
- 会话恢复：重新启动后恢复打开标签、活动标签、光标/滚动位置和文件树展开状态。
- 崩溃恢复：未落盘缓冲区在应用数据目录独立记录；重新打开文件时可人工选择恢复或放弃，不会自动覆盖磁盘文件。
- 懒加载文件树：只加载用户展开的目录，长列表虚拟化，目录优先排序，按类型显示图标。支持同一项目内多选、批量移动和移到废纸篓；父目录与子项合并处理，先保存全部受影响编辑器，部分失败逐项报告且重试仅处理失败项。
- 代码阅读与编辑：CodeMirror 6、行号、括号匹配、代码折叠、多选、撤销/重做、文件内搜索、标签页。
- 双编辑区：最多两个并排编辑区，标签可移动到另一侧；同一文件始终只有一个编辑器实例，右侧最后一页关闭后自动合并。
- 自动保存：编辑停顿约 800ms 后自动写盘，同一文件写入间隔至少约 1.5s；切换标签、窗口失焦、关闭前会立即刷盘。`Cmd/Ctrl+S` 可随时手动保存。
- 保存安全：原子写入、保留原编码（UTF-8/BOM/UTF-16 LE/BE）与主要换行风格、保留文件权限、保存前检测磁盘冲突、外部修改时暂停自动保存。
- 语法高亮：按文件名/扩展名异步加载 CodeMirror 语言包；未知类型和异常文件回退为纯文本。
- Markdown 预览：支持 GFM、标题锚点和项目内链接；本地图片通过项目范围资源协议加载，远程图片默认阻止并可按项目进行会话内信任，单次预览最多挂载 50 张图片。
- 快速打开：基于 `ignore` 的后台路径索引、SQLite 缓存和 nucleo 模糊匹配，`Cmd/Ctrl+P`。
- 工作区搜索：真实 `rg --json` 流式结果，支持全部/当前项目、包含/排除 glob、大小写、正则、隐藏文件和忽略文件；输入防抖、旧请求取消、分页继续加载和结果虚拟化。
- 安全全局替换：先保存并锁定受影响的打开编辑器，再用同一搜索规则生成最终预览；所有候选文件可查看、勾选，确认或取消后解锁。执行时重新读取并校验文件指纹，复用原子写入、编码与换行保留和磁盘冲突拒绝；不支持/二进制/超限文件逐项报告，不静默跳过。最近一次替换可按原始字节一键撤销，后续发生修改的文件不会被覆盖，部分失败可重试。
- 文件符号：universal-ctags JSON 索引、当前文件大纲、项目符号搜索和多个定义候选。
- 代码补全：输入时自动弹出候选，支持语言包内置补全、当前文件单词和 LSP 语义补全；使用未保存缓冲区，拒绝过期响应及无效编辑。只在可编辑的普通大小文本中启用。
- 悬停说明：鼠标停在代码标识符上约 400ms 后，通过 LSP 显示当前缓冲区对应的类型、函数签名与文档；支持 Markdown 和纯文本，提示内不加载图片或打开链接。需要语言服务器支持 hover，不可用时不显示提示。
- 精确导航：通用 stdio LSP 客户端，内置常用语言配置，支持定义、引用、实现和文档符号；LSP 不可用时定义跳转回退到 ctags，引用不会用文本搜索结果伪造。所有跳转支持会话内后退/前进。
- 文件变更：notify 监听、防抖合并、增量路径索引、符号缓存失效、已打开文件重新载入。
- 集成终端：底部可拖拽面板、按项目隔离的多标签、真实 PTY + xterm.js，可运行交互式程序与 TUI。
- Git 工作区：左侧 Git 入口或 `Cmd/Ctrl+Shift+G` 将文件树切换为 Git 管理列表，主区显示差异和详情，保留文件标签与终端；复用 GitDock 的状态、差异、文件/代码块暂存、提交、Fetch/Pull/Push、分支、历史图、Stash、文件历史/Blame 与三阶段文本冲突处理。
- 文件树 Git 颜色：所有已导入项目无需打开 Git 工作区，即可通过名称颜色识别变更；折叠项目和父目录也汇总内部变更与冲突，切换项目时保留状态。修改为琥珀色、新增为绿色、删除与冲突为红色、重命名为紫色；悬停和辅助技术可查看具体状态及已暂存/部分暂存说明，并跟随 Git 状态刷新。
- 编码与安全：UTF-8/UTF-8 BOM/UTF-16 LE/BE、二进制检测、权限/不存在错误、路径穿越和目录符号链接循环防护。
- 深浅色主题：跟随系统，可切换浅色/深色。
- 字体设置：右上角齿轮或 `Cmd/Ctrl+,` 打开设置，分别选择界面、编辑器和终端字体，预览后保存，重启后恢复。

## 技术栈

- 桌面：Tauri 2
- 后端：Rust + Tokio + rusqlite（bundled SQLite）
- 前端：React 19、TypeScript、Vite
- 编辑器：CodeMirror 6，可编辑并默认自动保存
- 搜索/索引：ripgrep、ignore、nucleo、universal-ctags、notify
- 语义导航：通用 LSP stdio 客户端
- 终端：portable-pty、xterm.js
- 长列表：`@tanstack/react-virtual`
- Git：本机 Git CLI（2.30+）、react-diff-view、refractor；代码来源及 MIT 许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

前端和 cargo 依赖均已锁定在 `pnpm-lock.yaml` 与 `src-tauri/Cargo.lock` 中。

## 环境要求

已验证环境：

- macOS 15.7 arm64
- Rust 1.96.0
- Node.js 24.19.0、pnpm 11.22.0
- Xcode 26.3
- ripgrep 15.2.0
- Universal Ctags 6.2.1
- typescript-language-server 6.0.2、TypeScript 5.9.3

最低版本按工具链要求：

- Rust stable（`rust-version = 1.85`）
- Node.js `>=20.19.0`（Vite 8 要求），推荐最新 LTS
- pnpm 11.x
- 对应平台的 Tauri 系统依赖（macOS Xcode CLT、Windows WebView2/VS Build Tools、Linux WebKitGTK 等，见 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)）

### ripgrep

Gaze 通过 `rg --json` 实现内容搜索。macOS Homebrew：

```bash
brew install ripgrep
```

### Git

Git 管理需要本机 Git 2.30 或更高版本，按 PATH 查找；macOS 也检查 Homebrew 与系统路径。缺少 Git 不影响原有代码阅读、编辑和搜索。自定义路径可在下方配置中的 `tools.git` 设置，重启后生效。

打开左侧 Git 入口，侧栏替换为已导入项目列表，显示项目名、分支及变更状态；有变更的项目以琥珀色边线高亮，新增行数显示绿色 `+`，删除行数显示红色 `−`，冲突使用红色边线。Git 页面隐藏文件标签栏，也不创建 Git 标签；主区直接提供“更改 / 历史 / 分支 / Stash”导航，列表与差异并列显示。点击项目文件入口会恢复原来的文件标签、文件树和编辑位置，各入口互斥高亮。

当前会话中，各项目独立保留 Git 浏览状态及提交草稿，切回时刷新仓库数据并继续查看原来的差异或历史。移除项目或更改其根目录后清除对应视图。

项目卡片的行数按整个仓库相对 HEAD 的整体变更汇总，包含未跟踪文本文件；部分暂存的文件只统计一次，二进制等无法统计的文件用 `*` 标示，悬停可查看说明。项目位于仓库子目录时，Git 工作区明确显示整个仓库的根目录和当前项目的相对位置；提交、分支和同步作用于整个仓库。同一 worktree 的多个项目共用仓库身份与行数统计，linked worktree 分别保存快照并共用 Git 引用写锁。

暂存前保存相关文件；提交只提交已暂存内容，不自动添加未暂存修改或推送。切换分支、拉取、合并、rebase、Stash 应用等操作会等待受影响编辑器保存并暂停自动保存；丢弃仅在确认后重载目标缓冲区。保存失败、快照过期或其他写操作占用仓库时会阻止执行。

Pull 默认只允许 fast-forward；Push 会为新的远程分支设置 upstream。同步计数来自本地远程跟踪引用，不自动 Fetch。停止 Git 进程不代表回滚，合并/rebase 状态继续显示恢复操作。Git 输出仅保留当前会话最近 500 行，不写入应用持久化日志；认证使用系统 Git 的 credential helper/SSH agent，不提供应用内密码输入。

内部冲突编辑器只支持普通三阶段 UTF-8 文本冲突；二进制、特殊冲突和超限差异使用已配置的外部合并/差异工具。裸仓库仅提供只读历史。克隆和初始化暂通过现有终端完成，再导入项目或重新检测。

移植评估及采用方案见 [docs/git/migration-assessment.md](docs/git/migration-assessment.md)，可交互布局草稿保存在 [docs/git/interaction-draft.html](docs/git/interaction-draft.html)。

也可使用发行版包管理器。Gaze 会先读取配置中的 `tools.rg`，再查找 `PATH` 和 `/opt/homebrew/bin/rg`。启动后侧栏搜索会明确显示工具是否可用。

### universal-ctags

Gaze 只接受 Universal Ctags（不是 BSD/Exuberant ctags 的旧行为）。macOS：

```bash
brew install universal-ctags
```

Gaze 会检查 `ctags --version` 是否包含 `Universal Ctags`。没有 ctags 时阅读、快速打开和全局搜索仍然可用，只禁用 ctags 大纲/符号搜索；LSP 仍可独立使用。

### TypeScript 语言服务器

项目开发依赖中包含 `typescript-language-server` 和 `typescript@5.9.3`，用于开发与集成测试。打包后的 Gaze 不捆绑任何语言服务器。对于普通 TypeScript 项目，推荐在项目内安装 TypeScript（大多数项目已有），或全局安装并确保命令在 `PATH` 中：

```bash
npm install -g typescript typescript-language-server
```

Gaze 内置的 TypeScript 配置为：

```text
typescript-language-server --stdio
```

扩展名：`ts`、`tsx`、`js`、`jsx`、`mjs`、`cjs`、`mts`、`cts`。

如果 TypeScript 不在项目依赖中，可以在用户配置的 LSP 项中传入 `initializationOptions.tsserver.path`，指向本机 `typescript/lib/tsserver.js`。

### 多语言代码补全

下表是内置的服务器启动预设。只安装需要的服务器，并将命令加入 Gaze 启动时的 `PATH`，或通过下方 `config.json` 指定绝对路径；安装或修改配置后重启 Gaze。Gaze 不会自动下载服务器，也不将它们打进安装包。服务器在第一次补全或导航时按项目启动，没有服务器时仍有文件内单词补全及语言包提供的补全。

| 语言                             | 默认命令                                       | 安装包／运行环境                                                |
| -------------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| TypeScript、JavaScript、TSX、JSX | `typescript-language-server --stdio`           | `typescript`、`typescript-language-server`（npm）               |
| Python                           | `pyright-langserver --stdio`                   | `pyright`（npm）及 Python 环境                                  |
| Rust                             | `rust-analyzer`                                | rustup 的 `rust-analyzer` 组件                                  |
| Go                               | `gopls`                                        | `golang.org/x/tools/gopls`（go install）                        |
| C、C++、Objective-C              | `clangd`                                       | LLVM；项目应提供 `compile_commands.json`                        |
| Java                             | `jdtls`                                        | Eclipse JDT Language Server 及其要求的 JDK                      |
| C#                               | `csharp-ls`                                    | 同名 .NET tool 及 .NET SDK                                      |
| PHP                              | `intelephense --stdio`                         | `intelephense`（npm）                                           |
| Ruby                             | `solargraph stdio`                             | `solargraph`（gem）                                             |
| Lua                              | `lua-language-server`                          | Lua Language Server                                             |
| Shell（sh、bash）                | `bash-language-server start`                   | `bash-language-server`（npm）                                   |
| Swift                            | `sourcekit-lsp`                                | Swift 工具链                                                    |
| Kotlin                           | `kotlin-lsp --stdio`                           | JetBrains Kotlin LSP；支持的项目类型取决于版本                  |
| Dart                             | `dart language-server --protocol=lsp`          | Dart／Flutter SDK                                               |
| R                                | `R --vanilla --slave -e languageserver::run()` | R 及 `languageserver` 包                                        |
| SQL                              | `sqls`                                         | `github.com/sqls-server/sqls`（go install）；表名补全需配置连接 |
| HTML                             | `vscode-html-language-server --stdio`          | `vscode-langservers-extracted`（npm）                           |
| CSS、SCSS、Less                  | `vscode-css-language-server --stdio`           | `vscode-langservers-extracted`（npm）                           |
| JSON、JSONC                      | `vscode-json-language-server --stdio`          | `vscode-langservers-extracted`（npm）                           |
| YAML                             | `yaml-language-server --stdio`                 | `yaml-language-server`（npm）                                   |
| Vue                              | `vue-language-server --stdio`                  | `@vue/language-server`（npm），见下方限制                       |
| Svelte                           | `svelteserver --stdio`                         | `svelte-language-server`（npm）                                 |

服务器来源及配置参考：[clangd](https://clangd.llvm.org/installation)、[Kotlin LSP](https://github.com/Kotlin/kotlin-lsp)、[Dart](https://dart.dev/tools)、[R](https://github.com/REditorSupport/languageserver)、[sqls](https://github.com/sqls-server/sqls)、[HTML/CSS/JSON](https://github.com/hrsh7th/vscode-langservers-extracted)、[YAML](https://github.com/redhat-developer/yaml-language-server)、[Vue](https://github.com/vuejs/language-tools/tree/master/packages/language-server)、[Svelte](https://github.com/sveltejs/language-tools/tree/master/packages/language-server)。

输入标识符或常见触发符号（如 `.`）会自动请求候选；`Ctrl+Space` 手动唤起，方向键选择，`Enter`／`Tab` 接受，`Escape` 关闭。macOS 的 `Ctrl+Space` 可能被输入法快捷键占用。

当前 LSP 客户端请求纯文本候选，支持普通替换、InsertReplaceEdit 和随候选直接返回的同文件附加编辑；暂不支持 LSP snippet、`completionItem/resolve` 或接受候选后执行服务器命令，因此依赖这些能力的参数占位和自动 import 可能不可用。候选文档按纯文本展示。Vue 新版服务器的脚本类型能力依赖 `@vue/typescript-plugin` 与自定义 `tsserver/request` 桥接，目前未实现该桥接，Vue 保留本地／模板补全；需要完整脚本补全时可自定义使用支持独立模式的服务器及其初始化选项。不能把预设等同于各语言服务器均已实机验证。

包体只增加通用补全代码和少量配置；高亮包原本已按语言异步加载，新增语言预设不会打包对应工具链。外部服务器和 SDK 会单独占用本机磁盘，已启动的服务器也会占用内存。

## 安装与运行

```bash
pnpm install --frozen-lockfile
pnpm tauri dev
```

前端开发服务器固定使用 `http://localhost:1420`。Tauri 2 CLI 是项目内开发依赖，不需要全局安装 `cargo-tauri`。

## 用户配置

### 字体

右上角的设置页支持系统默认、Maple Mono NF CN 和 Consolas。界面默认使用系统字体，编辑器与终端默认使用内置 Maple Mono NF CN；更改后点击“保存设置”立即生效，不会重建文件编辑器或终端会话。“恢复默认”会重置预览，保存后应用。

Maple 字体随应用离线打包，包含中文、Nerd Font 图标及常规/粗体/斜体/粗斜体四种样式，来源和 OFL 许可证见 `src/assets/fonts/`。Consolas 不随应用分发，需要本机合法安装；字体或字符缺失时回退到 Maple。字体偏好保存在应用 SQLite 数据库中。

### 工具和 LSP

配置文件位于 Tauri 的应用配置目录：

- macOS：`~/Library/Application Support/com.gaze.reader/config.json`
- Windows：`%APPDATA%\com.gaze.reader\config.json`
- Linux：`$XDG_CONFIG_HOME/com.gaze.reader/config.json`

配置文件不存在时使用内置默认值。配置在应用启动时读取，修改后请重启 Gaze。示例（路径均为占位符，不要提交本机路径）：

```json
{
  "tools": {
    "git": "/path/to/git",
    "rg": "/path/to/rg",
    "ctags": "/path/to/ctags"
  },
  "lsp": [
    {
      "id": "rust",
      "languages": ["rust"],
      "extensions": ["rs"],
      "command": "rust-analyzer",
      "args": []
    },
    {
      "id": "typescript",
      "languages": ["typescript", "typescriptreact", "javascript", "javascriptreact"],
      "extensions": ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"],
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "initializationOptions": {
        "tsserver": {
          "path": "/path/to/typescript/lib/tsserver.js"
        }
      }
    }
  ]
}
```

说明：

- 命令直接通过进程参数启动，不经过 shell，也不会自动执行项目脚本。
- `extensions` 决定某个语言服务器负责哪些文件。
- 自定义服务器的 `id` 也会作为未知扩展名的 LSP `languageId`。
- 自定义扩展名映射优先于所有内置语言预设；同名服务器配置会替换该内置预设。
- SQLite 数据库和应用日志写入应用自己的数据目录，不修改被导入项目。

## macOS 菜单栏

macOS 原生应用提供「Gaze、文件、编辑、视图、前往、窗口」菜单，支持打开文件、导入项目、保存、关闭标签页、搜索、代码导航和切换终端。应用内原有入口仍保留。

「文件 → 自动保存」和「视图」中的自动换行、行号、状态栏、主题选项直接保存并生效，勾选状态与设置页同步，重启后恢复。字体、字号、配色和保存延迟等详细选项仍在「Gaze → 设置…」中调整。设置对话框打开或操作繁忙时，相关菜单暂不可用。

关闭标签页和退出前会尝试保存修改；保存失败或冲突时保留文件，提供取消、重试及放弃修改选项。此菜单仅用于 macOS 原生应用，浏览器预览和 Windows/Linux 保留原有操作方式。

## 快捷键

macOS 使用 `Cmd`，Windows/Linux 使用 `Ctrl`。终端开关是例外：所有平台都用 `Ctrl` + 反引号，因为 macOS 的 `Cmd` + 反引号被系统窗口切换占用。

| 快捷键              | 功能                                             |
| ------------------- | ------------------------------------------------ |
| `Cmd/Ctrl+S`        | 立即保存当前文件（自动保存之外的强制刷盘）       |
| `Cmd/Ctrl+P`        | 快速打开文件                                     |
| `Cmd/Ctrl+,`        | 打开设置                                         |
| `Cmd+O`             | 打开文件（macOS 原生应用）                       |
| `Cmd+Shift+O`       | 导入项目目录（macOS 原生应用）                   |
| `Cmd+W`             | 关闭当前标签页（macOS 原生应用）                 |
| `Cmd+Q`             | 保存修改后退出（macOS 原生应用）                 |
| `Cmd/Ctrl+F`        | 当前文件内搜索（CodeMirror 搜索面板）            |
| `Cmd/Ctrl+Shift+F`  | 工作区全局内容搜索                               |
| `Cmd/Ctrl+Shift+G`  | 打开 Git 工作区                                  |
| `Cmd/Ctrl+Alt+←/→`  | 代码导航后退 / 前进                              |
| `Cmd/Ctrl+\`        | 打开或关闭右侧编辑区                             |
| ``Ctrl+` ``         | 打开或关闭底部终端（所有平台）                   |
| `Cmd/Ctrl+单击符号` | 确认目标后高亮，单击跳转定义或完整文件路径       |
| `F12`               | 跳转到定义；LSP 不可用时显示 ctags 定义候选      |
| `Shift+F12`         | 查找引用；需要可用 LSP，绝不使用文本结果伪造引用 |
| `Escape`            | 关闭快速打开/导航候选浮层或清除搜索输入          |

标签页获得焦点时，可用 `←/→` 循环切换、`Home/End` 跳转首尾，`Alt+Shift+←/→` 调整顺序。文件树获得焦点时，可用 `↑/↓` 移动选择、`←/→` 折叠/展开或返回父级/进入子项，`Enter` 打开当前项。 `Cmd/Ctrl+单击` 切换选中，`Shift+单击` 或 `Shift+↑/↓` 连续选择，空格切换当前项，`Cmd/Ctrl+A` 选择当前项目可见文件和目录；`Delete/Backspace` 打开所选项的废纸篓确认框。

符号侧栏提供“查找实现”按钮，对当前光标位置执行 LSP `textDocument/implementation`。

## 示例工作区

导入 [`fixtures/demo`](fixtures/demo) 即可试用。它是小型原创 TypeScript 项目，覆盖：

- 中文文件名 `src/中文示例.ts` 和中文标识符；
- emoji 前后的 UTF-16 位置；
- TypeScript 定义、引用、实现和文档符号；
- 两个同名 `inspect` 函数，用于 ctags 多候选；
- 被 `.gitignore` 排除的 `ignored/secret.ts`，用于验证搜索选项。

不需要在示例目录中安装依赖；如果要在开发版中验证 LSP，项目会从工作区父目录的 Gaze `node_modules` 找到 TypeScript，或按上文配置 `tsserver.path`。

## 验证命令

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build
```

macOS 的 `src-tauri/tauri.macos.conf.json` 将打包目标限制为 `app`，因此构建只生成 `.app`，不会生成或挂载 `.dmg`。

Rust 测试包含：

- 路径穿越、嵌套 `.gitignore`、增量路径索引与 SQLite 缓存；
- 编码/BOM/二进制/CRLF/Unicode 位置；
- 原子写入、UTF-8/BOM/UTF-16 回写、CRLF 恢复、冲突检测、强制覆盖与权限保留；
- 真实 `rg --json` 搜索、`.gitignore`、流式分页继续与取消；
- true Universal Ctags JSON 解析和 TSX 映射；
- 真实 `typescript-language-server` 的初始化、文档符号、定义、引用和实现（未安装服务器时该测试会跳过并打印说明）；
- LSP framing、Content-Length、URI/跨项目根和位置编码转换。
- GitDock 的真实临时仓库回归：状态/历史/拓扑、部分暂存、过期快照拒绝、冲突写入保护、分支/远程操作、带 lease 推送与进程组取消；以及 Gaze 的仓库身份隔离和编辑器/Git 写锁协调。

## 数据与性能策略

- 启动时不会同步扫描项目；先恢复工作区 UI，再后台处理活动项目，其他项目排队。
- 路径索引、ctags、文件读取和 SQLite 访问都在异步命令或阻塞线程中执行。
- 不把源码复制进 SQLite；只保存路径、文件指纹和符号元数据。
- 首版不建立全文索引，内容搜索直接使用 ripgrep。
- 搜索每页 200 条、每批最多 40 条发送到前端；到 5000 条硬上限后停止并明确提示。
- 快速打开最多返回 120 条；项目符号搜索最多 200 条；LSP 引用最多 1000 条。
- 文件读取上限 20 MiB；超过 2 MiB 或存在超过 20,000 个 UTF-16 单元的单行时切换纯文本模式，关闭高亮、折叠和自动换行，并保持只读。
- 读取文件上限之外不做静默截断；错误会显示在阅读区。
- 保存使用同目录临时文件和 `rename` 原子覆盖；保存前比较文件指纹，磁盘被外部修改时不会静默覆盖。
- 自动保存会先恢复原文件的主要换行风格；混合换行文件会统一为其中占多数的一种。
- 目录符号链接不递归展开；指向项目外的文件符号链接会被拒绝。

## 当前限制

- 文件树支持新建文件/文件夹、重命名、项目内移动和移到系统废纸篓；通过右键菜单或行内“…”操作，支持同一项目内多选后批量移动和移到废纸篓。操作前先保存受影响文件，保存失败时阻止操作。
- 不提供跨项目移动、文件树拖拽、另存为、自动格式化、调试、插件市场或 AI 聊天；移动和重命名不会自动修改代码中的 import 路径。
- 分栏最多两个并排编辑区，不支持任意嵌套或拖拽布局；同一文件在任一时刻只有一个编辑器实例。
- 崩溃恢复只恢复未落盘文本，不恢复撤销历史、终端会话或导航后退/前进历史；恢复前必须人工确认。
- 全局替换只处理可正常编辑的文本文件；预览超过 200 个文件或 5000 处匹配时禁止执行，外部修改导致指纹变化时必须重新预览。
- 二进制文件以及超过 20 MiB 的文件不能在编辑器中打开。
- 大文件/超长行、无效 UTF-8 文件保持只读；大文件/超长行不提供语法级功能。
- 自动保存不覆盖检测到的磁盘冲突：冲突后需要选择“覆盖磁盘文件”或“重新载入”。
- ctags 候选是文本符号，不是精确语义结果；多个候选必须由用户选择。
- LSP 提供常用语言的启动预设，用户仍需自行安装语言服务器和 SDK；不捆绑、自动下载或逐一保证服务器版本兼容。真实服务器集成测试当前覆盖 TypeScript。
- Shift+F12 在没有 LSP 或服务器不支持 references 时只显示明确原因，不回退为文本搜索。
- 未在 Windows/Linux 实机运行时验证；本仓库只在 macOS arm64 上执行了完整构建、真实 LSP/ctags/rg 集成和桌面进程验证。
- 目录符号链接为了防循环不展开；全局 git ignore 的增量匹配相比启动全量扫描有边界差异。
- 终端会话不持久化，应用重启后结束；shell 取 `$SHELL` / `%COMSPEC%`，暂不支持自定义 shell、启动参数或 shell integration。
- 应用内设置目前仅支持字体；工具和 LSP 通过上述 JSON 配置。

## 项目结构

```text
src/                 React UI、CodeMirror、搜索/符号/快速打开组件
src/lib/             IPC 类型封装、状态与语言识别
src-tauri/src/
  workspace 相关      lib.rs（Tauri 命令和生命周期）
  cache.rs           SQLite 工作区、路径、符号缓存
  files.rs           目录懒加载、编码/二进制/大文件策略、安全路径
  path_index.rs      ignore 遍历、nucleo 模糊匹配、增量路径更新
  search.rs          ripgrep JSON 流、背压分页、取消
  symbols.rs         universal-ctags 增量索引和候选
  lsp/               JSON-RPC stdio 客户端、会话管理、位置转换
  watcher.rs         notify 防抖和增量刷新
  terminal.rs        PTY 会话、读写/缩放、按项目清理
fixtures/demo/       小型原创示例工作区
```

## 许可证

本项目采用 [MIT 许可证](LICENSE)。第三方代码和图标的许可声明见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，随附字体采用
[SIL Open Font License 1.1](src/assets/fonts/LICENSE.txt)。
