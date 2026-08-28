# UraGAN 具体实现设计

> 版本：v1.0（设计稿）
> 形态决策：**CLI + MCP 优先**（界面后期再加）、渲染采用 **Remotion 方案**、交付为本文档。
> 目标读者：实现者（含 AI Agent）、后续维护者。

---

## 1. 设计目标与原则

| 目标 | 说明 |
|---|---|
| 面向普通用户 | 用户只接触「一个工程文件（.uragan）+ 导出视频」，不接触代码 |
| 设计/内容解耦 | 设计（结构、样式、动画）由外部配置文件驱动；文案由 AI 填充 |
| 页面物理隔离 | 导入时共享定义深拷贝到每页头部，改一页绝不影响其他页 |
| 去重与冲突自动化解 | 导出时合并相同定义、自动重命名冲突键，文件永不重复、永不冲突 |
| AI 全流程驱动 | 整个框架封装为 MCP Server，Agent 可通过自然语言完成 6 步闭环 |

**三个不可违背的顶层不变量：**

1. **本地引用不变量**：任意页面的内容只允许 `$ref` 本页 `$defs`（或内建定义），**禁止跨页引用**——这是物理隔离的代码级保证，解析器强制执行。
2. **往返不变量**：`导出整体配置 → 导入展开` 与 `导入整体配置 → 导出交换配置` 均为一轮不变式（页内容逐字节一致、定义键与值一致）。
3. **键唯一不变量**：导出产物中，任意定义键在任一路径上全局唯一；冲突由系统自动重命名，绝不报错中断。

---

## 2. 总体架构

```
┌────────────────────────────────────────────────────────────┐
│                         MCP Agent 层                        │
│            (Claude / 任意支持 MCP 的对话式 AI)                │
└──────────────────────────┬─────────────────────────────────┘
                           │ stdio
┌──────────────────────────▼─────────────────────────────────┐
│                     MCP Server (packages/mcp)              │
│   list_pages · reorder_pages · page_get · page_overwrite    │
│   copy_export · copy_import · render_video · project_*      │
└──────────────────────────┬─────────────────────────────────┘
┌──────────────────────────▼─────────────────────────────────┐
│                      CLI (packages/cli)                    │
│        commander 命令面 = MCP 工具面 = core 能力面            │
└──────────────────────────┬─────────────────────────────────┘
┌──────────────────────────▼─────────────────────────────────┐
│                  Core 引擎 (packages/core)                 │
│  schema / parser / expander / dedup / copy / inline /      │
│  validate / store                                          │
│        ▲            ▲              ▲                        │
└────────┼────────────┼──────────────┼───────────────────────┘
    (读 .uragan)  (写 .uragan)  (读产物)                      │
┌────────┴────────────┴──────────────┴───────────────────────▼┐
│               Render (packages/render)                     │
│  读文件 → 翻译(config→React/Remotion) → 合成Root → 渲染mp4      │
└────────────────────────────────────────────────────────────┘

共享层 packages/shared：领域类型、zod schema、常量（被 core/cli/mcp/render 复用）
```

- **Core 是唯一持有状态与规则的层**。CLI 与 MCP 只是它的两个壳（命令面一一对应），保证"对话驱动"与"命令行驱动"行为完全一致，测试一次即可覆盖两层。
- 渲染层只读工程文件（单 JSON），产出 mp4，不回写工程。

### 2.1 技术栈

| 项 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript（严格模式） | MCP SDK 与 Remotion 均 TS 原生，单语言降低 AI 开发摩擦 |
| 运行时 | Node.js ≥ 20 | Remotion 构建链（webpack/bundler）依赖 Node |
| 包管理/组织 | pnpm workspace 单仓 | 五包共享类型，依赖清晰 |
| CLI | commander + picocolors + ora | 轻量、命令面易映射到 MCP |
| MCP | `@modelcontextprotocol/sdk` | stdio 传输，与 CLI 形态天然契合 |
| 校验 | zod | AI 生成配置入站校验主力 |
| 工程文件 | 单个 JSON（`.uragan`，UTF-8、直接可读可改） | 不打包、不压缩、无二进制；与交换配置同一种文本格式（工程文件即其展开形） |
| 渲染 | `remotion` + `@remotion/cli` | 配置翻译为 React 组件，逐帧精确控制 |

