import type { ContentField, Page, ProjectFile } from '@uragan/shared';
import { Uragan } from '@uragan/core';

/**
 * TUI 纯状态与操作（无 React 依赖，便于单测）：
 * 页面列表/选中/移动、字段提取、值类型转换。
 */

/** 左侧主视图 */
export type View = 'pages' | 'shared' | 'components' | 'assets' | 'info';

export interface TuiSnapshot {
  projectPath: string;
  file: ProjectFile;
  pageIndex: number;
  /** details 面板中选中的字段下标 */
  fieldIndex: number;
  /** 子视图：'pages'（页面列表）| 'fields'（字段详情）| 'edit'（正在编辑字段值） */
  sub: 'pages' | 'fields' | 'edit';
  /** 当前左侧主视图 */
  view: View;
  /** 其他视图（shared/components/assets/info）中的选中条目下标 */
  itemIndex: number;
  /** 最近一次操作反馈（空串不显示） */
  toast: string;
}

export function snapshot(projectPath: string, file: ProjectFile): TuiSnapshot {
  return { projectPath, file, pageIndex: 0, fieldIndex: 0, sub: 'pages', view: 'pages', itemIndex: 0, toast: '' };
}

export const VIEW_LABEL: Record<View, string> = {
  pages: '页面',
  shared: '共享池',
  components: '组件',
  assets: '资产',
  info: '信息',
};

export const selectedPage = (s: TuiSnapshot): Page | undefined => s.file.pages[s.pageIndex];

export interface FieldView {
  name: string;
  field: ContentField;
}

export function fieldsOfPage(page: Page | undefined): FieldView[] {
  if (!page) return [];
  return Object.entries(page.content).map(([name, field]) => ({ name, field }));
}

export const selectedField = (s: TuiSnapshot): FieldView | undefined => {
  const fields = fieldsOfPage(selectedPage(s));
  return fields[s.fieldIndex];
};

/** 页面列表用于渲染的摘要 */
export function pageRows(file: ProjectFile) {
  return file.pages.map((p, i) => ({ index: i, page: p, duration: Uragan.listPages(file)[i]?.duration ?? 0 }));
}

/** 上移一位（交换 with 前一项）；已在首位不动。返回新 file（引用不变则无变化） */
export function moveUp(file: ProjectFile, pageIndex: number): ProjectFile {
  if (pageIndex <= 0) return file;
  const pages = [...file.pages];
  const [moved] = pages.splice(pageIndex, 1);
  pages.splice(pageIndex - 1, 0, moved as Page);
  return { ...file, pages };
}

/** 下移一位 */
export function moveDown(file: ProjectFile, pageIndex: number): ProjectFile {
  if (pageIndex >= file.pages.length - 1) return file;
  const pages = [...file.pages];
  const [moved] = pages.splice(pageIndex, 1);
  pages.splice(pageIndex + 1, 0, moved as Page);
  return { ...file, pages };
}

/** 输入态字符处理（自管理 draft）：退格/普通字符/忽略控制键。数字 1-5 等普通字符原样追加。 */
export function appendChar(draft: string, input: string, key: { backspace?: boolean; ctrl?: boolean; meta?: boolean }): string {
  if (key.backspace) return draft.slice(0, -1);
  if (input && input.length === 1 && !key.ctrl && !key.meta) return draft + input;
  return draft;
}

/** 是否处于文本输入态（会话输入 / 字段编辑）——此时全局键（含 1-5 切视图）应全部让位 */
export function isTextInputMode(sub: string, sessionActive: boolean): boolean {
  return sessionActive || sub === 'edit';
}

/** 单行可编辑值 → 磁盘类型（text/number/boolean 转换；失败返回空串表示不可用） */
export function coerceValue(kind: string | undefined, raw: string): { ok: true; value: string | number | boolean } | { ok: false } {
  if (kind === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) && !/\s/.test(raw) ? { ok: true, value: n } : { ok: false };
  }
  if (kind === 'boolean') {
    if (raw === 'true') return { ok: true, value: true };
    if (raw === 'false') return { ok: true, value: false };
    return { ok: false };
  }
  return { ok: true, value: raw };
}

export function fieldKind(field: ContentField): string {
  // 内容字段 value 语义：kind 缺失按值类型推断
  return field.kind ?? (typeof field.value === 'number' ? 'number' : typeof field.value === 'boolean' ? 'boolean' : 'text');
}

export function displayValue(field: ContentField): string {
  const v = field.value;
  if (v === undefined || v === null) return '（未填）';
  if (v === '') return '（空）';
  return String(v);
}

/** 终端宽度安全截断（按显示宽度近似） */
export function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}

/** 会话判定：给定路径是否存在可打开工程（O/N 交互的纯逻辑，便于单测） */
export function sessionIntent(path: string, exists: boolean): { kind: 'open' | 'missing' | 'new'; toast: string } {
  const base = path.replace(/\.uragan$/i, '');
  if (!path.trim()) return { kind: 'open', toast: '未输入路径' };
  if (exists) return { kind: 'open', toast: `已打开 ${base}` };
  return { kind: 'missing', toast: `工程不存在：${path}（按 O 打开 / N 新建）` };
}

/** 新建工程默认名（含 .uragan 规范后缀） */
export function defaultNewName(raw: string): string {
  const base = raw.trim().replace(/\.uragan$/i, '') || 'project';
  return `${base}.uragan`;
}

/** 定义 → 人类可读摘要（信息/共享池/组件视图展示） */
export function defSummary(def: unknown): string {
  const d = def as Record<string, unknown> | undefined;
  if (!d || typeof d !== 'object') return '—';
  switch (d.type) {
    case 'color':
      return String(d.value ?? '');
    case 'font':
      return `${String(d.family ?? '')}${d.weight ? ` ${String(d.weight)}` : ''}`;
    case 'spacing':
      return `${String(d.value ?? 0)}px`;
    case 'radius':
      return `${String(d.value ?? 0)}px`;
    case 'asset':
      return `${String(d.kind ?? '')}: ${String(d.src ?? '')}`;
    case 'animation':
      return `${String(d.effect ?? '')}${d.duration ? ` ${String(d.duration)}s` : ''}`;
    case 'text_style':
      return `font=${String(d.font ?? '—')} size=${String(d.size ?? '—')} color=${String(d.color ?? '—')}`;
    default:
      return String(d.type ?? '—');
  }
}

/** 页面统计：字段数 / 可填文案数 / 动画数 */
export function pageStats(page: Page | undefined): { fields: number; copy: number; animations: number } {
  if (!page) return { fields: 0, copy: 0, animations: 0 };
  const copy = Object.values(page.content).filter((f) => f.copy).length;
  return { fields: Object.keys(page.content).length, copy, animations: page.animations.length };
}