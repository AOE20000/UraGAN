import { describe, expect, it } from 'vitest';
import type { ExchangeConfig, Page, ProjectFile } from '@uragan/shared';
import { SCHEMA_VERSION } from '@uragan/shared';
import { Uragan, expandExchange, exportSkeletonText, parseSkeletonText, registerMigration, validateProjectFile, validateExchange } from '../src/index.js';

/** 构造一个标准交换配置：$shared + 两页，页面引用共享键 */
function sampleExchange(): ExchangeConfig {
  return {
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
  };
}

/** 导入展开 → 工程文件 */
function toFile(config: ExchangeConfig): ProjectFile {
  const { file, report } = expandExchange(config);
  expect(report.ok).toBe(true);
  return file;
}

describe('导入展开（[2]）', () => {
  it('完整拷贝全部 $shared 定义到每页 $defs（即使本页未用到）', () => {
    const file = toFile(sampleExchange());
    const page = file.pages[0]!;
    expect(Object.keys(page.$defs)).toEqual(['color_primary', 'font_title']);
    expect(page.$defs.color_primary).toEqual({ type: 'color', value: '#4F46E5' });
    // 独立副本：修改一页定义不影响另一页
    file.pages[0]!.$defs.color_primary = { type: 'color', value: '#000000' };
    expect(file.pages[1]!.$defs.color_primary).toEqual({ type: 'color', value: '#4F46E5' });
  });

  it('缺 cid 的 copy 字段自动补齐，校验通过', () => {
    const cfg = sampleExchange();
    delete cfg.pages[0]!.content.title.cid;
    const { file, report } = expandExchange(cfg);
    expect(report.ok).toBe(true);
    expect(file.pages[0]!.content.title.cid).toBeTruthy();
    expect(validateProjectFile(file).ok).toBe(true);
  });

  it('交换配置 ref 未命中 $shared → U-2001', () => {
    const cfg = sampleExchange();
    cfg.pages[0]!.content.title.ref = 'defs/nonexistent';
    const { report } = expandExchange(cfg);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === 'U-2001')).toBe(true);
  });
});

describe('本地引用不变量（[2]后禁止跨页引用）', () => {
  it('ref 指向本页 $defs 之外的键 → U-2001', () => {
    const file = toFile(sampleExchange());
    delete file.pages[0]!.$defs.font_title;
    file.pages[0]!.content.title.ref = 'defs/font_title'; // 现在本地缺失
    const report = validateProjectFile(file);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === 'U-2001' && e.path.includes('title'))).toBe(true);
  });

  it('pageId 重复 → U-3001', () => {
    const file = toFile(sampleExchange());
    file.pages[1]!.pageId = 'p01_home';
    expect(validateProjectFile(file).errors.some((e) => e.code === 'U-3001')).toBe(true);
  });
});

describe('往返不变量（导出↔导入一轮恒等，无冲突前提下）', () => {
  it('export(import) → 页面 $defs/内容/顺序 与源工程一致', () => {
    const file = toFile(sampleExchange());
    const { config } = Uragan.exportConfig(file);
    const { file: back, report } = Uragan.importFromText(JSON.stringify(config));
    expect(report.ok).toBe(true);
    expect(back.pages.map((p) => p.pageId)).toEqual(file.pages.map((p) => p.pageId));
    expect(back.pages[0]!.$defs).toEqual(file.pages[0]!.$defs);
    expect(back.pages[1]!.$defs).toEqual(file.pages[1]!.$defs);
    expect(back.pages[0]!.content).toEqual(file.pages[0]!.content);
  });

  it('导出幂等：重复导出结果一致', () => {
    const file = toFile(sampleExchange());
    const a = JSON.stringify(Uragan.exportConfig(file).config);
    const b = JSON.stringify(Uragan.exportConfig(file).config);
    expect(a).toEqual(b);
  });
});

