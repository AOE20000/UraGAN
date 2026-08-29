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

/** 页组锁定：目标页所属块（整体文件直接移入时整组跟随；非组页块=仅自身） */
function blockOf(file: ProjectFile, pageId: string | undefined): string[] {
  if (!pageId) return [];
  for (const g of file.project.pageGroups ?? []) if (g.pages.includes(pageId)) return g.pages;
  return [pageId];
}

/** 当前播放顺序 → 页块序列（组保持成块，非组页各自成块） */
function toBlocks(file: ProjectFile): string[][] {
  const ids = file.pages.map((p) => p.pageId);
  const blockFor = new Map<string, string[]>();
  for (const g of file.project.pageGroups ?? []) for (const m of g.pages) blockFor.set(m, g.pages);
  const blocks: string[][] = [];
  const done = new Set<string>();
  for (const id of ids) {
    if (done.has(id)) continue;
    const b = blockFor.get(id) ?? [id];
    blocks.push(b);
    for (const m of b) done.add(m);
  }
  return blocks;
}

/** 块序列 → 新 file（顺序无变化时返回原引用，调用方据此判定“无操作”） */
function rebuild(file: ProjectFile, blocks: string[][]): ProjectFile {
  const ids = blocks.flat();
  const byId = new Map(file.pages.map((p) => [p.pageId, p]));
  if (ids.join('\u0000') === file.pages.map((p) => p.pageId).join('\u0000')) return file;
  return { ...file, pages: ids.map((id) => byId.get(id) as Page) };
}

/** 上移一位（组锁定：整组上移；无变化返回原引用） */
export function moveUp(file: ProjectFile, pageIndex: number): ProjectFile {
  if (pageIndex <= 0) return file;
  const blocks = toBlocks(file);
  const id = file.pages[pageIndex]?.pageId;
  const bi = blocks.findIndex((b) => b.includes(id as string));
  if (bi <= 0) return file;
  const [moved] = blocks.splice(bi, 1);
  blocks.splice(bi - 1, 0, moved as string[]);
  return rebuild(file, blocks);
}

/** 下移一位（组锁定：整组下移；无变化返回原引用） */
export function moveDown(file: ProjectFile, pageIndex: number): ProjectFile {
  if (pageIndex >= file.pages.length - 1) return file;
  const blocks = toBlocks(file);
  const id = file.pages[pageIndex]?.pageId;
  const bi = blocks.findIndex((b) => b.includes(id as string));
  if (bi < 0 || bi >= blocks.length - 1) return file;
  const [moved] = blocks.splice(bi, 1);
  blocks.splice(bi + 1, 0, moved as string[]);
  return rebuild(file, blocks);
}

/** 输入态编辑（T1：光标感知）：左/右移光标、退格删光标前、普通字符（含整词/中文 IME 上屏）在光标处插入 */
export interface CursorEdit {
  text: string;
  cursor: number;
}

export function editInput(
  draft: string,
  cursor: number,
  input: string,
  key: { leftArrow?: boolean; rightArrow?: boolean; backspace?: boolean; ctrl?: boolean; meta?: boolean },
): CursorEdit {
  if (key.leftArrow) return { text: draft, cursor: Math.max(0, cursor - 1) };
  if (key.rightArrow) return { text: draft, cursor: Math.min(draft.length, cursor + 1) };
  if (key.backspace) {
    if (cursor <= 0) return { text: draft, cursor };
    return { text: draft.slice(0, cursor - 1) + draft.slice(cursor), cursor: cursor - 1 };
  }
  // 兼容 IME：中文输入法的整词上屏会给完整 input（可能多字），全部插入，不再按 length===1 限制
  if (input && !key.ctrl && !key.meta) {
    return { text: draft.slice(0, cursor) + input + draft.slice(cursor), cursor: cursor + input.length };
  }
  return { text: draft, cursor };
}

/** 是否处于文本输入态（会话输入 / 字段编辑）——此时全局键（含 1-5 切视图）应全部让位 */
export function isTextInputMode(sub: string, sessionActive: boolean): boolean {
  return sessionActive || sub === 'edit';
}

/* ---------------- 文件管理器（T5：打开改用内置 FM，记忆上次位置） ---------------- */

export interface FmEntry {
  name: string;
  /** TUI 视为可打开的工程：.uragan 目录 / .uragan / .json / .jsonc 文件 */
  isProject: boolean;
  isDir: boolean;
}

/** 排序：目录优先，各自按名称字典序（纯函数，entries 已由 IO 层带 mark） */
export function sortFm(entries: FmEntry[]): FmEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** 是否可打开为工程（新形态：目录工程 .uragan/ 或 配置文件/legacy 单文件） */
export function isOpenableProject(name: string, isDir: boolean): boolean {
  if (isDir) return name.toLowerCase().endsWith('.uragan');
  return /\.(json|jsonc|uragan)$/i.test(name);
}

/** 文件管理器上次位置（进程内存记忆，T5：打开记忆上次目录） */
let fmLastDir: string | undefined;

export function rememberFmDir(dir: string): void {
  fmLastDir = dir;
}

export function lastFmDir(fallback: string): string {
  return fmLastDir ?? fallback;
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