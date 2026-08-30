# UraGAN

面向普通用户的 **AI 动画视频生成框架**：选页面、填文案、导出视频。设计与内容彻底解耦——一切由外部配置文件驱动。

- 目录
  - [核心理念](#核心理念)
  - [标准工作流（6 步闭环）](#标准工作流6-步闭环)
  - [数据管理策略（去重与冲突解决）](#数据管理策略去重与冲突解决)
  - [组件与定制哲学](#组件与定制哲学)
  - [AI 与 MCP 集成](#ai-与-mcp-集成)
  - [实现状态](#实现状态)
  - [快速开始](#快速开始)
  - [便携分发包（独立运行 / 安装）](#便携分发包独立运行--安装)
  - [使用入口](#使用入口)
  - [仓库结构](#仓库结构)

---

## 核心理念

核心操作保持极简：**选页面 → 填文案 → 导出视频**。

- 视频组件、样式、动画全部由 `.uragan` 配置文件声明，**设计与内容彻底解耦**；
- 配置文件为纯 JSON 文本，人可读、AI 可读写、程序可解析，三方同用一套格式；
- 素材（图片、字体、音频、视频）不入配置包，只保存引用，渲染时再解析。

## 标准工作流（6 步闭环）

1. **生成配置**：将开发文档和需求发给 AI，生成一份去重的**整体交换配置**（共享池 `$shared` + 页面列表）。
2. **导入展开**：将配置文件导入软件，框架为每个页面**完整拷贝一份全部全局定义**（即使本页暂不使用的默认样式也一并携带），使各页面物理隔离、相互独立——修改某一页不会影响其他页。
3. **选择排序**：在软件界面中从导入的页面库里挑选并拖拽排序，形成播放顺序。
4. **导出框架**：根据排序导出一份**待填充的文案框架**（含全部占位符）发给 AI 填充。
5. **导入填充**：AI 填充文案后导回，软件校验并替换对应页面的内容。
6. **渲染视频**：一键合成带流畅动画的最终视频。

## 数据管理策略（去重与冲突解决）

**整体文件与独立文件**：`.uragan` 是导入/导出时的唯一单文件（**整体文件**，含多页）；导入后每页拆为**独立文件**（单页工程，自含画布等工程元信息）。两者**同一种文本格式**，独立文件可当整体文件用——只要含多个页，它就是整体文件。素材、字体等二进制一律不入包，只存引用（URL 或本地相对路径），渲染时解析。

**工程目录形态**：打开/新建工程时自动生成同名工程目录（`<名>.uragan/`），目录根下每页一个独立文件（`<pageId>.uragan`）：

```
promo.uragan/            # 工程目录
├── project.json         # 内部清单：播放顺序 order 与页组锁定 groups
├── p01_home.uragan      # 独立文件（单页工程）
├── p02_feature.uragan
└── components/          # 全局组件
```

- **导入拆分**：导入整体文件 = 拆分落盘为逐页独立文件；**导出合并** = 独立文件按播放顺序并回整体文件。
- **直接移入**：整体文件不经过导入、直接被移入工程目录也会被自动吸收（文件监视热更新），并按**整体文件内部的页面顺序锁定成组**——改变组内第 1 页顺序时，第 2 页跟着动（整组跟随移动）。
- **导入逻辑**：整体交换配置的共享池定义被**完整深拷贝**进每个独立页面的头部（`$defs`），此后各页只引用本地定义、各自自治；工程文件内不再保留 `$shared`。
- **导出逻辑**：扫描各页独立定义，值相同的合并回共享池；值不同的（冲突）自动将后出现页的定义键重命名（规范化后缀为完整页码，如 `color_primary_p02_feature`）再一并提取。导出结果保持去重，且键名全局不冲突。
- **单页交互**：任选一页导出为完整独立配置（含头部全部定义）发给 AI 修改（TUI 中对应 `G` 导出单页）；改完直接把文件放进工程目录即可 —— 目录里的独立 `.uragan` 页文件会被自动吸收，不需要额外的「导入单页」动作。

## 组件与定制哲学

- **页面优先**：页面是绝对核心，每页都能独立定制（字体、颜色、动画）。
- **组件为辅**：保留全局组件便于统一修改；若某页需要脱离组件独立，提供“复制代码到页面”功能——将组件代码与定义内联进该页，此后可在该页自由调整，不再受组件约束。

## AI 与 MCP 集成

整个框架封装为 **MCP Server（模型上下文协议服务器）**，对外提供“列举页面、调整顺序、导出文案框架、导出整体配置、渲染视频”等工具，AI Agent（如 Claude）可通过自然语言自主驱动整个流程，实现全对话式操作。

---

## 实现状态

当前版本 **v0.1**，五个包（shared / core / cli / render / mcp）已实现并通过 **73 项单元测试**：

| 能力 | 状态 | 说明 |
|---|---|---|
| Core 引擎 | 已实现 | 导入展开、去重/冲突重命名、往返不变量、本地引用拦截、JSONC 输入、schemaVersion 迁移器 |
| CLI 命令面 | 已实现 | `init/import/export/validate/pages/page/copy/shared/component/render/assets/tui/serve-mcp` |
| 渲染管线 | 已实现 | hero/section/grid/chart 翻译器 + Remotion 合成；内置 Chrome Headless Shell，支持离线渲染 |
| MCP Server | 已实现 | 15 个工具，协议级端到端测试通过（list_pages / reorder_pages / page_get / page_overwrite / copy_export / copy_import / component_inline / render_video 等） |
| TUI | 已实现 | 5 视图 + 全部动作键；中文 IME 整词输入与方向键光标、内置文件管理器（记忆上次位置）、导入/导出单页、页组锁定排序 |
| GUI | 规划中 | 预留 `uragan gui` 入口（原生 GUI 模式，框架选型 Qt/GTK 等尚未确定；不提供浏览器形态） |
| 文案框架文本形态 | 已实现 | 同一框架双形态：JSON（程序/AI 权威）+ Markdown 表单（普通用户直接填表；多行/代码片段走 `f@编号` 围栏块） |

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

## 便携分发包（独立运行 / 安装）

`pnpm run pack` 将五个包及全部第三方依赖扁平化为 `build/uragan/` 便携分发包，**不依赖 pnpm、源码与仓库环境**——任意目录、任意已装 Node 的机器均可直接使用（TUI / CLI / MCP 均可用，含内置离线渲染浏览器）：

```powershell
pnpm run pack            # 全量（含 @remotion 渲染依赖与离线浏览器）
# 或 pnpm run pack:lite   # 精简：不含渲染依赖（体积更小，渲染时提示缺失）
# node scripts/package-portable.mjs --bin-only   # 只重建 bin 入口（不重拷依赖，几秒完成）

# 在任何目录直接运行（Windows 使用 .cmd 入口）
& build\uragan\bin\uragan.cmd --version
& build\uragan\bin\uragan.cmd tui -p demo.uragan
& build\uragan\bin\uragan-mcp.cmd        # 独立 MCP Server
```

**双击 `uragan.cmd` 直接进 TUI**：不带任何参数、且处于交互终端时自动启动 TUI（管道 / 脚本等非交互场景仍打印帮助）；
未知命令会报错而不是被当成 TUI 启动。工程默认取当前目录的 `project.uragan`，若当前目录位于程序安装目录内
（双击时的工作目录就是 `bin\`），会自动切换到用户工作区 `%USERPROFILE%\Documents\UraGAN`
（可用环境变量 `URAGAN_WORKDIR` 覆盖），避免工程被建进安装包、在下一次 `pnpm run pack`（清空 `build/uragan`）时被删除。
启动器还会先检测 `node`：缺失时打印提示并暂停窗口，而不是让窗口一闪而过。

**安装到系统（Windows）**：将分发包拷贝到 `%LOCALAPPDATA%\UraGAN` 并注册用户 PATH，之后任意终端可直接使用：

```powershell
pnpm pack:install                         # 安装（幂等，可反复覆盖更新）
powershell -ExecutionPolicy Bypass -File scripts\install-portable.ps1 -Uninstall  # 卸载
```

> 说明：分发包已在与仓库分离的临时目录验证——CLI 全命令链、MCP 握手与 15 个工具、短样例离线渲染均可正常运行。
> 全量分发包体积约 600MB（其中 `node_modules/@uragan/render/vendor` 离线浏览器约占 270MB）。修改源码后重新执行 `pnpm run pack` 覆盖即可。

---

## 使用入口

### 终端 TUI（当前窗口）

```powershell
uragan tui [-p 工程.uragan]      # 不带 -p 进入后可按 O 打开 / N 新建
```

- **视图**：`1 页面 · 2 共享池 · 3 组件 · 4 资产 · 5 信息`
- **页面视图**：`↑↓` 选页 · `←→` 移动顺序 · `Enter` 编辑字段 · `G` 导出单页
- **全局**：`S` 导出文案框架 · `I` 导入文案 · `R` 渲染视频 · `V` 校验 · `T` 资产体检 · `O` 打开工程（文件管理器，记忆上次位置）· `N` 新建工程 · `X` 关闭工程 · `Ctrl+S` 保存回原文件 · `Q` 退出
- **字段编辑态**：输入即为文本，`Esc` 取消、`Enter` 提交（编辑态下 `s/i/r/e/o/n…` 不会触发快捷键）

#### 持久文件与工作目录

打开 `.uragan` 一律按「导入」处理：工程在派生的**工作目录**中进行，原 `.uragan` 文件原样保留、承担**持久存储**。

```
D:\my-video\
├── win11-promo.uragan            ← 持久文件（原文件，Ctrl+S 导出到这里）
├── win11-promo.uragan.work\      ← 工程目录：project.json + 每页一个独立文件 + skeleton.*
├── assets\                       ← 资产（用户的）
└── render.mp4                    ← 渲染产物
```

- **打开** = 导入：拆页写入工作目录；`.uragan` 是整体工程还是独立页面，流程一致
- **编辑**：每次改动实时写入工作目录；头部显示 `● 未保存` / `✓ 已同步 <原文件>`
- **保存（Ctrl+S）**：把工作目录的最新内容导出回原 `.uragan`
- **不保存也能用**：`R` 渲染、`V` 校验读的都是工作目录，与是否保存无关
- **再次打开**：工作目录已存在就直接接着用（里面未导出的改动不会被重新导入覆盖）
- **新建工程（N）** 本身就是目录工程 `名字.uragan\`，没有持久文件，编辑即落盘
- `.json` / `.jsonc` 交换配置：仍展开成同名的 `名字.uragan\` 目录，与原文件脱钩（不会回写覆盖）

**目录分工**：工程本体与文案框架进**工程目录**（自包含，且被 `.gitignore` 排除）；
资产 `assets\`、`render.mp4`、`G` 导出的单页落在**原文件旁**（用户看得见、方便分享）。

**已移除的旧设计入口**：`E` 导出整体配置、`M` 导入配置 ——
它们分别等于「Ctrl+S 导出回原 .uragan」和「O 打开工程」。
`U` 导入单页文件保留了（和 `G` 导出单页配对），之前是同一帧里显示了两个一样的 `U`，已去掉重复的那个。

### CLI / MCP（脚本 / 自动化 / AI Agent）

```powershell
uragan import config.json -o out.uragan           # 导入展开（交换配置 → 工程）
uragan pages list / pages reorder p02 p01         # 页面排序
uragan page get p01 / page overwrite p01 page.json # 单页循环
uragan copy export --format json|md               # 导出文案框架（JSON / Markdown 表单）
uragan copy import skeleton.md                    # 导入已填文案（自动识别两种格式）
uragan export demo.uragan -o config.json          # 导出整体交换配置（去重投影）
uragan component inline p01 card                  # 复制组件代码到页面
uragan render out.mp4                             # 渲染视频（离线）
uragan assets check                               # 资产体检
uragan serve-mcp                                  # 启动 MCP Server（stdio）
```

**三个入口行为一致**：CLI、MCP、TUI 打开工程都走同一条路 —— 目录工程聚合读，
`.uragan` 单文件先导入到 `<源名>.uragan.work\` 再读。
所以在 TUI 里改了但还没按 Ctrl+S 的内容，`uragan pages list -p 同一个文件` 也看得到；
反过来，CLI / MCP 的写操作是显式操作，会**同时落工程目录并导出回原 `.uragan`**（等价于保存）。

### GUI（规划中）

```powershell
uragan gui    # 预留入口：原生 GUI 模式未来提供（框架选型 Qt/GTK 等尚未确定）；当前交互界面请使用 uragan tui
```

### MCP（AI Agent 对话驱动）

```jsonc
{
  "mcpServers": {
    "uragan": {
      "command": "node",
      "args": ["<绝对路径>/packages/mcp/dist/cli.js"]
    }
  }
}
```

Agent 按 `project_new`（或用 `project_import` 拿交换配置整体建/覆盖工程）→ `list_pages` → `reorder_pages` → `copy_export` → `copy_import` → `render_video` 即可自主走完 6 步闭环。

**术语区分**（容易混）：

- **打开工程** = 把任意文件源导入到工程目录。`.uragan` 单文件会导入到同级的 `<名字>.uragan.work\`，
  原文件保留为持久文件 —— 等价于 TUI 的 `O` / `uragan tui -p`
- **`project_import`** = 用交换配置（`$shared` 形态）**整体创建或覆盖**一个指定名字的工程：
  能指定输出工程名、能覆盖已有工程，这是「打开」做不到的
- **`project_export`** = 导出整体交换配置（`$shared` 去重视图），用于一次性整体改主色/字体等共享值；
  工程本体不受影响，也不需要它来做持久化（持久化靠 `Ctrl+S` / 原 `.uragan`）

#### 接入 TRAE（已实测握手与 15 个工具加载通过）

TRAE 通过项目级配置文件 `.trae/mcp.json` 加载 MCP Server；由于安全限制，该文件仅允许用户手动创建与编辑，请按以下步骤操作：

1. 在项目根目录新建 `.trae/mcp.json`，填入（`${workspaceFolder}` 会自动展开为工作区路径）：

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

2. 打开 TRAE 设置，进入 **MCP**，开启 **启用项目级 MCP** 并确认。
3. **完全重启 TRAE**（MCP 进程有缓存，必须重启才生效）。
4. 对话中出现 UraGAN 的 15 个工具（project_new / project_import / project_export / project_validate / list_pages / reorder_pages / page_get / page_overwrite / copy_export / copy_import / shared_pool / component_list / component_inline / assets_check / render_video）即为接入成功。

> 提醒：修改 `packages/mcp` 源码后需重新执行 `pnpm --filter @uragan/mcp build`，再重启 TRAE 才会加载新代码。

### 离线渲染

渲染浏览器（Chrome Headless Shell，约 270MB）体积过大（exe 超过 GitHub 单文件 100MB 限制），不纳入 Git（见 `.gitignore`），但会随仓库目录保留在 `packages/render/vendor/` 中：

- 已存在 `vendor` 的机器：渲染过程**无需联网**；
- 没有 `vendor` 的机器：首次渲染会自动在线下载到 Remotion 缓存，之后离线；
- 自定义浏览器路径：设置环境变量 `URA_CHROME_BROWSER`；
- 可离线复用：将 `packages/render/vendor/` 整个拷贝到目标机。

---

## 仓库结构

```
packages/
├── shared/    # 领域类型、zod schema、常量（被 core/cli/mcp/render 复用）
├── core/      # 逻辑引擎：parser / expander / dedup / copy / inline / validate / store
├── cli/       # 命令行 + TUI（commander + Ink）
├── mcp/       # MCP Server（stdio，工具面 = CLI 命令面）
└── render/    # Remotion 翻译与合成（内置离线浏览器 vendor/）
scripts/       # 便携分发包打包（package-portable.mjs）与安装（install-portable.ps1）
```