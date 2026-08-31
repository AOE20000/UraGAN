# UraGAN

面向普通用户的 **AI 动画视频生成框架**：选页面、填文案、导出视频。设计与内容彻底解耦，一切由配置文件驱动，AI 可以全流程参与。

> **当前状态（v0.1）**：CLI / TUI / MCP 三个入口 + 离线渲染管线已可用，Windows 下可打包为目录便携包或**单文件 exe**（无需安装 Node）。**106 项自动化测试全部通过**。

- 目录
  - [当前能做什么](#当前能做什么)
  - [特性清单](#特性清单)
  - [快速开始](#快速开始)
  - [使用入口](#使用入口)
  - [未来计划（Roadmap）](#未来计划roadmap)
  - [文档导航与仓库结构](#文档导航与仓库结构)

---

## 当前能做什么

**一句话：把一段需求变成一条视频。** 核心操作只有三步——选页面、填文案、导出视频；AI 可以代替你完成其中任何一步或全部。

### 三种使用方式（同一套能力，行为完全一致）

| 方式 | 适合谁 | 能做什么 |
|---|---|---|
| **TUI 交互界面**（终端里运行） | 直接在电脑上操作的人 | 可视化浏览/排序页面、编辑文案字段、内置文件管理器打开工程、一键渲染 |
| **CLI 命令行** | 脚本、批处理、自动化 | 建工程、导入/导出配置、页面排序、导出/导入文案框架、渲染、校验 |
| **MCP（AI 对话驱动）** | 想"说人话"做视频的人 | 让 Claude 等 AI Agent 通过自然语言自主完成全流程：新建工程、排页面、填文案、渲染 |

三种入口背后是**同一套核心引擎**：在 TUI 里改了还没保存的内容，CLI/MCP 立刻读得到；CLI/MCP 的写操作等价于保存。规则只有一条——**命令行能力 = MCP 工具 = 核心能力**，不会出现"界面能做、命令做不了"的差异。

### 六步工作流（AI 全流程驱动）

1. **生成配置**：把需求文档发给 AI，生成一份去重的整体交换配置；
2. **导入展开**：导入软件，配置拆分为逐页独立的工程；
3. **选择排序**：挑选页面、调整播放顺序（可整组锁定移动）；
4. **导出框架**：导出一份待填写的**文案框架**（JSON 或 Markdown 表格）；
5. **导入填充**：AI（或你自己）填好文案后导回，自动校验并替换；
6. **渲染视频**：一键合成带流畅动画的 mp4（支持离线渲染）。

### 现在的边界（诚实说明）

- **渲染**需要完整分发包（含 Remotion 与内置离线浏览器）；**单文件 exe 是精简版**（TUI/CLI/MCP 全可用，执行渲染命令会给出明确提示，改用完整分发包即可）。
- 页面模板目前有 **4 类**：开头（hero）/ 分节（section）/ 卡片（grid）/ 数据（chart），渲染输出 mp4（h264/h265/vp8/vp9）。

---

## 特性清单

### 工程与文件格式

- **单文件工程 `.uragan`**：整个工程就是一个纯 JSON 文本文件，人可读、AI 可读写、程序可解析，三方同用一套格式；素材只存引用，不入包。
- **目录工程 `<名>.uragan/`**：每页一个独立文件 + `project.json` 内部清单，便于版本管理与逐页协作。
- **持久文件 + 工作目录**：打开 `.uragan` 一律视为导入——工程在派生的 `<名>.uragan.work/` 工作目录里进行，原文件原样保留承担持久存储，`Ctrl+S` 才导出回去；不保存也能渲染/校验。
- **交换配置 `.json/.jsonc`**：与 AI 交换的中间形态，支持注释；导入展开、导出合并。
- **去重与冲突自动化解**：导出时相同定义自动合并进共享池，重名冲突自动重命名（如 `color_primary_p02_feature`），文件永不重复、键名永不冲突。
- **页面物理隔离**：导入时全局定义深拷贝到每页，改一页绝不影响其他页；本地引用不变量由解析器强制。

### 编辑体验（TUI）

- **6 个视图**：页面 / 共享池 / 组件 / 资产 / 信息 / 日志，`1-6` 一键切换；列表超出可视高度自动隐藏并提示「上方/下方还有 N 项」。
- **中文输入友好**：IME 整词直接上屏、左右方向键移动光标、退格删除。
- **内置文件管理器**（`O`）：路径提示栏显示当前位置；`/` 输入绝对路径直达；`H` 一键回主目录；展示目录内全部文件，可打开的工程打标；位置自动记忆。
- **单页导入/导出**：任选一页导出成独立文件发给 AI（`G`），改完放进工程目录即被自动吸收（`U`）。
- **页组锁定排序**：整体文件移入工程时内部页序锁定成组，组内页面整组跟随移动。
- **操作日志视图**：打开/保存/校验/渲染等操作留痕，便于回溯。

### 内容管线

- **文案框架双形态**：同一份框架同时输出 JSON（程序/AI 权威）与 Markdown 表单（普通用户直接填表，多行/代码走 `f@编号` 围栏块）。
- **组件系统**：全局组件统一改、需要时一键"复制到页面"内联后自由定制。
- **校验与资产体检**：渲染前发现失效引用、结构错误，给出可读的定位提示。
- **信息视图**：工程元数据、共享池定义、校验报告一目了然。

### 渲染

- 4 类页面模板翻译为 React/Remotion 合成，逐帧精确控制。
- **内置 Chrome Headless Shell（约 270MB）**：离线可用、无需联网；缺失时自动在线下载，也可用环境变量 `URA_CHROME_BROWSER` 指定浏览器。
- 支持 h264/h265/vp8/vp9 编码与进度输出。

### AI 集成（MCP）

- **15 个工具**：`project_new / project_import / project_export / project_validate / list_pages / reorder_pages / page_get / page_overwrite / copy_export / copy_import / shared_pool / component_list / component_inline / assets_check / render_video`。
- **对话式闭环**：Agent 按「建工程 → 排页面 → 导框架 → 收文案 → 渲染」即可自主走完 6 步。
- **已实测接入 TRAE**（项目级 MCP），Claude 等支持 MCP 的客户端同样可用。

### 分发形态（Windows）

- **目录便携包**（`pnpm run pack`）：全量约 600MB（含离线浏览器），任意目录可直接运行；另有精简版（不含渲染依赖）与一键安装/卸载脚本。
- **单文件 exe**（`pnpm run pack:exe`）：约 86MB 一个文件，**目标机器无需安装 Node**，双击即进 TUI；`serve-mcp` 子命令直接当 MCP Server 用。

---

## 快速开始

```powershell
# 1) 安装依赖并构建
pnpm install
pnpm build

# 2) 建一个空工程（或用示例配置导入）
node packages/cli/dist/index.js init demo.uragan --canvas 1280x720 --name 示例
node packages/cli/dist/index.js import examples/promo.config.json -o demo.uragan

# 3) 用 TUI 交互（推荐，覆盖全部功能）
node packages/cli/dist/index.js tui -p demo.uragan
```

不想从源码构建？直接用打包产物：

```powershell
pnpm run pack:exe           # 生成单个 uragan.exe（约 86MB，无需 Node）
build\uragan\uragan.exe     # 双击/运行 → 直接进 TUI
build\uragan\uragan.exe serve-mcp   # 或作为 MCP Server 启动

# 或全量目录便携包（含渲染引擎与离线浏览器；需目标机已装 Node）
pnpm run pack               # 产物：build\uragan\（含 bin\uragan.cmd）
build\uragan\bin\uragan.cmd tui -p demo.uragan
pnpm run pack:lite          # 精简版：不含渲染依赖
pnpm run pack:install       # 一键安装到系统（注册用户 PATH）并支持卸载
```

---

## 使用入口

### TUI（终端交互，推荐）

```powershell
uragan tui [-p 工程.uragan]      # 不带 -p 进入后可按 O 打开 / N 新建
```

- **视图**：`1 页面 · 2 共享池 · 3 组件 · 4 资产 · 5 信息 · 6 日志`
- **页面视图**：`↑↓` 选页 · `←→` 移动顺序 · `Enter` 编辑字段 · `G` 导出单页
- **文件管理器（O）**：`↑↓` 选择 · `Enter` 进入/打开 · `Backspace` 上级 · `H` 主目录 · `/` 输入路径直达 · `Esc` 关闭
- **全局**：`S` 导出文案框架 · `I` 导入文案 · `R` 渲染视频 · `V` 校验 · `T` 资产体检 · `O` 打开工程 · `N` 新建工程 · `X` 关闭工程 · `Ctrl+S` 保存回原文件 · `Q` 退出
- 打开 `.uragan` 后：编辑实时写入工作目录，`Ctrl+S` 才写回原文件；`R`/`V` 读取的是工作目录，与是否保存无关。

### CLI（脚本 / 自动化）

```powershell
uragan init demo.uragan --canvas 1280x720 --name 示例    # 新建空白工程
uragan import config.json -o out.uragan                  # 导入展开（交换配置 → 工程）
uragan pages list / pages reorder p02 p01                # 页面排序
uragan page get p01 / page overwrite p01 page.json       # 单页读写
uragan copy export --format json|md                      # 导出文案框架
uragan copy import skeleton.md                           # 导入已填文案
uragan export demo.uragan -o config.json                 # 导出整体交换配置
uragan component inline p01 card                         # 复制组件代码到页面
uragan render out.mp4                                    # 渲染视频（离线）
uragan assets check                                      # 资产体检
uragan serve-mcp                                         # 启动 MCP Server
```

### MCP（AI 对话驱动）

```jsonc
// 客户端 MCP 配置示例（以支持 MCP 的 AI IDE 为例）
{
  "mcpServers": {
    "uragan": {
      "command": "node",
      "args": ["<绝对路径>/packages/mcp/dist/cli.js"]
      // 或用单文件 exe：{ "command": "uragan.exe", "args": ["serve-mcp"] }
    }
  }
}
```

Agent 按 `project_new` → `list_pages` → `reorder_pages` → `copy_export` → `copy_import` → `render_video` 即可自主走完整个流程。TRAE 接入方式（项目级 `.trae/mcp.json`）见下文附录。

> 术语区分：**打开工程** = 把任意文件源导入到工程目录（`.uragan` 单文件会导入到同级 `.uragan.work\`，原文件保留为持久文件）；**`project_import`** = 用交换配置整体创建或覆盖指定名字的工程；**`project_export`** = 导出 `$shared` 去重投影（如整体改主色/字体），不影响工程本体。

---

## 未来计划（Roadmap）

> 方向性规划，不承诺具体时间表；随版本迭代按优先级取舍。

| 方向 | 说明 | 状态 |
|---|---|---|
| **原生 GUI** | 面向不习惯终端的用户：可视化编辑、拖拽排序、预览。预留 `uragan gui` 入口，框架选型待定（不提供浏览器形态） | 规划中 |
| **渲染进单文件 exe** | 当前 `uragan.exe` 为精简版（不含 Remotion）；目标是让单文件也能直接渲染成片 | 规划中 |
| **更多页面模板与动画** | 现有 hero/section/grid/chart 四类；扩展更多版式与转场/动效 | 规划中 |
| **消除 SmartScreen 提示** | 为 exe 配置代码签名证书，让分发更顺滑 | 规划中 |
| **模板与素材共享** | 页面模板、动画效果、文案框架的分享与复用（本地目录或市场形态） | 方向 |
| **多端与协作** | 多人 / 多 AI 在同一工程上协作、更细粒度的变更合并 | 方向 |

---

## 文档导航与仓库结构

- **现状、特性与规划**（当前能力、特性清单、设计原则与 Roadmap 的详细版）见 [`docs/implementation-design.md`](docs/implementation-design.md)——面向实现者与维护者，本 README 不重复。
- **仓库结构**：

```
packages/
├── shared/    # 领域类型、zod schema、常量（被 core/cli/mcp/render 复用）
├── core/      # 逻辑引擎：parser / expander / dedup / copy / inline / validate / store
├── cli/       # 命令行 + TUI（commander + Ink）
├── mcp/       # MCP Server（stdio，工具面 = CLI 命令面）
└── render/    # Remotion 翻译与合成（内置离线浏览器 vendor/）
scripts/       # 打包脚本（package-portable.mjs / package-exe.mjs）与安装脚本
docs/          # 设计文档（implementation-design.md）
```

### 附录：TRAE 接入（已实测）

1. 项目根目录新建 `.trae/mcp.json`（仅允许手动创建）：

```json
{
  "mcpServers": {
    "uragan": {
      "command": "node",
      "args": ["${workspaceFolder}/packages/mcp/dist/cli.js"],
      "env": { "START_MCP_TIMEOUT_MS": "60000", "RUN_MCP_TIMEOUT_MS": "60000" }
    }
  }
}
```

2. TRAE 设置 → MCP → 开启「启用项目级 MCP」→ **完全重启 TRAE**（MCP 进程有缓存）。
3. 对话中出现 15 个工具即接入成功；修改 `packages/mcp` 源码后需重新 `pnpm --filter @uragan/mcp build` 并重启。