describe('冲突重命名（README 导出逻辑）', () => {
  function conflictedFile(): ProjectFile {
    const file = toFile(sampleExchange());
    // 页 p02 独立修改 color_primary → 与 p01（保留原键）产生冲突
    file.pages[1]!.$defs.color_primary = { type: 'color', value: '#FF5722' };
    return file;
  }

  it('冲突值 → 后出现页重命名 <key>_<pageId>，先出现页保留原键', () => {
    const file = conflictedFile();
    const { config } = Uragan.exportConfig(file);
    expect(config.$shared.color_primary).toEqual({ type: 'color', value: '#4F46E5' });
    expect(config.$shared.color_primary_p02_feature).toEqual({ type: 'color', value: '#FF5722' });
    // 冲突页的引用被改写
    expect(config.pages[1]!.content.bgColor.ref).toBe('defs/color_primary_p02_feature');
    // 无冲突页引用不变
    expect(config.pages[0]!.content.bgColor.ref).toBe('defs/color_primary');
  });

  it('重命名后可再次导入展开，语义保真（ref 命中、值不变）', () => {
    const file = conflictedFile();
    const { config } = Uragan.exportConfig(file);
    const { file: back, report } = Uragan.importFromText(JSON.stringify(config));
    expect(report.ok).toBe(true);
    expect(back.pages[0]!.$defs.color_primary).toEqual({ type: 'color', value: '#4F46E5' });
    expect(back.pages[0]!.$defs.color_primary_p02_feature).toEqual({ type: 'color', value: '#FF5722' });
    expect(back.pages[1]!.content.bgColor.ref).toBe('defs/color_primary_p02_feature');
    expect(validateProjectFile(back).ok).toBe(true);
  });

  it('重命名确定性：两次导出 JSON 一致', () => {
    const file = conflictedFile();
    const a = JSON.stringify(Uragan.exportConfig(file).config);
    const b = JSON.stringify(Uragan.exportConfig(file).config);
    expect(a).toEqual(b);
  });
});

describe('文案框架（[4][5]）', () => {
  it('按 schema copy:true 生成占位符，填充后回写且不碰设计字段', () => {
    const file = toFile(sampleExchange());
    const { skeleton } = Uragan.exportSkeleton(file);
    const items = skeleton.pages.flatMap((p) => p.items);
    expect(items).toHaveLength(2); // 两页各 1 个 copy 字段；bgColor 非 copy
    const title = items.find((i) => i.cid === 'c0001')!;
    title.value = '全新品牌名';
    const { file: next, report } = Uragan.applySkeleton(file, skeleton);
    expect(report.ok).toBe(true);
    expect(next.pages[0]!.content.title.value).toBe('全新品牌名');
    expect(next.pages[0]!.content.bgColor.ref).toBe('defs/color_primary'); // 设计字段不受影响
  });

  it('类型不符 → U-3004 且不写入', () => {
    const file = toFile(sampleExchange());
    const { skeleton } = Uragan.exportSkeleton(file);
    skeleton.pages[0]!.items[0]!.value = 12345 as unknown as string;
    const { file: next, report } = Uragan.applySkeleton(file, skeleton);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === 'U-3004')).toBe(true);
    expect(next.pages[0]!.content.title.value).toBe('你的品牌');
  });
});

describe('页面操作（[3] + 单页循环）', () => {
  const file = toFile(sampleExchange());

  it('reorder 调整播放顺序', () => {
    const { file: r, report } = Uragan.reorder(file, ['p02_feature', 'p01_home']);
    expect(report.ok).toBe(true);
    expect(r.pages.map((p) => p.pageId)).toEqual(['p02_feature', 'p01_home']);
  });

  it('reorder 未知 id → U-3008', () => {
    const { report } = Uragan.reorder(file, ['nope']);
    expect(report.errors.some((e) => e.code === 'U-3008')).toBe(true);
  });

  it('page get / overwrite：单页覆盖后本地引用仍成立', () => {
    const page: Page = {
      schemaVersion: '1',
      pageId: 'p03_new',
      name: '新增页',
      kind: 'chart',
      $defs: structuredClone(file.pages[0]!.$defs),
      content: { number: { cid: 'c0021', copy: true, kind: 'number', value: 42 } },
      animations: [],
    };
    const { file: next, report } = Uragan.overwritePage(file, page);
    expect(report.ok).toBe(true);
    expect(next.pages).toHaveLength(3);
    expect(validateProjectFile(next).ok).toBe(true);
  });
});