---

## 3. 数据格式设计（核心）

### 3.1 工程文件 `.uragan`（单个 JSON，直接可读）

```
promo.uragan                       # 单个 JSON 文件（UTF-8，扩展名 .uragan），内容即"直接可读"的配置
{
  "schemaVersion": "1",
  "project":   { "id": "promo_a", "name": "品牌宣传片",
                 "canvas": { "width": 1280, "height": 720, "fps": 30 },
                 "defaults": { "pageDuration": 2.5 } },
  "pages": [ ... ],                # 展开形：每页自带 $defs（见 §3.3）；pages 数组顺序 = 播放顺序（唯一权威）
  "components": [ ... ]            # 全局组件（可选）
}
```

**关键决策：**
- **单文件、纯文本、直接可读**：工程文件与"供 AI 生成/接收的整体交换配置"是同一种文本格式（工程文件＝交换配置的**展开形**），人、AI、程序三方都能直接打开、阅读、编辑。不打包、不压缩、无二进制。
- **素材/字体不入包**：图片、字体等一律只存**引用**（URL 或工程文件旁的相对路径，见 §3.8），渲染时才解析。配置文件永远干净可读，单文件可在不同机器间无障碍传递。
- **页面顺序单一权威 = `pages` 数组顺序**（元素含 `pageId`），页内不存 order，避免双写冲突。
- **单页导出/覆盖退化为"文件内区块操作"**：单页导出 = 抽出数组中某个页面对象（含头部 `$defs`）；单页覆盖 = 替换数组中对应项并重新校验。

### 3.2 交换配置（AI 生成/接收的整体配置 JSON）

`$shared` + `pages` 并列，页面内定义引用共享键（**同一份格式、导入导出对称**）：

```jsonc
{
  "schemaVersion": "1",
  "project": {
    "id": "promo_a",
    "name": "品牌宣传片",
    "canvas": { "width": 1280, "height": 720, "fps": 30 }
  },
  "$shared": {
    "color_primary": { "type": "color",   "value": "#4F46E5" },
    "font_title":    { "type": "font",    "family": "Noto Sans SC", "weight": 800 }
  },
  "pages": [
    {
      "pageId": "p01_home",
      "name": "开场页",
      "kind": "hero",                              // -> 渲染端映射到 hero.tsx
      "content": {
        "title":    { "ref": "defs/font_title", "copy": true, "value": "你的品牌" },
        "subtitle": { "copy": true, "value": "" },
        "bgColor":  { "ref": "defs/color_primary" }
      },
      "animations": [
        { "target": "title", "effect": "fadeUp", "delay": 0.2, "duration": 0.8, "ease": "easeOut" }
      ]
    }
  ]
}
```

### 3.3 导入展开后的页文件（工程内部形态）

每页头部**完整拷贝全部**共享定义（深拷贝 + 键并存，此后各页自治），之后只引用本地：

```jsonc
{
  "schemaVersion": "1",
  "pageId": "p01_home",
  "name": "开场页",
  "kind": "hero",
  "$defs": {                                       // ← 自共享池完整拷贝全部定义，此后本页自治（示意展示两个）
    "color_primary": { "type": "color", "value": "#4F46E5" },
    "font_title":    { "type": "font", "family": "Noto Sans SC", "weight": 800 }
  },
  "content": {
    "title":    { "ref": "defs/font_title", "copy": true, "value": "你的品牌" },
    "subtitle": { "copy": true, "value": "" },
    "bgColor":  { "ref": "defs/color_primary" }
  },
  "animations": [ ]
}
```

