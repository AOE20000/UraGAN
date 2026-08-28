import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/index.js';

/** 协议级端到端：真实 MCP Client ⇄ Server（JSON-RPC over InMemoryTransport）模拟 Agent 走完 6 步 */

let dir: string;
let project: string;
let client: Client;
let server: ReturnType<typeof createServer>;

const SAMPLE = JSON.stringify(
  {
    schemaVersion: '1',
    project: { id: 'demo', name: '样例', canvas: { width: 1280, height: 720, fps: 30 } },
    $shared: {
      color_primary: { type: 'color', value: '#4F46E5' },
      font_title: { type: 'font', family: 'Noto Sans SC', weight: 800 },
    },
    pages: [
      {
        pageId: 'p01_home',
        name: '开场页',
        kind: 'hero',
        content: {
          title: { cid: 'c0001', copy: true, ref: 'defs/font_title', kind: 'text', value: '你的品牌' },
          bgColor: { cid: 'c0002', ref: 'defs/color_primary' },
        },
        animations: [{ target: 'c0001', effect: 'fadeUp', delay: 0.2, duration: 0.8 }],
      },
      {
        pageId: 'p02_feature',
        name: '特性页',
        kind: 'section',
        content: {
          title: { cid: 'c0011', copy: true, ref: 'defs/font_title', kind: 'text', value: '产品特性' },
          bgColor: { cid: 'c0012', ref: 'defs/color_primary' },
        },
        animations: [],
      },
    ],
  },
  null,
  2,
);

/** 提取工具结果文本；isError 时抛错 */
function textOf(result: { content: { type: string; text?: string }[]; isError?: boolean }): string {
  if (result.isError) {
    const t = result.content.map((c) => c.text ?? '').join('\n');
    throw new Error(`工具调用失败（isError=true）：${t}`);
  }
  return result.content.map((c) => c.text ?? '').join('\n');
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'uragan-protocol-'));
  project = join(dir, 'promo.uragan');
  const cfg = join(dir, 'cfg.json');
  writeFileSync(cfg, SAMPLE, 'utf8');

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  server = createServer();
  await server.connect(serverT);
  client = new Client({ name: 'test-agent', version: '0.0.1' }, { capabilities: {} });
  await client.connect(clientT);
});

afterAll(async () => {
  await client.close();
  await server.close();
});

describe('M5 协议端到端（真实 MCP 走完 6 步）', () => {
  it('tools/list：13 个工具齐全', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ['assets_check', 'component_inline', 'component_list', 'copy_export', 'copy_import', 'list_pages', 'page_get', 'page_overwrite', 'project_export', 'project_import', 'project_new', 'project_validate', 'render_video', 'reorder_pages', 'shared_pool'].sort(),
    );
  });

  it('[0] project_new 建工程', async () => {
    const r = await client.callTool({ name: 'project_new', arguments: { path: project, name: '品牌宣传片' } });
    expect(textOf(r)).toContain('已创建空工程');
  });

  it('[2] project_import 导入展开', async () => {
    const r = await client.callTool({ name: 'project_import', arguments: { configPath: join(dir, 'cfg.json'), out: project } });
    expect(textOf(r)).toContain('2 个页面');
  });

  it('[3] list_pages → reorder_pages', async () => {
    const list = await client.callTool({ name: 'list_pages', arguments: { path: project } });
    const listText = textOf(list);
    expect(listText).toContain('p01_home');
    const reorder = await client.callTool({ name: 'reorder_pages', arguments: { path: project, ids: ['p02_feature', 'p01_home'] } });
    const reorderText = textOf(reorder);
    expect(reorderText.indexOf('p02_feature')).toBeLessThan(reorderText.indexOf('p01_home'));
  });

  it('[4][5] copy_export → 填充 → copy_import', async () => {
    const sk = await client.callTool({ name: 'copy_export', arguments: { path: project } });
    const skeleton = JSON.parse(textOf(sk)) as { pages: { items: { cid: string }[] }[] };
    const fill = structuredClone(skeleton);
    for (const p of fill.pages) {
      for (const item of p.items) if (item.cid === 'c0001' || item.cid === 'c0011') (item as { value?: string }).value = '全新品牌';
    }
    const r = await client.callTool({ name: 'copy_import', arguments: { path: project, skeletonJson: JSON.stringify(fill) } });
    expect(textOf(r)).toContain('文案填充完成');
    const pg = await client.callTool({ name: 'page_get', arguments: { path: project, pageId: 'p02_feature' } });
    expect((JSON.parse(textOf(pg)) as { content: Record<string, { value?: unknown }> }).content.title.value).toBe('全新品牌');
  });

  it('project_export → 整体交换配置（$shared 投影）+ shared_pool', async () => {
    const ex = await client.callTool({ name: 'project_export', arguments: { path: project } });
    const cfg = JSON.parse(textOf(ex)) as { $shared: Record<string, unknown>; pages: unknown[] };
    expect(Object.keys(cfg.$shared)).toEqual(['color_primary', 'font_title']);
    expect(cfg.pages).toHaveLength(2);
    const pool = await client.callTool({ name: 'shared_pool', arguments: { path: project } });
    expect(textOf(pool)).toContain('color_primary');
  });

  it('单页循环：page_get → page_overwrite；渲染相关工具存在且参数合法', async () => {
    const got = await client.callTool({ name: 'page_get', arguments: { path: project, pageId: 'p01_home' } });
    const page = JSON.parse(textOf(got)) as { pageId: string; name: string };
    page.name = '开场页（协议改）';
    const ov = await client.callTool({ name: 'page_overwrite', arguments: { path: project, pageId: 'p01_home', pageJson: JSON.stringify(page) } });
    expect(textOf(ov)).toContain('已覆盖页');
    // 参数校验在协议层生效：缺参 → isError
    const bad = await client.callTool({ name: 'page_get', arguments: {} as never });
    expect(bad.isError).toBe(true);
    // assets_check（无 asset 时通过）
    const assets = await client.callTool({ name: 'assets_check', arguments: { path: project } });
    expect(textOf(assets)).toContain('全部有效');
  });
});