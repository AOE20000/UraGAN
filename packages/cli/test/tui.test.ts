import { describe, expect, it } from 'vitest';
import { TuiApp, SHORTCUTS } from '../src/tui/app.js';
import { Uragan } from '@uragan/core';
import {
  clip,
  coerceValue,
  defSummary,
  displayValue,
  editInput,
  fieldKind,
  fieldsOfPage,
  isOpenableProject,
  isTextInputMode,
  lastFmDir,
  moveDown,
  moveUp,
  pageStats,
  rememberFmDir,
  selectedField,
  selectedPage,
  sortFm,
  VIEW_LABEL,
  type TuiSnapshot,
} from '../src/tui/state.js';

function sampleFile() {
  const cfg = {
    schemaVersion: '1',
    project: { id: 'demo', name: '样例工程', canvas: { width: 1280, height: 720, fps: 30 } },
    $shared: { color_primary: { type: 'color', value: '#4F46E5' } },
    pages: [
      { pageId: 'p01_home', name: '开场页', kind: 'hero', content: { title: { cid: 'c0001', copy: true, kind: 'text', value: '你的品牌' }, count: { cid: 'c0042', copy: true, kind: 'number', value: 42 } }, animations: [] },
      { pageId: 'p02_feature', name: '特性页', kind: 'grid', content: { title: { cid: 'c0011', copy: true, kind: 'text', value: '核心特性' } }, animations: [] },
    ],
  };
  return Uragan.importFromText(JSON.stringify(cfg)).file;
}

describe('TUI 状态层（state.ts）', () => {
  const file = sampleFile();
  const snap: TuiSnapshot = { projectPath: 'x.uragan', file, pageIndex: 1, fieldIndex: 0, sub: 'pages', view: 'pages', itemIndex: 0, toast: '' };

  it('moveUp/moveDown 交换页面顺序（不修改 in place）', () => {
    const up = moveUp(sampleFile(), 1);
    expect(up.pages[0]!.pageId).toBe('p02_feature');
    expect(up.pages[1]!.pageId).toBe('p01_home');
    // 首位上移不变量：原引用原样返回（无变化）
    const f0 = sampleFile();
    expect(moveUp(f0, 0)).toBe(f0);
    const d = moveDown(sampleFile(), 0);
    expect(d.pages[0]!.pageId).toBe('p02_feature');
  });

  it('selectedPage / selectedField / fieldsOfPage', () => {
    expect(selectedPage(snap)!.pageId).toBe('p02_feature');
    const fields = fieldsOfPage(selectedPage(snap)!);
    expect(fields.map((f) => f.name)).toEqual(['title']);
    expect(selectedField(snap)!.name).toBe('title');
    expect(fieldsOfPage(undefined)).toEqual([]);
  });

  it('coerceValue 类型转换（text/number/boolean）', () => {
    expect(coerceValue('number', '64')).toEqual({ ok: true, value: 64 });
    expect(coerceValue('number', 'abc').ok).toBe(false);
    expect(coerceValue('boolean', 'true')).toEqual({ ok: true, value: true });
    expect(coerceValue('boolean', 'yes').ok).toBe(false);
    expect(coerceValue('text', '任意串')).toEqual({ ok: true, value: '任意串' });
    expect(coerceValue(undefined, 'hi').ok).toBe(true);
  });

  it('fieldKind / displayValue / clip', () => {
    const f = selectedField({ path: '', file, pageIndex: 0, fieldIndex: 0, sub: 'fields', view: 'pages', itemIndex: 0, toast: '' })!;
    expect(fieldKind(f.field)).toBe('text');
    expect(displayValue(f.field)).toBe('你的品牌');
    const count = fieldsOfPage(file.pages[0]!)[1]!;
    expect(fieldKind(count.field)).toBe('number');
    expect(displayValue({ cid: 'x', kind: 'text' })).toBe('（未填）');
    expect(clip('1234567890', 7)).toBe('123456…');
    expect(clip('短', 7)).toBe('短');
  });
});