> 拷贝范围 = `$shared` 的**全部定义**（不是仅用到的键），与 README「完整拷贝一份全局定义」一致：即使某页暂时用不到的默认样式也一并携带，从此改任一定义绝不波及其他页。
> 内容节点必须有稳定 ID。见 §3.5 `cid`。

### 3.4 定义（Definition）模型与去重/冲突算法

**定义项** `{ key, def }`，其中 `def = { "type": …, …值字段 }`。类型枚举：`color | font | spacing | radius | animation | asset | text_style`（v1 清单，可扩展）。

**Key 作用域：每页 `$defs` 内必唯一；整体交换配置内（`$shared` + 所有页）全局限一。**

| 场景 | 处理 |
|---|---|
| 不同页同 key 同值 | 合并回共享池，保留原 key（1 份）|
| 不同页同 key 异值 | **先出现页保留原 key，后出现页重命名** `<原key>_<pageId>`，两版都进共享池 |
| 单页内 key 冲突 | 导入/覆盖时直接报错（不让 AI 生成物带着歧义进入工程）|
| 重命名后仍撞车 | 追加 `_<pageId>` 已保证唯一（pageId 全局唯一），无需再处理 |

**一致规则（README 例 `color_primary_p2` 的规范化版本）：** 后缀取完整 `pageId`，如 `color_primary_p02_feature`。确定性、可读、永不冲突。

**同步规则表（$shared 与各页 $defs 的权威关系；$shared 仅在"整体交换配置"中出现，工程文件内不保留）：**

| 操作 | 对各页 $defs 的作用 | 对 $shared 的作用 |
|---|---|---|
| 导入展开（交换配置→工程文件） | 深拷贝 $shared **全部定义**进每页 $defs（完整拷贝）| 展开摊平后**不再写入工程文件** |
| 单页覆盖导入（页区块→工程文件） | 整页暴力替换（含本地 $defs）| 无（下次导出整体配置时重投影）|
| 导出整体配置（工程文件→交换配置） | 不动 | **重新 dedup 扫描各页 $defs 生成新 $shared** |
| 渲染 / 校验 | 以各页本地 $defs 为准（不读 $shared）| 不读 |

> 关键语义：**shared 永远只是各页的"汇总投影"，不是各页的数据源**；数据源永远是各页自己的 `$defs`。这样单页编辑（AI 单页导出→改→覆盖）永远不需要"找共享池算账"，全自动由 dedup 重投影吸收。

### 3.5 内容节点 ID（cid）与占位符寻址

- 每个内容节点在 schema 中声明 `cid`（如 `c0001`），导入时若缺失则自动补齐（`c` + 4 位随机 hex）。**占位符/动画一律用 `cid` 寻址，绝不用数组下标**（下标在 AI 编辑后漂移）。
- 占位符地址 = `{ pageId, cid, field }`。

### 3.6 文案框架（copy skeleton）格式

由 schema 中 `"copy": true` 的字段生成（内容值空/预设示例文本均可，**由 schema 声明而非实例标记**，AI 按 schema 就知道哪些是可填充文案）：

```jsonc
{
  "schemaVersion": "1",
  "kind": "copy-skeleton",
  "pages": [
    {
      "pageId": "p01_home", "name": "开场页",
      "items": [
        { "pageId": "p01_home", "cid": "c0001", "field": "value", "kind": "text",
          "label": "主标题", "sample": "你的品牌", "placeholder": "一句话介绍品牌" }
      ]
    }
  ]
}
```

填回时按 `pageId+cid+field` 定位替换，只做类型校验，不碰任何设计字段。

### 3.7 组件模型

```jsonc
// components/card_feature.json
{
  "schemaVersion": "1",
  "componentId": "card_feature",
  "name": "特性卡片",
  "$defs": { "spacing_card": { "type": "spacing", "value": 16 } },   // 组件自带定义
  "code": { "nodeType": "flex", "children": [ /* 内容片段，可含 {slot.icon} 插槽 */ ] },
  "copy": [ "title", "desc" ]                                         // 组件内可填充文案路径
}
```

