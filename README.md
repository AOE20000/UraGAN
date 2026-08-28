# UraGAN

### 核心理念
打造一个**面向普通用户的AI动画视频生成框架**。核心操作极简：**选页面、填文案、导出视频**。设计完全由外部配置文件驱动，实现“设计与内容彻底解耦”。

### 标准工作流（6步闭环）
1. **生成配置**：将开发文档和需求发给AI，生成一份**去重的整体交换配置**（“共享池（$shared）+ 页面列表”）。
2. **导入展开**：将配置文件导入软件，框架自动为每个页面**完整拷贝一份全部全局定义**（即使本页暂不使用的默认样式也一并携带），使各页面变成**物理隔离、相互独立**的配置文件（用户修改某一页，绝不影响其他页）。
3. **选择排序**：用户在软件界面中，从导入的页面库里**挑选并拖拽排序**，形成播放顺序。
4. **导出框架**：根据排序，导出一份**待填充的文案框架**（含所有占位符）发给AI填充。
5. **导入填充**：AI填充文案后导回，软件校验并替换对应页面的内容。
6. **渲染视频**：一键合成带流畅动画的最终视频。

### 数据管理策略（去重与冲突解决）
- **存储形态**：工程就是**一个单文件** `.uragan`——**纯 JSON、直接可读、可直接用文本编辑器打开修改**。素材、字体等二进制**不入包**，只存引用（URL 或本地相对路径），渲染时才解析。
- **两种同格式视图**：**整体交换配置**（AI 生成/接收的形态）采用**“共享池（$shared）+ 页面列表”**的轻量去重结构，方便AI处理；**工程文件**即其**展开形**——把 `$shared` 中**全部定义完整深拷贝**进每个页面的头部（$defs），此后工程文件内不再保留 $shared。
- **导入逻辑**：导入时，将交换配置中共享池的定义**完整拷贝到每个独立页面的头部（$defs）**（深拷贝，全量），页面内容只引用本地定义。从此各页“各自为王”。
- **导出逻辑**：扫描所有页面的独立定义，**值相同的合并回共享池**；**值不同的（冲突）则自动将冲突页面的定义Key重命名**（如 `color_primary_p2`，规范化后缀为完整页码，如 `color_primary_p02_feature`），再一并提取到共享池。保证导出文件**永远无重复轮子且无键名冲突**。
- **单页交互**：用户可随时将**任一页的完整独立配置**（含头部所有定义）导出发给AI修改。改完后拖回软件（或经 MCP/CLI 覆盖回写），直接暴力覆盖原页，完美兼容。

### 组件与定制哲学
- **页面优先**：以“页面”为绝对核心，每个页面都能轻松独立定制（改字体、颜色、动画）。
- **组件次要**：仅保留全局组件功能（便于统一修改）。若某页需要脱离组件独立，提供**“复制代码到页面”**的功能（一键将组件代码内联进该页，彻底断开父子关系），之后即可自由“搜索替换”。

### AI与MCP集成
- 将整个框架封装为**MCP Server（模型上下文协议服务器）**，对外暴露“列举页面”、“调整顺序”、“导出文案框架”、“导出整体配置”、“渲染视频”等工具，让Claude等AI Agent能通过自然语言**自主驱动整个流程**，实现全对话式操作。

---

## 实现状态

当前为 **v0.1（核心全部落地）**，七个包（shared / core / cli / render / mcp / gui）已实现并通过 **69 项单元测试**：

| 能力 | 状态 | 说明 |
|---|---|---|
| Core 引擎 | ✅ | 导入展开、去重/冲突重命名、往返不变量、本地引用拦截、JSONC 输入、schemaVersion 迁移器 |
| CLI 命令面 | ✅ | `uragan init/import/export/validate/pages/page/copy/shared/component/render/assets/tui/serve-mcp` |
| 渲染管线 | ✅ | hero/section/grid/chart 翻译器 + Remotion 合成；**内置 Chrome Headless Shell，离线渲染**（无需联网下载浏览器） |
| MCP Server | ✅ | 15 个工具（list_pages/reorder_pages/page_get/page_overwrite/copy_export/copy_import/component_inline/render_video…），协议级端到端测试通过 |
| TUI | ✅ | 5 视图（页面/共享池/组件/资产/信息）+ 全部动作键，背景块配色（黑/白终端均清晰） |
| GUI | ✅ | 零依赖 Web 界面：拖拽排序、单页编辑、文案填充（JSON/Markdown）、组件内联、资产体检、渲染预览 |
| 文案框架文本形态 | ✅ | 同一框架双形态：JSON（程序/AI 权威）+ **Markdown 表单**（普通用户直接填表；多行/代码片段走 `f@编号` 围栏块） |

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

## 使用入口

### 终端 TUI（当前窗口，最完整）
```powershell
uragan tui [-p 工程.uragan]      # 不带 -p 进入后可按 O 打开 / N 新建
```
- **视图**：`1 页面 · 2 共享池 · 3 组件 · 4 资产 · 5 信息`
- **页面视图**：`↑↓` 选页 · `←→` 移动顺序 · `Enter` 编辑字段 · `G` 导出单页
- **全局**：`S` 导出文案框架 · `I` 导入文案 · `R` 渲染视频 · `E` 导出整体配置 · `M` 导入配置 · `V` 校验 · `T` 资产体检 · `O` 打开工程 · `N` 新建工程 · `X` 关闭工程 · `Q` 退出

### CLI（脚本/自动化）
```powershell
uragan import config.json -o out.uragan   # 导入展开
uragan pages list / reorder p02 p01       # 排序
uragan page get p01 / page overwrite p01 file.json  # 单页循环
uragan copy export --format json|md       # 导出文案框架（JSON / Markdown 表单）
uragan copy import skeleton.md            # 导入已填文案（自动识别两种格式）
uragan export demo.uragan -o config.json  # 导出整体交换配置（dedup）
uragan component inline p01 card          # 复制组件代码到页面
uragan render out.mp4                     # 渲染视频（离线）
uragan assets check                       # 资产体检
uragan serve-mcp                          # 启动 MCP Server（stdio）
```

### GUI（浏览器，零命令）
```powershell
node packages/gui/dist/server.js --project demo.uragan --port 5173
# 打开 http://127.0.0.1:5173
```

### MCP（AI Agent 对话驱动）
```jsonc
{ "command": "node", "args": ["E:/UraGAN/packages/mcp/dist/cli.js"] }
```
Agent 按 `project_import → list_pages → reorder_pages → copy_export → copy_import → render_video` 即可自主走完 6 步闭环。

### 离线渲染
浏览器已内置在 `packages/render/vendor/`，**拷贝工程即可在任何无网机器渲染**；无内置时回退在线下载，也可用环境变量 `URA_CHROME_BROWSER` 指定。