describe('组件内联（复制代码到页面）', () => {
  it('并入组件 code 与 $defs，键冲突自动重命名', () => {
    const file = toFile(sampleExchange());
    file.components = [
      {
        schemaVersion: '1',
        componentId: 'card_feature',
        name: '特性卡片',
        $defs: { color_primary: { type: 'color', value: '#FF0000' }, spacing_card: { type: 'spacing', value: 16 } },
        code: { nodeType: 'flex', text: '标题 {slot.title}', padding: '{slot.pad}' },
      },
    ];
    file.pages[0]!.content.card = { cid: 'c0009', component: 'card_feature', slot: { title: '你好', pad: 8 } };
    const { file: next, report } = Uragan.inlineComponent(file, 'p01_home', 'card_feature');
    expect(report.ok).toBe(true);
    const card = next.pages[0]!.content.card;
    expect(card.value).toEqual({ nodeType: 'flex', text: '标题 你好', padding: 8 });
    // 冲突定义被重命名，另一个被并入
    expect(next.pages[0]!.$defs.color_primary_p01_home).toEqual({ type: 'color', value: '#FF0000' });
    expect(next.pages[0]!.$defs.spacing_card).toEqual({ type: 'spacing', value: 16 });
  });
});

describe('交换配置校验（导入边界）', () => {
  it('validateExchange：ref 缺失 → U-2001', () => {
    const cfg = sampleExchange();
    cfg.pages[0]!.content.bgColor.ref = 'defs/missing';
    const report = validateExchange(cfg);
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === 'U-2001')).toBe(true);
  });
});

describe('M6 打磨：JSONC 输入 + schemaVersion 迁移器', () => {
  it('JSONC 注释/尾逗号可直接导入（存储形态直接可读可改）', () => {
    const text = [
      '{',
      '  // 行注释：品牌宣传片',
      '  "schemaVersion": "1",',
      '  "project": { "id": "demo", "name": "样例",',
      '    "canvas": { "width": 1280, "height": 720, "fps": 30 } },',
      '  "$shared": { /* 块注释 */ "color_primary": { "type": "color", "value": "#4F46E5" } },',
      '  "pages": [',
      '    { "pageId": "p01_home", "name": "开场页", "kind": "hero",',
      '      "$defs": { "color_primary": { "type": "color", "value": "#4F46E5" } },',
      '      "content": { "title": { "cid": "c0001", "kind": "text", "value": "你好" } },',
      '      "animations": []',
      '    }',
      '  ]',
      '}',
    ].join('\n');
    const { file, report } = Uragan.importFromText(text);
    expect(report.ok).toBe(true);
    expect(file.pages).toHaveLength(1);
  });

  it('迁移器链式升级：v0 → v1 生效后导入成功', () => {
    registerMigration({
      from: '0',
      to: '1',
      migrate: (d) => ({ ...(d as Record<string, unknown>), schemaVersion: SCHEMA_VERSION }),
    });
    const old = sampleExchange() as ExchangeConfig & { schemaVersion: string };
    old.schemaVersion = '0';
    const r = Uragan.importFromText(JSON.stringify(old));
    expect(r.report.ok).toBe(true);
    expect(r.file.schemaVersion).toBe('1');
  });

  it('未知 schemaVersion 且无迁移器 → U-1009 拦截', () => {
    const cfg = sampleExchange() as ExchangeConfig & { schemaVersion: string };
    cfg.schemaVersion = '99';
    const { report } = Uragan.importFromText(JSON.stringify(cfg));
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === 'U-1009')).toBe(true);
  });
});