- 页面 `content` 中可 `{ "component": "card_feature", "slot": {...} }` 引用。
- **「复制代码到页面」**＝ 把 `code` 深拷贝进页内容、把组件 `$defs` 并入页 `$defs`（键冲突时沿用 §3.4 改名规则）、移除 `component` 引用，随后该页与组件彻底断开，可自由搜索替换。

### 3.8 资产引用模型（不入包）

图片、字体等二进制**从不写入工程文件**，只存引用。示例（出现在 `content` 等字段中）：

```jsonc
"logo":     { "cid": "c0005", "type": "asset", "kind": "image",
              "src": "https://cdn.example.com/logo.png" },   // http(s) 引用
"bgImage":  { "cid": "c0006", "type": "asset", "kind": "image",
              "src": "./assets/bg_01.png" },                 // 相对工程文件的本地路径，无 URL 也能离线
"font_body":{ "type": "font", "family": "Noto Sans SC",
              "src": "https://fonts.gstatic.com/..." }       // src 可省略，退化为系统字体兜底
```

规则：
- **只存引用、不存字节**：导入不吸入、导出不携带，工程文件始终纯文本可读。
- **解析时机**：渲染/`assets check` 时解析——`http(s)://` 下载到本地渲染缓存目录（可按工程 id 隔离）；相对路径按工程文件所在位置解析；字体按 `family` 走系统字体兜底。
- **失效检测前置**：`uragan assets check` 提前暴露失效引用（网络不可达 / 路径不存在 / 字体缺失），避免出片中途才发现。
- **离线资产约定**：需要"可离线复用的资产"时，把文件放在工程文件旁的 `assets/` 目录，以相对路径引用即可——文件仍独立在工程外，配置仍单文件可读。

---

## 4. Core 模块设计

```
packages/core/src
├── schema/           # zod schema（含 schemaVersion 校验 + 迁移器注册表）
├── parser/           # JSON/JSONC 解析；$ref 解析与非法跨页引用拦截
├── expander/         # 导入展开：$shared → 各页 $defs 深拷贝；cid 补齐
├── dedup/            # 导出整体配置：去重 + 冲突重命名（§3.4）+ $shared 重投影
├── copy/             # 文案框架导出 / 填回 / 校验（cid 寻址）
├── inline/           # 组件内联（复制代码到页面）
├── validate/         # 三段校验：结构 / 引用 / 语义（输出双格式报告）
├── store/            # 单文件读写、pages 顺序维护、单页抽出/替换、资产引用解析（§3.8）
└── engine.ts         # 门面：把所有能力串成 6 步闭环 API
```

**校验报告（双格式）：**

```jsonc
// JSON 格式（MCP 直接用）
{ "ok": false, "level": "error",
  "errors": [
    { "code": "U-1021", "severity": "error", "path": "pages[1].content.title",
      "message": "引用 defs/color_primary 未在本地 $defs 中定义",
      "hint": "导入展开后禁止跨页引用" }
  ] }
```

CLI 将同一报告渲染为人类可读文本（`U-1021 error: …建议: …`）。错误码区间：`U-1xxx` 结构、`U-2xxx` 引用、`U-3xxx` 语义、`U-9xxx` 文件/IO。

---

## 5. CLI 命令面（= MCP 工具面 = core 能力面）

