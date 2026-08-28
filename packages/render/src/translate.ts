import { posix } from 'node:path';
import type { Content, ContentField, Page, ProjectFile } from '@uragan/shared';
import { pageDuration } from './duration.js';
import { defToStyle, fieldAssetSrc, fieldStyle, fieldText, resolveDef } from './style.js';
import type {
  PageScene,
  RenderedProject,
  SceneAnimation,
  SceneNode,
  SceneStyle,
  TranslateOptions,
} from './types.js';

export interface TranslateCtx {
  page: Page;
  project: ProjectFile['project'];
  canvas: { width: number; height: number; fps: number };
  mapper: (src: string) => string;
  /** content 字段安全访问（schema record，可能缺失） */
  f: (name: string) => ContentField;
}

const EASE_DEFAULT = 'easeOut';
const ANIM_DURATION_DEFAULT = 0.8;

/** 字段集合按 "前缀N_后缀" 分组（N 决定顺序），供 section/grid 的多条目布局 */
function grouped(content: Content, prefix: string): { index: number; slots: Record<string, ContentField> }[] {
  const byIndex = new Map<number, Record<string, ContentField>>();
  const re = new RegExp(`^${prefix}(\\d+)(?:_(.+))?$`);
  for (const [name, field] of Object.entries(content)) {
    const m = re.exec(name);
    if (!m) continue;
    const idx = Number(m[1]);
    const slot = m[2] ?? 'entry';
    const entries = byIndex.get(idx) ?? {};
    entries[slot] = field;
    byIndex.set(idx, entries);
  }
  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, entries]) => ({ index, slots: entries }));
}

function textNode(id: string | undefined, text: string | undefined, style: SceneStyle = {}): SceneNode | null {
  return text === undefined ? null : { type: 'text', id, text, style };
}

function assetNode(id: string | undefined, src: string | undefined, style: SceneStyle = {}): SceneNode | null {
  return src === undefined ? null : { type: 'image', id, src, style };
}

function box(id: string | undefined, style: SceneStyle, children: SceneNode[]): SceneNode {
  return { type: 'box', id, style, children };
}

/** cid → 动画 clip（对齐页面动画的 delay/duration/ease） */
function clips(page: Page): SceneAnimation[] {
  return page.animations.map((a) => ({
    target: a.target,
    effect: a.effect,
    delay: a.delay ?? 0,
    duration: a.duration ?? ANIM_DURATION_DEFAULT,
    ease: a.ease ?? EASE_DEFAULT,
  }));
}

/* ------------------------------------------------------------------ */
/* 通用：内联组件代码（component 内联后的 value 为 {nodeType, ...}）      */
/* ------------------------------------------------------------------ */

function componentNode(value: unknown): SceneNode | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.nodeType !== 'string') return null;
  const style: SceneStyle = {};
  if (typeof rec.padding === 'number') style.padding = rec.padding;
  const children: SceneNode[] = [];
  if (typeof rec.text === 'string') {
    const t = textNode(undefined, rec.text, style);
    if (t) children.push(t);
  }
  if (Array.isArray(rec.children)) {
    for (const c of rec.children) {
      const n = componentNode(c);
      if (n) children.push(n);
    }
  }
  return box(undefined, style, children);
}

/* ------------------------------------------------------------------ */
/* 各 kind 翻译器                                                       */
/* ------------------------------------------------------------------ */

function translateHero(ctx: TranslateCtx): SceneNode {
  const { page, mapper, f } = ctx;
  const c = page.content;
  const bgColor = f('bgColor');
  const bgImage = f('bgImage');
  const logo = f('logo');
  const style: SceneStyle = { ...fieldStyle(page, bgColor, true), padding: 96, maxWidth: 960 };
  const row: SceneNode[] = [];
  const kicker = textNode(f('kicker').cid, fieldText(f('kicker')), {
    ...fieldStyle(page, f('kicker')),
    fontSize: 22,
    opacity: 0.85,
  });
  if (kicker) row.push(kicker);
  const titleField = c.title ?? c.headline ?? {};
  const title = textNode(titleField.cid, fieldText(titleField), {
    ...fieldStyle(page, titleField),
    fontSize: 72,
    fontWeight: 800,
  });
  if (title) row.push(title);
  const subtitle = textNode(f('subtitle').cid, fieldText(f('subtitle')), {
    ...fieldStyle(page, f('subtitle')),
    fontSize: 28,
    opacity: 0.8,
  });
  if (subtitle) row.push(subtitle);
  const logoNode = assetNode(logo.cid, fieldAssetSrc(logo) ? mapper(fieldAssetSrc(logo)!) : undefined, { maxWidth: 160 });
  if (logoNode) row.push(logoNode);
  const bgImageNode = assetNode(bgImage.cid, fieldAssetSrc(bgImage) ? mapper(fieldAssetSrc(bgImage)!) : undefined, { width: '100%' });
  if (bgImageNode) row.push(bgImageNode);
  void c;
  return box(page.kind, style, row);
}

