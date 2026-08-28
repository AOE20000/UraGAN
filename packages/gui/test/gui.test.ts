import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startGui } from '../src/server.js';

let dir: string;
let project: string;
let base: string;
let close: () => Promise<void>;

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

async function jget(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(base + path);
  return { status: res.status, body: (await res.json()) as unknown };
}
async function jpost(path: string, data: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'uragan-gui-'));
  project = join(dir, 'promo.uragan');
  writeFileSync(join(dir, 'cfg.json'), SAMPLE, 'utf8');
  // 用 core 导入生成工程文件
  const { Uragan } = await import('@uragan/core');
  const { file } = Uragan.importFromText(SAMPLE);
  const { writeProjectFile } = await import('@uragan/core');
  writeProjectFile(project, file);

  const srv = await startGui({ project, port: 0 });
  base = srv.url;
  close = srv.close;
});

afterAll(async () => {
  await close();
});

describe('M7 GUI API（不写命令走完「选页面→填文案→导出视频」的前置步骤）', () => {
  it('GET / 返回页面 HTML', async () => {
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect((await res.text()).includes('UraGAN')).toBe(true);
  });

  it('GET /api/project：页面卡片列表（顺序 = 播放顺序）', async () => {
    const { status, body } = await jget('/api/project');
    expect(status).toBe(200);
    const p = body as { name: string; pages: { pageId: string; kind: string }[] };
    expect(p.name).toBe('样例');
    expect(p.pages.map((x) => x.pageId)).toEqual(['p01_home', 'p02_feature']);
  });

  it('POST /api/reorder：拖拽排序写回', async () => {
    const { status, body } = await jpost('/api/reorder', { ids: ['p02_feature', 'p01_home'] });
    expect(status).toBe(200);
    expect((body as { pages: string[] }).pages).toEqual(['p02_feature', 'p01_home']);
    const after = (await jget('/api/project')).body as { pages: { pageId: string }[] };
    expect(after.pages.map((x) => x.pageId)).toEqual(['p02_feature', 'p01_home']);
  });

  it('GET /api/skeleton → POST /api/skeleton：文案框架导出/填回', async () => {
    const { body } = await jget('/api/skeleton');
    const sk = structuredClone(body);
    for (const p of (sk as { pages: { items: { cid: string }[] }[] }).pages) {
      for (const item of p.items) if (item.cid === 'c0001' || item.cid === 'c0011') (item as { value?: string }).value = '全新品牌';
    }
    const { status } = await jpost('/api/skeleton', sk);
    expect(status).toBe(200);
    const pg = (await jget('/api/page?id=p02_feature')).body as { content: Record<string, { value?: unknown }> };
    expect(pg.content.title.value).toBe('全新品牌');
  });

  it('POST /api/page：单页覆盖', async () => {
    const page = (await jget('/api/page?id=p01_home')).body as { pageId: string; name: string };
    page.name = '开场页（GUI改）';
    const { status } = await jpost('/api/page', page);
    expect(status).toBe(200);
    const back = (await jget('/api/page?id=p01_home')).body as { name: string };
    expect(back.name).toBe('开场页（GUI改）');
  });

  it('GET /api/render/status：初始为 idle；404 未知路由', async () => {
    const { body } = await jget('/api/render/status');
    expect((body as { running: boolean; done: boolean }).running).toBe(false);
    const { status } = await jget('/api/nope');
    expect(status).toBe(404);
  });

  it('GET /api/shared：共享池（dedup 投影）', async () => {
    const { status, body } = await jget('/api/shared');
    expect(status).toBe(200);
    const d = body as { shared: Record<string, unknown> };
    expect(Object.keys(d.shared)).toContain('color_primary');
  });

  it('GET /api/export / POST /api/import：整体配置循环', async () => {
    const ex = await jget('/api/export');
    expect(ex.status).toBe(200);
    const cfg = (ex.body as { config: { $shared: Record<string, unknown>; pages: unknown[] } }).config;
    expect(cfg.pages).toHaveLength(2);

    // 用更简配置覆盖工程
    const mini = JSON.stringify({ schemaVersion: '1', project: { id: 'm', name: '迷你', canvas: { width: 640, height: 360, fps: 30 } }, $shared: { c: { type: 'color', value: '#000' } }, pages: [{ pageId: 'p1', name: '单页', kind: 'chart', content: { value: { cid: 'c1', copy: true, kind: 'number', value: 42 } } }] });
    const imp = await jpost('/api/import', { configText: mini });
    expect(imp.status).toBe(200);
    const after = (await jget('/api/project')).body as { name: string; pages: { pageId: string }[] };
    expect(after.name).toBe('迷你');
    expect(after.pages).toHaveLength(1);
  });

  it('GET /api/components + POST /api/component/inline（复制代码到页面）', async () => {
    // 注入组件到工程
    const { Uragan, readProjectFile, writeProjectFile } = await import('@uragan/core');
    const file = readProjectFile(project).file;
    file.components = [
      {
        schemaVersion: '1',
        componentId: 'card_feature',
        name: '特性卡片',
        $defs: { color_primary: { type: 'color', value: '#FF0000' } },
        code: { nodeType: 'flex', text: '标题 {slot.title}', padding: '{slot.pad}' },
      },
    ] as (typeof file)['components'];
    writeProjectFile(project, file);

    const list = await jget('/api/components');
    expect(list.status).toBe(200);
    expect((list.body as { components: { componentId: string }[] }).components.some((c) => c.componentId === 'card_feature')).toBe(true);

    // p1 页写入组件引用后内联
    const f2 = readProjectFile(project).file;
    f2.pages[0]!.content.cardX = { cid: 'c99', component: 'card_feature', slot: { title: 'T', pad: 8 } };
    writeProjectFile(project, f2);

    const { body } = await jpost('/api/component/inline', { pageId: 'p1', componentId: 'card_feature' });
    expect((body as { ok: boolean }).ok).toBe(true);
    const page = (await jget('/api/page?id=p1')).body as { content: Record<string, { value?: unknown }> };
    expect(page.content.cardX.value).toEqual({ nodeType: 'flex', text: '标题 T', padding: 8 });
  });

  it('POST /api/assets/check：无失效引用时通过', async () => {
    const res = await fetch(base + '/api/assets/check', { method: 'POST' });
    const d = (await res.json()) as { ok: boolean; issues: unknown[] };
    expect(res.status).toBe(200);
    expect(d.ok).toBe(true);
    expect(d.issues).toHaveLength(0);
  });
});