| CLI | MCP tool | 对应工作流步骤 |
|---|---|---|
| `uragan init <dir> [--canvas WxH]` | `project_new` | 0（建工程）|
| `uragan import <config.json> -p <out.uragan>` | `project_import` | 2 导入展开 |
| `uragan export config -o config.json` | `project_export` | 导出整体交换配置（dedup 重投影，README 导出逻辑）|
| `uragan validate <config.json>` | （并入 import）| 1 配置校验 |
| `uragan pages list` | `list_pages` | 3 |
| `uragan pages reorder p03 p01 p02` | `reorder_pages` | 3 选择排序 |
| `uragan page get p01 [-o file.json]` | `page_get` | 单页导出（含头部 $defs）|
| `uragan page overwrite p01 <file.json>` | `page_overwrite` | 单页覆盖导入（暴力覆盖+校验）|
| `uragan copy export -o skeleton.json` | `copy_export` | 4 导出文案框架 |
| `uragan copy import skeleton.json` | `copy_import` | 5 导入填充 |
| `uragan render -o out.mp4` | `render_video` | 6 渲染视频 |
| `uragan assets check` | `assets_check` | 校验资产引用（§3.8）|
| `uragan shared list` | `shared_pool` | 查看共享池 |
| `uragan serve-mcp` | — | 启动 MCP Server（stdio）|

所有命令支持 `--json` 输出（供脚本/AI 使用）与 `--dry-run`（预览不改写）。

---

## 6. 渲染管线（Remotion）

```
uragan render
 1. 读取工程文件（单 JSON）；解析资产引用（§3.8）：http(s) 下载到本地缓存 / 相对路径按工程位置读取
 2. 组装 render-config：页面顺序（pages 数组）、每页时长、canvas、fps
 3. 翻译：每页(kind, $defs, content, animations, cid) → <PageKind/> React 组件
 4. 合成：生成临时 Remotion 工程 src/Root.tsx（按序铺排 <Composition/>）
 5. @remotion/cli render（JSON 驱动）→ out.mp4
```

- **每页时长**：`duration = in(默认0.8s) + hold(默认2.5s) + out(默认0.8s)`，由该页 `animations` 的 max 边界推导，可被 `project.defaults` 与页级 `duration` 覆盖；全片时长 = 各页顺序之和。
- **翻译层**：`render/src/translators/<kind>.tsx`，v1 首批 kind：`hero`、`section`、`grid`（特性卡片组）、`chart`（数字展示）。新增 kind = 新增一个 React 组件 + schema 一段声明，二者以自定义 prop 类型 `{defs, content}` 契约对齐。
- **资产**：按 §3.8 解析引用——http(s) 下载至本地缓存目录、相对路径相对工程文件解析；字体通过 `loadFont`（`@remotion/google-fonts` / 配置引用的 woff2 路径）注入。渲染前可用 `uragan assets check` 提前暴露失效引用。
- **动画**：`animations` 数组 → Remotion 的 `useCurrentFrame`/`spring` 序列；`ease` 枚举映射到 Remotion easing。
- **转场**：v1 简化为"页级 out 动画兼作转场"；`transitions` 表（fade/slide 等页间转场）列为 v1.1 开放项。

---

## 7. MCP Server 设计

- **传输**：stdio（`uragan serve-mcp`）。CLI 优先的形态下，stdio 是最小可用路径，也便于 Agent 直接拉起。
- **能力注记**：`server.setRequestHandler(ListToolsRequestSchema …)` 按 §5 工具表注册；`server.setRequestHandler(CallToolRequestSchema …)` 转发到 core 门面，参数以严格 union 定义（zod 解析，错误以 `isError` 结构返回并附 U 码报告）。
- **输出约定**：所有工具默认返回 JSON（复用校验报告格式），成功时附简短人类可读文本；批量/长任务（render）v1 同步执行，预留 `render_status` 查询式长任务接口（注记文档，异步实现列入 v1.1）。
- **MCP 外工作流建议**（写入 MCP README + 项目说明，让 Agent 能自主闭环）：
  1. `project_import` 导入 AI 生成的配置
  2. `list_pages` → `reorder_pages` 排序
  3. `copy_export` 拿骨架 → 自己填文案 → `copy_import`
  4. `render_video` 出片。若需改单页设计：`page_get` 拿到独立页 → 修改 → `page_overwrite`；若需**整体迭代设计**：`project_export` 导出整体配置 → 修改（继续用 $shared 去重写法）→ `project_import` 重新展开。