function translateSection(ctx: TranslateCtx): SceneNode {
  const { page, mapper, f } = ctx;
  const rows = grouped(page.content, 'item').map(({ index, slots }) => {
    const children: SceneNode[] = [];
    const iconField = slots.icon ?? {};
    const titleField = slots.title ?? {};
    const descField = slots.desc ?? {};
    const icon = assetNode(iconField.cid, fieldAssetSrc(iconField) ? mapper(fieldAssetSrc(iconField)!) : undefined, { maxWidth: 48 });
    if (icon) children.push(icon);
    const t = textNode(titleField.cid, fieldText(titleField), {
      ...fieldStyle(page, titleField),
      fontSize: 30,
      fontWeight: 700,
    });
    if (t) children.push(t);
    const d = textNode(descField.cid, fieldText(descField), {
      ...fieldStyle(page, descField),
      fontSize: 20,
      opacity: 0.8,
    });
    if (d) children.push(d);
    return box(`item${index}`, { gap: 8, padding: 12 }, children);
  });
  const header: SceneNode[] = [];
  const title = textNode(f('title').cid, fieldText(f('title')), { ...fieldStyle(page, f('title')), fontSize: 48, fontWeight: 800 });
  if (title) header.push(title);
  const subtitle = textNode(f('subtitle').cid, fieldText(f('subtitle')), { ...fieldStyle(page, f('subtitle')), fontSize: 24, opacity: 0.8 });
  if (subtitle) header.push(subtitle);
  return box(page.kind, { ...fieldStyle(page, f('bgColor'), true), padding: 80, gap: 24 }, [...header, ...rows]);
}

function translateGrid(ctx: TranslateCtx): SceneNode {
  const { page, mapper, f } = ctx;
  const cards = grouped(page.content, 'card').map(({ index, slots }) => {
    const children: SceneNode[] = [];
    const iconField = slots.icon ?? {};
    const titleField = slots.title ?? {};
    const descField = slots.desc ?? {};
    const icon = assetNode(iconField.cid, fieldAssetSrc(iconField) ? mapper(fieldAssetSrc(iconField)!) : undefined, { maxWidth: 56 });
    if (icon) children.push(icon);
    const t = textNode(titleField.cid, fieldText(titleField), {
      ...fieldStyle(page, titleField),
      fontSize: 26,
      fontWeight: 700,
    });
    if (t) children.push(t);
    const d = textNode(descField.cid, fieldText(descField), {
      ...fieldStyle(page, descField),
      fontSize: 18,
      opacity: 0.8,
    });
    if (d) children.push(d);
    return box(`card${index}`, { gap: 10, padding: 24, borderRadius: 12, width: '48%' }, children);
  });
  const title = textNode(f('title').cid, fieldText(f('title')), { ...fieldStyle(page, f('title')), fontSize: 44, fontWeight: 800 });
  const head = title ? [title] : [];
  return box(page.kind, { ...fieldStyle(page, f('bgColor'), true), padding: 80, gap: 20, maxWidth: 1080 }, [
    ...head,
    box(undefined, { width: '100%', gap: 20 }, cards),
  ]);
}

function translateChart(ctx: TranslateCtx): SceneNode {
  const { page, f } = ctx;
  const c = page.content;
  const valueField = c.value ?? Object.values(c).find((x) => x.kind === 'number' || x.kind === 'boolean') ?? {};
  const children: SceneNode[] = [];
  const value = textNode(valueField.cid, fieldText(valueField), {
    fontSize: 128,
    fontWeight: 800,
    ...fieldStyle(page, valueField),
  });
  if (value) children.push(value);
  const label = textNode(f('label').cid, fieldText(f('label')), { ...fieldStyle(page, f('label')), fontSize: 28, opacity: 0.75 });
  if (label) children.push(label);
  const suffix = textNode(f('unit').cid, fieldText(f('unit')), { fontSize: 44, opacity: 0.6 });
  if (suffix) children.push(suffix);
  return box(page.kind, { ...fieldStyle(page, f('bgColor'), true), padding: 96, gap: 8 }, children);
}

function translateByKind(kind: Page['kind'], ctx: TranslateCtx): SceneNode {
  switch (kind) {
    case 'hero':
      return translateHero(ctx);
    case 'section':
      return translateSection(ctx);
    case 'grid':
      return translateGrid(ctx);
    case 'chart':
      return translateChart(ctx);
    default:
      return box(kind, {}, Object.values(ctx.page.content).map(nodeFromField(ctx)));
  }
}

function nodeFromField(ctx: TranslateCtx): (field: ContentField) => SceneNode {
  return (field) => {
    const component = componentNode(field.value);
    if (component) return component;
    const src = fieldAssetSrc(field);
    if (src) return assetNode(field.cid, ctx.mapper(src), {}) ?? box(field.cid, {}, []);
    const t = textNode(field.cid, fieldText(field), fieldStyle(ctx.page, field));
    return t ?? box(field.cid, {}, []);
  };
}

function translatePage(page: Page, project: ProjectFile['project'], mapper: (src: string) => string): PageScene {
  const f = (name: string): ContentField => page.content[name] ?? {};
  const ctx: TranslateCtx = { page, project, canvas: project.canvas, mapper, f };
  const root = translateByKind(page.kind, ctx);
  return {
    pageId: page.pageId,
    name: page.name,
    kind: page.kind,
    duration: pageDuration(page, project),
    root,
    animations: clips(page),
  };
}

/** 整份工程 → 场景图（纯函数，无 IO） */
export function translateProject(file: ProjectFile, opts: TranslateOptions = {}): RenderedProject {
  const mapper: (src: string) => string = (src) => {
    if (/^https?:\/\//i.test(src)) return src;
    const dir = opts.projectDir ?? process.cwd();
    // posix 规范化：跨平台统一正斜杠（浏览器/Remotion 均接受）
    return posix.normalize(`${dir.replace(/\\/g, '/')}/${src}`);
  };
  const pages = file.pages.map((page) => translatePage(page, file.project, mapper));
  return {
    schemaVersion: file.schemaVersion,
    projectId: file.project.id,
    projectName: file.project.name,
    canvas: file.project.canvas,
    totalDuration: pages.reduce((s, p) => s + p.duration, 0),
    pages,
  };
}

/** 单个定义 → 样式（供 assets/其他工具复用） */
export { defToStyle };
export type { SceneNode, SceneStyle } from './types.js';