describe('TUI 快捷键清单（SHORTCUTS 完整、不简写、无「骨架」）', () => {
  it('全部功能名完整展开且不使用「骨架」翻译', () => {
    const names = SHORTCUTS.map((s) => s.t);
    for (const expectName of ['导出文案框架', '导入文案', '渲染视频', '导出整体配置', '导入配置', '校验', '资产体检', '打开工程', '新建工程', '关闭工程', '退出']) {
      expect(names).toContain(expectName);
    }
    // 不允许出现「骨架」
    expect(names.join('')).not.toContain('骨架');
    // 键唯一且都非空
    expect(new Set(SHORTCUTS.map((s) => s.k)).size).toBe(SHORTCUTS.length);
    for (const s of SHORTCUTS) expect(s.t.length).toBeGreaterThan(1);
  });
});

describe('TUI 视图（VIEW_LABEL 5 个齐全）', () => {
  it('页面/共享池/组件/资产/信息 视图齐全', () => {
    expect(Object.keys(VIEW_LABEL).sort()).toEqual(['assets', 'components', 'info', 'pages', 'shared'].sort());
    expect(VIEW_LABEL.pages).toBe('页面');
    expect(VIEW_LABEL.shared).toBe('共享池');
    expect(VIEW_LABEL.components).toBe('组件');
    expect(VIEW_LABEL.assets).toBe('资产');
    expect(VIEW_LABEL.info).toBe('信息');
  });

  it('TuiApp 组件可导入（供真实终端渲染）', () => {
    expect(typeof TuiApp).toBe('function');
  });
});

describe('TUI 输入态（editInput / isTextInputMode）', () => {
  it('editInput：中文 IME 整词上屏全插入、左右移光标、退格删光标前、控制键忽略', () => {
    // 中文整词（多个字符）在光标处插入，光标后移整词长度
    expect(editInput('ab', 1, '中文', {})).toEqual({ text: 'a中文b', cursor: 3 });
    expect(editInput('你好世界', 2, 'JSON', {})).toEqual({ text: '你好JSON世界', cursor: 6 });
    // 光标处插入与整词
    expect(editInput('ab', 0, 'X', {})).toEqual({ text: 'Xab', cursor: 1 });
    expect(editInput('ab', 2, 'YZ', {})).toEqual({ text: 'abYZ', cursor: 4 });
    // 左右方向键移动光标（不修改文本）
    expect(editInput('ab', 1, '', { leftArrow: true })).toEqual({ text: 'ab', cursor: 0 });
    expect(editInput('ab', 0, '', { rightArrow: true })).toEqual({ text: 'ab', cursor: 1 });
    // 退格删除光标前一个字符
    expect(editInput('abc', 1, '', { backspace: true })).toEqual({ text: 'bc', cursor: 0 });
    expect(editInput('abc', 0, '', { backspace: true })).toEqual({ text: 'abc', cursor: 0 });
    // Ctrl/Meta 组合键不插入
    expect(editInput('abc', 1, 'z', { ctrl: true })).toEqual({ text: 'abc', cursor: 1 });
    expect(editInput('abc', 1, '', {})).toEqual({ text: 'abc', cursor: 1 });
  });

  it('isTextInputMode：编辑态/会话输入为 true，浏览态为 false', () => {
    expect(isTextInputMode('edit', false)).toBe(true);
    expect(isTextInputMode('fields', true)).toBe(true);
    expect(isTextInputMode('pages', true)).toBe(true);
    expect(isTextInputMode('pages', false)).toBe(false);
    expect(isTextInputMode('fields', false)).toBe(false);
  });
});