describe('文案框架文本形态（§3.9 Markdown 兼容层）', () => {
  function fileWith(): ProjectFile {
    const f = toFile(sampleExchange());
    // 多行 number 字段，便于围栏验证
    f.pages[0]!.content.count = { cid: 'c0042', copy: true, kind: 'number', value: 42 };
    f.pages[1]!.content.desc = { cid: 'c0043', copy: true, kind: 'text', value: undefined };
    return f;
  }

  it('导出 Markdown 无 JSON 符号：表格 + 中文列 + 填写空列; 占位符数一致', () => {
    const { text, report } = exportSkeletonText(fileWith());
    expect(report.ok).toBe(true);
    expect(text).toContain('# 文案框架');
    expect(text).toContain('## 页面 p01_home · 开场页（hero）');
    expect(text).toContain('| c0001 |');
    // 无花括号/双引号语法（占位内容里的引号除外——样例无）
    expect(text).not.toMatch(/[{}]/);
    expect(text.split('\n').filter((l) => /^\| c/.test(l))).toHaveLength(4); // c0001 c0011 c0042 c0043
  });

  /** 定位某 cid 的数据行，把行尾「填写」列替换为 fillCell */
  function fillRow(text: string, cid: string, fillCell: string): string {
    const line = text.split('\n').find((l) => l.startsWith(`| ${cid} |`));
    if (!line) throw new Error(`未找到 cid=${cid} 行`);
    const idx = line.lastIndexOf('|');
    const done = line.slice(0, idx) + ` ${fillCell} |`;
    return text.replace(line, done);
  }

  it('往返不变量：填 单行值 → 解析 → applySkeleton 生效', () => {
    const file = fileWith();
    const { text } = exportSkeletonText(file);
    const filled = fillRow(text, 'c0001', '新品牌名');
    const { skeleton, report } = parseSkeletonText(filled);
    expect(report.ok).toBe(true);
    const { file: next, report: r2 } = Uragan.applySkeleton(file, skeleton);
    expect(r2.ok).toBe(true);
    expect(next.pages[0]!.content.title.value).toBe('新品牌名');
    // 未填写的 c0011 保持不变
    expect(next.pages[1]!.content.title.value).toBe('产品特性');
  });

  it('多行/含符号内容走围栏块 f@n，原样往返零转义', () => {
    const file = fileWith();
    const { text } = exportSkeletonText(file);
    // 文末追加一个围栏块，并把 desc 行的填写列指向它
    const block = '```text {:id 1}\n大家好，欢迎观看。\n{"nodeType":"flex","text":"任何符号都不转义"}\n```';
    const filled = fillRow(text + '\n\n' + block, 'c0043', 'f@1');
    const { skeleton, report } = parseSkeletonText(filled);
    expect(report.ok).toBe(true);
    const { file: next, report: r2 } = Uragan.applySkeleton(file, skeleton);
    expect(r2.ok).toBe(true);
    expect(next.pages[1]!.content.desc.value).toBe('大家好，欢迎观看。\n{"nodeType":"flex","text":"任何符号都不转义"}');
  });

  it('number/boolean 类型转换；非法类型报 U-3004', () => {
    const file = fileWith();
    const { text } = exportSkeletonText(file);
    const { skeleton, report } = parseSkeletonText(fillRow(text, 'c0042', '64'));
    expect(report.ok).toBe(true);
    const { file: next } = Uragan.applySkeleton(file, skeleton);
    expect(next.pages[0]!.content.count.value).toBe(64);

    // 在 count 行填入非数字 → U-3004
    const parsed = parseSkeletonText(fillRow(text, 'c0042', 'abc'));
    expect(parsed.report.ok).toBe(false);
    expect(parsed.report.errors.some((e) => e.code === 'U-3004')).toBe(true);
  });

  it('单元格含 | 符号转义 \| 往返；乱填引用 f@99 → U-3023；未闭合围栏 → U-3022', () => {
    const file = fileWith();
    file.pages[0]!.content.title = { cid: 'c0001', copy: true, kind: 'text', value: 'A | B' };
    const { text } = exportSkeletonText(file);
    expect(text).toContain('A \\| B');
    const { skeleton, report } = parseSkeletonText(text);
    expect(report.ok).toBe(true);
    const { file: next } = Uragan.applySkeleton(file, skeleton);
    expect(next.pages[0]!.content.title.value).toBe('A | B');

    const p2 = parseSkeletonText(fillRow(text, 'c0001', 'f@99'));
    expect(p2.report.errors.some((e) => e.code === 'U-3023')).toBe(true);

    const unclosed = parseSkeletonText(text + '\n```text {:id 5}\n未闭合');
    expect(unclosed.report.errors.some((e) => e.code === 'U-3022')).toBe(true);
  });
});