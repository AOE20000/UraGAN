import { describe, expect, it } from 'vitest';
import type { ContentField } from '@uragan/shared';
import type { ProjectFile } from '@uragan/shared';
import type { SceneNode } from '../src/types.js';
import { checkAssets } from '../src/assets.js';
import { pageDuration, totalDuration } from '../src/duration.js';
import { translateProject } from '../src/translate.js';

function sampleFile(): ProjectFile {
  return {
    schemaVersion: '1',
    project: { id: 'demo', name: '样例', canvas: { width: 1280, height: 720, fps: 30 }, defaults: { pageDuration: 2.5 } },
    pages: [
      {
        schemaVersion: '1',
        pageId: 'p01_home',
        name: '开场页',
        kind: 'hero',
        $defs: {
          color_primary: { type: 'color', value: '#4F46E5' },
          color_bg: { type: 'color', value: '#0f172a' },
          font_title: { type: 'font', family: 'Noto Sans SC', weight: 800 },
        },
        content: {
          title: { cid: 'c0001', copy: true, ref: 'defs/font_title', kind: 'text', value: '你的品牌' },
          subtitle: { cid: 'c0002', copy: true, kind: 'text', value: '让视频会说话' },
          bgColor: { cid: 'c0003', ref: 'defs/color_bg' },
          logo: { cid: 'c0004', kind: 'asset', src: './assets/logo.png' },
        },
        animations: [
          { target: 'c0001', effect: 'fadeUp', delay: 0.2, duration: 0.8 },
          { target: 'c0002', effect: 'fadeIn', delay: 0.6, duration: 0.6 },
        ],
        duration: 3,
      },
      {
        schemaVersion: '1',
        pageId: 'p02_feature',
        name: '特性页',
        kind: 'grid',
        $defs: { color_bg: { type: 'color', value: '#0f172a' } },
        content: {
          title: { cid: 'c0011', copy: true, kind: 'text', value: '核心特性' },
          card1_title: { cid: 'c0012', copy: true, kind: 'text', value: '超快渲染' },
          card1_desc: { cid: 'c0013', copy: true, kind: 'text', value: 'Remotion 逐帧精确' },
          card2_title: { cid: 'c0014', copy: true, kind: 'text', value: '配置驱动' },
          card2_desc: { cid: 'c0015', copy: true, kind: 'text', value: '设计与内容解耦' },
        },
        animations: [],
      },
    ],
  };
}

/** 收集场景树中全部 text 节点文本 */
function allTexts(node: SceneNode): string[] {
  const out: string[] = [];
  const walk = (n: SceneNode): void => {
    if (n.type === 'text') out.push(n.text);
    if (n.type === 'box') n.children.forEach(walk);
  };
  walk(node);
  return out;
}

describe('rendered 项目组装（M4 翻译层）', () => {
  it('页面顺序 = pages 顺序，时长按 页级duration + in/out 推导', () => {
    const r = translateProject(sampleFile(), { projectDir: '/proj', assetMapper: (s) => s });
    expect(r.pages.map((p) => p.pageId)).toEqual(['p01_home', 'p02_feature']);
    // p02 无 duration：hold=2.5，动画 max 边界 1.2 < 2.5 → 0.8+2.5+0.8
    expect(r.pages[1]!.duration).toBeCloseTo(4.1);
    // p01 页级 duration=3；动画边界 1.4 < 3 → 0.8+3+0.8
    expect(r.pages[0]!.duration).toBeCloseTo(4.6);
    expect(r.totalDuration).toBeCloseTo(8.7);
    expect(r.canvas).toEqual({ width: 1280, height: 720, fps: 30 });
  });

  it('hero 翻译：标题/副标题/底色解析，cid 保留给动画寻址', () => {
    const r = translateProject(sampleFile());
    const hero = r.pages[0]!.root;
    expect(hero.type).toBe('box');
    expect(hero.style.backgroundColor).toBe('#0f172a'); // bgColor ref → color_bg
    expect(allTexts(hero)).toEqual(['你的品牌', '让视频会说话']);
    // 标题继承 font_title 的 fontFamily/weight
    const title = hero.children[0]!;
    expect(title.style.fontFamily).toBe('Noto Sans SC');
    expect(title.style.fontWeight).toBe(800);
    // 动画 clip 保留到场景
    expect(r.pages[0]!.animations[0]!.target).toBe('c0001');
    expect(r.pages[0]!.animations[1]!.ease).toBe('easeOut');
  });

  it('grid 翻译：cardN_* 字段按序号成卡', () => {
    const r = translateProject(sampleFile());
    const grid = r.pages[1]!.root;
    const boxes = grid.children.filter((c) => c.type === 'box');
    expect(allTexts(grid)).toContain('超快渲染');
    expect(allTexts(grid)).toContain('设计与内容解耦');
    // 卡片容器（wrapper 之后）两张卡
    const wrapper = boxes.find((b) => b.type === 'box' && b.style.width === '100%');
    const cards = (wrapper?.type === 'box' ? wrapper.children : []).filter((c) => c.type === 'box');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.style.width).toBe('48%');
  });

  it('相对路径资产按 projectDir 解析，URL 原样', () => {
    const r = translateProject(sampleFile(), { projectDir: '/proj' });
    const logo = r.pages[0]!.root.children.find((c) => c.type === 'image');
    expect(logo?.type === 'image' ? logo.src : undefined).toBe('/proj/assets/logo.png');
  });
});

describe('时长推导（duration.ts）', () => {
  it('动画边界超过 hold 时延长页面', () => {
    const f = sampleFile();
    const p = f.pages[1]!;
    p.duration = undefined;
    p.animations = [{ target: 'x', effect: 'fadeUp', delay: 4, duration: 2 }];
    expect(pageDuration(p, f.project)).toBeCloseTo(0.8 + 6 + 0.8);
  });
  it('totalDuration = 各页之和', () => {
    expect(totalDuration(sampleFile())).toBeCloseTo(8.7);
  });
});

describe('资产检查（assets check）', () => {
  it('本地相对路径缺失 → U-5001 error，存在则通过', async () => {
    const f = sampleFile();
    const r = await checkAssets(f, '/definitely/not/exists');
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'U-5001')).toBe(true);
  });

  it('URL 资产无法探测 → U-5003 warning（不硬判错）', async () => {
    const f = sampleFile();
    const logo: ContentField = { cid: 'c0004', kind: 'asset', src: 'http://127.0.0.1:1/nope.png' };
    f.pages[0]!.content.logo = logo;
    const r = await checkAssets(f, '/proj');
    expect(r.issues.filter((i) => i.code === 'U-5003').length).toBeGreaterThan(0);
  });
});