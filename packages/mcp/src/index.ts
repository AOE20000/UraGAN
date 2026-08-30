import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  assetsCheck,
  componentInline,
  componentList,
  copyExport,
  copyImport,
  listPages,
  pageGet,
  pageOverwrite,
  projectExport,
  projectImport,
  projectNew,
  reorderPages,
  renderVideo,
  sharedPool,
  validate,
  type ToolResult,
} from './handlers.js';

export const MCP_READY = true;
export const SERVER_NAME = 'uragan';
export const SERVER_VERSION = '0.1.0';

const pathOpt = () => z.string().optional();

function toResult(res: ToolResult): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  return res.ok
    ? { content: [{ type: 'text' as const, text: res.text }] }
    : { content: [{ type: 'text' as const, text: res.text }], isError: true };
}

/** 注册工具面 = CLI 命令面 = core 能力面（MCP 工具表，设计文档 §5/§7） */
function registerAll(server: McpServer): void {
  const reg = <A extends Record<string, unknown>>(
    name: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
    fn: (args: A) => ToolResult | Promise<ToolResult>,
  ): void => {
    server.registerTool(name, { description, inputSchema }, (async (args: A) => toResult(await fn(args))) as never);
  };

  reg(
    'project_new',
    '创建空白工程（步骤0）：生成 <名字>.uragan 目录工程（每页一个独立文件）',
    { path: pathOpt(), name: z.string().optional(), canvas: z.string().optional(), fps: z.number().optional() },
    (a: { path?: string; name?: string; canvas?: string; fps?: number }) => projectNew(a),
  );

  reg(
    'project_import',
    '用交换配置（$shared 形态）整体创建或覆盖工程（步骤2 导入展开）：可指定输出工程名，也可覆盖已存在的工程。'
      + '与「打开工程」不同 —— 打开 .uragan 单文件是导入到 <名字>.uragan.work 工作目录、原文件保留为持久文件。',
    { configPath: z.string(), out: pathOpt() },
    (a: { configPath: string; out?: string }) => projectImport(a),
  );

  reg(
    'project_export',
    '导出整体交换配置（步骤2 反向）：把各页重复的定义去重投影成 $shared 共享池，'
      + '适合一次性整体改主色/字体等共享值。这只是导出去改的视图，工程本体仍在工程目录里。',
    { path: pathOpt(), out: pathOpt() },
    (a: { path?: string; out?: string }) => projectExport(a),
  );

  reg(
    'project_validate',
    '校验配置文件（交换配置或工程文件）',
    { path: pathOpt() },
    (a: { path?: string }) => validate(a.path),
  );

  reg('list_pages', '按播放顺序列出页面（步骤3）', { path: pathOpt() }, (a: { path?: string }) => listPages(a.path));

  reg('reorder_pages', '调整播放顺序（挑选 + 排序，步骤3）', { path: pathOpt(), ids: z.array(z.string()) }, (a: { path?: string; ids: string[] }) => reorderPages(a));

  reg(
    'page_get',
    '导出单个独立页（含头部 $defs，供 AI 修改）',
    { path: pathOpt(), pageId: z.string(), out: pathOpt() },
    (a: { path?: string; pageId: string; out?: string }) => pageGet(a),
  );

  reg(
    'page_overwrite',
    '用独立页 JSON 暴力覆盖（含 $defs 校验）',
    { path: pathOpt(), pageId: z.string(), pageJson: z.string() },
    (a: { path?: string; pageId: string; pageJson: string }) => pageOverwrite(a),
  );

  reg(
    'copy_export',
    '导出待填充文案框架（format=json 权威形态，format=md 人读文本框架）',
    { path: pathOpt(), out: pathOpt(), format: z.enum(['json', 'md']).optional() },
    (a: { path?: string; out?: string; format?: 'json' | 'md' }) => copyExport(a),
  );

  reg(
    'copy_import',
    '导入已填充文案框架（步骤5）',
    { path: pathOpt(), skeletonJson: z.string() },
    (a: { path?: string; skeletonJson: string }) => copyImport(a),
  );

  reg('shared_pool', '查看共享池 $shared（dedup 导出投影）', { path: pathOpt() }, (a: { path?: string }) => sharedPool(a.path));

  reg('component_list', '列出全局组件', { path: pathOpt() }, (a: { path?: string }) => componentList(a.path));

  reg(
    'component_inline',
    '复制代码到页面：组件 code/$defs 并入目标页，断开父子关系',
    { path: pathOpt(), pageId: z.string(), componentId: z.string() },
    (a: { path?: string; pageId: string; componentId: string }) => componentInline(a),
  );

  reg(
    'assets_check',
    '校验资产引用（渲染前暴露失效引用）',
    { path: pathOpt() },
    (a: { path?: string }) => assetsCheck(a),
  );

  reg(
    'render_video',
    '渲染视频（步骤6，Remotion → mp4）',
    { path: pathOpt(), out: pathOpt(), codec: z.enum(['h264', 'h265', 'vp8', 'vp9']).optional() },
    (a: { path?: string; out?: string; codec?: 'h264' | 'h265' | 'vp8' | 'vp9' }) => renderVideo(a),
  );
}

/** 创建 MCP Server（可供测试实例化；不出网、不连接） */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: [
        'UraGAN 动画视频生成：6 步闭环建议流程如下——',
        '1) project_new 建空白目录工程，或 project_import 用交换配置整体创建/覆盖工程；',
        '2) list_pages → reorder_pages 挑选并排序播放顺序；',
        '3) copy_export 导出文案框架 → 自行填充 → copy_import 填回；',
        '4) render_video 出片。',
        '工程形态：目录工程 <名字>.uragan/（每页一个独立文件）；'
          + '打开 .uragan 单文件时工程实际在 <名字>.uragan.work/ 工作目录中进行，原文件保留为持久文件，改动需显式导出回它。',
        '改单页设计：page_get 拿到独立页 JSON → 修改 → page_overwrite 覆盖（pageId 不存在则追加为新页）；',
        '整体迭代设计：project_export 导出整体交换配置（$shared 去重视图）→ 修改共享值 → project_import 重新展开覆盖工程。',
      ].join('\n'),
    },
  );
  registerAll(server);
  return server;
}

/** 启动 stdio MCP Server（供 `uragan serve-mcp` 或直接运行本包） */
export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}