---

## 8. 关键流程时序（6 步闭环，含单页场景）

```
[1]生成配置  用户: 开发文档+需求 → AI → 整体交换配置(含 $shared)   【软件外】
[2]导入展开  import → 深拷贝 $shared→每页$defs → 补 cid → 校验(不变量1) → 写工程文件(.uragan)
[3]选择排序  pages list/reorder → pages 数组顺序（单权威）
[4]导出框架  copy export → 骨架JSON（按 schema 的 copy:true 字段）
[5]导入填充  AI 填骨架 → copy import → 按 cid 替换 → 类型校验 → 错误则回传报告
[6]渲染视频  render → 读文件→解析资产引用→翻译→Remotion 合成→mp4
┌ 单页循环 ─────────────────────────────────────────────┐
│ page get p01 → AI 改（含头部$defs 整页独立）→           │
│ page overwrite p01 → 校验 → 下次导出时 dedup 重投影      │
└───────────────────────────────────────────────────────┘
┌ 整体设计循环 ──────────────────────────────────────────┐
│ project_export → AI 整体改（$shared 去重写法）→         │
│ project_import → 重新完整拷贝展开，覆盖各页 $defs        │
└───────────────────────────────────────────────────────┘
```

---

## 9. 测试策略

| 层 | 手段 |
|---|---|
| 往返不变量 | golden test：`import(export(工程文件)) ≡ 工程文件`（各页 $defs + 页面顺序一致）；两方向对称 |
| 冲突重命名 | 构造三页共享/冲突用例，断言键名与 dedup 结果确定且幂等 |
| 本地引用不变量 | 注入跨页引用用例，断言校验器拦截（U-2xxx）|
| 校验器 | 错误码/路径/严重级快照测试 |
| CLI | 命令快照 + 端到端（临时目录跑通 6 步）|
| MCP | 工具契约测试（JSON-RPC 请求→响应结构断言）+ 模拟 Client 端到端 |
| 渲染 | 每 kind 一张基准帧 PNG 对比（后续阶段）；时长/帧率断言 |

---

## 10. 实施路线

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| M0 骨架 | monorepo（pnpm workspace）、strict TS、shared 类型与 zod schema | 五包可构建、schema 全量类型check |
| M1 Core | parser/expander/dedup/validate/store；往返与冲突单测绿 | 往返不变量测试通过 |
| M2 CLI | §5 全部命令 | 手动跑通 [2][3] 步 |
| M3 文案 | copy skeleton 导出/填回/幂等 | 骨架→填充往返测试绿 |
| M4 渲染 | hero/section/grid/chart 翻译器 + Root 合成 + render | 构造样例工程出片 mp4 |
| M5 MCP | 工具注册 + 端到端（模拟 Agent 走完 6 步）| 契约测试绿 |
| M6 打磨 | JSONC 输入、组件内联、单页覆盖、schemaVersion 迁移器 | 文档中列出的边界用例全过 |
| M7 GUI（后续，非阻塞）| 复用 core/CLI 命令面：页面卡片列表 + 拖拽排序、单页编辑/拖回覆盖、预览渲染 | 普通用户不写命令即走完「选页面→填文案→导出视频」|

---

## 11. 开放问题（v1.1+）

1. **页间转场**：`transitions` 表 vs 页级 out 动画。
2. **音频**：背景音乐/配音/字幕轨（剪切轴）是否纳入 v1，若纳入则文案 schema 增加 `audio_dir` 字段。
3. **文案变量**：数字高亮、名称变量（`{{brand}}`）模板能力。
4. **schemaVersion 演进**：先落地迁移器注册表，保证旧工程文件可升级。
5. **异步长任务**：render 改拉模式（`render_status`）以支持超长视频。