# Gaze 优化实施方案

更新日期：2026-10-31

## 目标与边界

在不把 Gaze 扩展成完整 IDE 的前提下，优先提升批量操作安全性、大文档流畅度、键盘可访问性和后台资源效率。保留现有原子保存、磁盘冲突保护、懒加载和列表虚拟化策略，不进行全局重写。

按当前决策，不处理字体文件体积和字体加载优化。

## 第一批：替换可靠性、主线程性能与模态框可访问性

### 1. 全局替换预览取消与阻塞隔离

现状：

- 预览进行中无法通过取消按钮终止后端工作。
- 预览和应用替换在异步命令中逐个执行同步文件读取、正则计算和写入。

实施：

- 为替换预览引入请求 ID 和后端取消机制，前端取消后立即使过期结果失效。
- 将同步文件计算和写入移到阻塞线程，避免占用异步运行时工作线程。
- 保留现有文件指纹校验、结果上限和编辑器/Git 写锁。
- 应用替换不伪装成可安全取消的事务；部分成功与失败仍逐项报告。

验收：

- 预览进行中可以取消，取消后不再展示本次预览结果。
- 过期预览不会覆盖后续请求，Rust 取消测试通过。
- 现有搜索替换、冲突检测和编辑器锁定测试保持通过。

### 2. 编辑器与 Markdown 主线程优化

现状：

- 文档变化时存在完整文本复制和 Git gutter diff。
- Markdown 预览开启时，每次输入都会同步解析完整文档。

实施：

- 延迟非紧急 Git gutter diff，避免输入关键路径上的频繁计算。
- Markdown 打开预览时立即渲染；预览期间的编辑采用 120ms 防抖，让输入优先于全文复制与解析。
- 保持自动保存、脏状态、撤销历史和 Markdown 图片/链接行为不变。

验收：

- 连续输入时源码编辑保持响应，预览稍后追平。
- 现有自动保存、Git gutter 和 Markdown 预览测试通过。
- 后续使用 1 MiB、20,000 行文件补充桌面 Profiler 验证。

### 3. 大型 Git diff 渲染优化

现状：

- diff 在渲染前对完整补丁执行语法高亮，并渲染全部 hunk 和代码行。

实施：

- 将非紧急语法高亮移出首次渲染关键路径。
- 复用列表虚拟化思路，避免超大 diff 同时挂载所有行；保持暂存、取消暂存和丢弃 hunk 操作可用。
- 保留当前工作区中已有的路径省略与 diff 栏宽修改。

验收：

- 大补丁首屏只渲染必要内容，滚动与 hunk 操作正常。
- 现有 DiffView、分支比较和 Git 工作区测试通过。

### 4. 统一模态框焦点管理

现状：

- 快速打开、位置选择和未保存确认声明了模态语义，但焦点圈定与关闭后的焦点恢复不一致。

实施：

- 抽取一个小型共享焦点管理 Hook，统一处理初始焦点、Tab/Shift+Tab 圈定和焦点恢复。
- 接入快速打开、位置选择和未保存确认；保留现有 Escape、忙碌状态和背景点击行为。
- 不重写已正确使用原生 dialog 的设置页。

验收：

- Tab 不会离开模态框，关闭后焦点返回触发元素或合理后继元素。
- 增加焦点循环与恢复测试，现有组件测试通过。

## 第二批：数据恢复与后台背压

### 1. 崩溃恢复

- 对 dirty 缓冲区记录恢复日志、原文件指纹和时间戳。
- 正常保存后清除日志；重启后由用户选择恢复，不自动覆盖磁盘文件。

### 2. 批量替换撤销

- 为一次替换生成操作 ID，记录原文件指纹和备份。
- 提供一键撤销，恢复前再次校验当前指纹，避免覆盖后续编辑。

### 3. 终端与文件监听背压

- 合并终端输出事件并按帧写入 xterm，减少 Base64 与 IPC 开销。
- 已退出进程及时释放 PTY 资源，保留可见滚动缓冲区。
- 文件监听改为有界队列与路径级合并，控制事件风暴下的内存增长。

## 第三批：体验与工程维护

### 1. Markdown 图片

- 用受路径范围约束的资源协议替代大尺寸 Base64 IPC。
- 远程图片默认阻止或按项目询问信任，并增加缓存和预览内存限制。

### 2. 窄窗口与键盘细节

- 修正设置页紧凑布局断点与桌面最小宽度不匹配的问题。
- 标签页补充方向键切换、Home/End 和 roving tabindex。
- 文件树补充左右折叠/展开及树结构 ARIA 信息。

### 3. 工程维护

- 按编辑器、文件操作、替换和会话状态域逐步拆分 App.tsx。第三批先将替换预览、应用、取消和撤销抽到 `src/lib/useReplacement.ts`，由 Hook 内部持有替换操作与撤销目标；App 仅传入编辑器/标签引用、工作区项目读取器、操作锁和文件事件处理函数，键盘处理通过 Hook 暴露的忙碌判断接口协作。
- 清理 `src/components/FileTree.test.tsx` 粘贴测试中的重复 key 测试数据警告：根目录与 `src` 使用不同的复制文件名，仍覆盖根目录、目录和文件父级三种目标。
- 增加 `src/components/MarkdownPreview.bench.tsx` 与 `pnpm test:perf`，记录 1 MiB、20,000 行 Markdown 的渲染基准；保留第一批模态框焦点循环测试，并由第三批 TabBar、FileTree 测试覆盖键盘和 ARIA 回归。

## 验证命令

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

## 实施状态

- [x] 第一批：替换可靠性、主线程性能与模态框可访问性（2026-10-31 完成）
- [x] 第二批：数据恢复与后台背压（2026-10-31 完成）
- [x] 第三批：体验与工程维护（2026-10-31 完成）

## 第一批验证记录（2026-10-31）

- `pnpm format:check`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：44 个测试文件、322 项测试通过。
- `pnpm build`：通过，已生成 `lineDiff.worker` 与 `diffTokens.worker` 构建产物。
- `cargo fmt --check`：通过。
- `cargo clippy --all-targets -- -D warnings`：通过。
- `cargo test`：160 项通过、5 项按既有条件忽略。
- 既有 FileTree 粘贴测试仍报告重复 key 测试数据警告，保留到第三批处理。

## 第二批验证记录（2026-10-31）

- `pnpm format:check`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：44 个测试文件、329 项测试通过。
- `pnpm build`：通过。
- `cargo fmt --check`：通过。
- `cargo clippy --all-targets -- -D warnings`：通过。
- `cargo test`：172 项通过、5 项按既有条件忽略。
- README 已同步崩溃恢复、批量替换撤销及当前限制说明。

## 第三批验证记录（2026-10-31）

- `pnpm format:check`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：44 个测试文件、333 项测试通过，FileTree 重复 key 警告已清理。
- `pnpm build`：通过。
- `pnpm test:perf`：1 MiB、20,000 行 Markdown 基准通过；jsdom 下 3 次采样平均约 8.68 秒，作为后续相对比较基线。
- `cargo fmt --check`：通过。
- `cargo clippy --all-targets -- -D warnings`：通过。
- `cargo test`：173 项通过、5 项按既有条件忽略。
- `git diff --check`：通过。
- README 已同步 Markdown 图片信任策略与标签页、文件树键盘操作。
