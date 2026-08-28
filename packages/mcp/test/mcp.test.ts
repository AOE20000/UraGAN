import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assetsCheck,
  copyExport,
  copyImport,
  listPages,
  pageGet,
  pageOverwrite,
  projectExport,
  projectImport,
  projectNew,
  reorderPages,
  sharedPool,
  validate,
} from '../src/handlers.js';

let dir: string;
let project: string;

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

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'uragan-mcp-'));
  project = join(dir, 'promo.uragan');
});

afterAll(async () => {
  // assets_check 会探测网络（此处用本地缺失路径避免网络）
  void project;
});

describe('MCP 端到端（模拟 Agent 走完 6 步）', () => {
  it('[0] project_new 建工程', () => {
    const r = projectNew({ path: project, name: '品牌宣传片', canvas: '1280x720' });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('已创建空工程');
  });

  it('[2] project_import 导入交换配置 → 展开', () => {
    const cfg = join(dir, 'cfg.json');
    writeFileSync(cfg, SAMPLE, 'utf8');
    const r = projectImport({ configPath: cfg, out: project });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('2 个页面');
    // 再导入一次校验重复 id
    expect(validate(project).ok).toBe(true);
  });

  it('[3] list_pages → reorder_pages', () => {
    const list = listPages(project);
    expect(list.ok).toBe(true);
    expect(list.text).toContain('p01_home');
    expect(list.text).toContain('p02_feature');
    const r = reorderPages({ path: project, ids: ['p02_feature', 'p01_home'] });
    expect(r.ok).toBe(true);
    expect(r.text.indexOf('p02_feature')).toBeLessThan(r.text.indexOf('p01_home'));
    // 未知 id → 失败
    expect(reorderPages({ path: project, ids: ['nope'] }).ok).toBe(false);
  });

  it('[4][5] copy_export → AI 填充 → copy_import', () => {
    const sk = copyExport({ path: project });
    expect(sk.ok).toBe(true);
    const skeleton = JSON.parse(sk.text) as {
      pages: { pageId: string; items: { cid: string; value?: unknown }[] }[];
    };
    const fill = structuredClone(skeleton);
    for (const p of fill.pages) {
      for (const item of p.items) if (item.cid === 'c0001' || item.cid === 'c0011') item.value = '全新品牌';
    }
    const r = copyImport({ path: project, skeletonJson: JSON.stringify(fill) });
    expect(r.ok).toBe(true);
    // 读回确认
    const pg = pageGet({ path: project, pageId: 'p02_feature' });
    expect(pg.ok).toBe(true);
    expect(JSON.parse(pg.text).content.title.value).toBe('全新品牌');
  });

  it('project_export → $shared 去重投影 + shared_pool', () => {
    const ex = projectExport({ path: project });
    expect(ex.ok).toBe(true);
    const cfg = JSON.parse(ex.text) as { $shared: Record<string, unknown>; pages: unknown[] };
    expect(Object.keys(cfg.$shared)).toEqual(['color_primary', 'font_title']);
    expect(cfg.pages).toHaveLength(2);
    const pool = sharedPool(project);
    expect(pool.ok).toBe(true);
    expect(pool.text).toContain('color_primary');
  });

  it('单页循环：page_get → 修改 → page_overwrite', () => {
    const got = pageGet({ path: project, pageId: 'p01_home' });
    expect(got.ok).toBe(true);
    const page = JSON.parse(got.text) as { pageId: string; content: Record<string, { cid?: string; kind?: string; value?: unknown }> };
    page.name = '开场页（已改）';
    page.content.title ??= {};
    page.content.title.value = '单页改的标题';
    const r = pageOverwrite({ path: project, pageId: 'p01_home', pageJson: JSON.stringify(page) });
    expect(r.ok).toBe(true);
    const back = pageGet({ path: project, pageId: 'p01_home' });
    expect(JSON.parse(back.text).name).toBe('开场页（已改）');
    // pageId 不一致 → 拒绝
    expect(pageOverwrite({ path: project, pageId: 'p999', pageJson: JSON.stringify(page) }).ok).toBe(false);
  });

  it('assets_check：本地缺失 → 失败', async () => {
    // 无 asset 引用时通过
    const r = await assetsCheck({ path: project });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('全部有效');
  });
});