describe('TUI 信息展示辅助（defSummary / pageStats）', () => {
  it('defSummary：各定义类型人类可读', () => {
    expect(defSummary({ type: 'color', value: '#4F46E5' })).toBe('#4F46E5');
    expect(defSummary({ type: 'font', family: 'Noto Sans SC', weight: 800 })).toBe('Noto Sans SC 800');
    expect(defSummary({ type: 'spacing', value: 16 })).toBe('16px');
    expect(defSummary({ type: 'asset', kind: 'image', src: './a.png' })).toBe('image: ./a.png');
    expect(defSummary({ type: 'text_style', font: 'f', size: 24, color: '#000' })).toContain('font=f');
    expect(defSummary(null)).toBe('—');
  });

  it('pageStats：字段/可填/动画计数', () => {
    const f = sampleFile();
    expect(pageStats(f.pages[0])).toEqual({ fields: 2, copy: 2, animations: 0 });
    expect(pageStats(undefined)).toEqual({ fields: 0, copy: 0, animations: 0 });
  });
});

describe('TUI 文件管理器（T5：排序 / 可开工程判定 / 上次位置记忆）', () => {
  it('sortFm：目录优先、各自名称字典序', () => {
    const es = sortFm([
      { name: 'b.json', isDir: false, isProject: true },
      { name: 'a', isDir: true, isProject: false },
      { name: 'a.json', isDir: false, isProject: true },
    ]);
    expect(es.map((e) => e.name)).toEqual(['a', 'a.json', 'b.json']);
  });

  it('isOpenableProject：目录 .uragan / 文件 json|jsonc|uragan 可开，其余不可', () => {
    expect(isOpenableProject('promo.uragan', true)).toBe(true);
    expect(isOpenableProject('promo.uragan', false)).toBe(true);
    expect(isOpenableProject('cfg.json', false)).toBe(true);
    expect(isOpenableProject('cfg.jsonc', false)).toBe(true);
    expect(isOpenableProject('notes.txt', true)).toBe(false);
    expect(isOpenableProject('page.png', false)).toBe(false);
  });

  it('lastFmDir/rememberFmDir：内存记忆上次位置，未记住时回退', () => {
    expect(lastFmDir('/fallback')).toBe('/fallback');
    rememberFmDir('/a/b');
    expect(lastFmDir('/fallback')).toBe('/a/b');
  });
});

describe('TUI 页组锁定（整体文件直接移入：页面1动、页面2跟着动）', () => {
  function groupedFile() {
    const f = sampleFile();
    f.pages.push({ pageId: 'p03_extra', name: '外部页', kind: 'chart', $defs: {}, content: { value: { cid: 'c0091', copy: true, kind: 'number', value: 1 } }, animations: [] });
    f.project.pageGroups = [{ id: 'campaign', pages: ['p02_feature', 'p03_extra'] }];
    return f;
  }

  it('上移组内一页 → 整组跟随，组内顺序不变', () => {
    const up = moveUp(groupedFile(), 2);
    expect(up.pages.map((p) => p.pageId)).toEqual(['p02_feature', 'p03_extra', 'p01_home']);
  });

  it('下移组内一页 → 整组跟随；组已在首位/队尾时返回原引用', () => {
    const g = groupedFile(); // [p01, p02(group首), p03(group尾)]
    const down = moveDown(g, 0); // 非组页 p01_home 下移一档（与整组互换）
    expect(down.pages.map((p) => p.pageId)).toEqual(['p02_feature', 'p03_extra', 'p01_home']);
    // 整组上移到队首后，组在首位 → 无法再上移（原引用）
    const tops = moveUp(g, 1); // p02（组首）上移 → 整组道最前
    expect(tops.pages.map((p) => p.pageId)).toEqual(['p02_feature', 'p03_extra', 'p01_home']);
    expect(moveUp(tops, 1)).toBe(tops);
    // p03（组尾）在队尾 → 无法下移（原引用）
    expect(moveDown(g, 2)).toBe(g);
    // 组首在队首 → 无法上移（原引用）
    expect(moveUp(tops, 0)).toBe(tops);
  });

  it('普通（未成组）页面行为不变', () => {
    const f = sampleFile();
    expect(moveUp(f, 1).pages.map((p) => p.pageId)).toEqual(['p02_feature', 'p01_home']);
    expect(moveDown(f, 0).pages.map((p) => p.pageId)).toEqual(['p02_feature', 'p01_home']);
    expect(moveUp(f, 0)).toBe(f);
  });
});