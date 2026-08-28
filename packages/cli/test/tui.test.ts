import { describe, expect, it } from 'vitest';
import { TuiApp, SHORTCUTS } from '../src/tui/app.js';
import { Uragan } from '@uragan/core';
import {
  appendChar,
  clip,
  coerceValue,
  defaultNewName,
  defSummary,
  displayValue,
  fieldKind,
  fieldsOfPage,
  isTextInputMode,
  moveDown,
  moveUp,
  pageStats,
  selectedField,
  selectedPage,
  sessionIntent,
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

describe('TUI 会话逻辑（O/N 打开新建，纯函数）', () => {
  it('sessionIntent：存在=打开、不存在=缺工程提示、空输入=未输入', () => {
    expect(sessionIntent('a.uragan', true).kind).toBe('open');
    expect(sessionIntent('a.uragan', false).kind).toBe('missing');
    expect(sessionIntent('a.uragan', false).toast).toContain('O 打开');
    expect(sessionIntent('', true).toast).toBe('未输入路径');
  });

  it('defaultNewName：补 .uragan 后缀、去重后缀', () => {
    expect(defaultNewName('proj')).toBe('proj.uragan');
    expect(defaultNewName('proj.uragan')).toBe('proj.uragan');
    expect(defaultNewName('  ')).toBe('project.uragan');
  });
});

describe('TUI 输入态（appendChar / isTextInputMode）', () => {
  it('appendChar：数字/字符追加、退格删除、控制键忽略', () => {
    expect(appendChar('', '1', {})).toBe('1'); // 数字 1 正常追加
    expect(appendChar('12', '3', {})).toBe('123');
    expect(appendChar('123', '4', { backspace: false })).toBe('1234');
    expect(appendChar('123', '', { backspace: true })).toBe('12');
    expect(appendChar('abc', 'x', { ctrl: true })).toBe('abc'); // Ctrl 组合不追加
    expect(appendChar('abc', '', {})).toBe('abc'); // 无输入不追加
    // 多字节/非单字符不追加（如 IME 组合）
    expect(appendChar('a', '中文', {})).toBe('a');
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