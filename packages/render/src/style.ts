import type { ContentField, Def, Page } from '@uragan/shared';
import { REF_PREFIX } from '@uragan/shared';
import type { SceneStyle } from './types.js';

/** ref = "defs/<key>" → 本页 $defs 中定义（本地引用不变量由校验器保证） */
export function resolveDef(page: Page, ref?: string): Def | undefined {
  if (!ref || !ref.startsWith(REF_PREFIX)) return undefined;
  return page.$defs[ref.slice(REF_PREFIX.length)];
}

/** 定义 → 样式片段（color/font/spacing/radius/text_style/animation 参与渲染） */
export function defToStyle(def?: Def): SceneStyle {
  const s: SceneStyle = {};
  if (!def) return s;
  switch (def.type) {
    case 'color':
      s.color = def.value;
      break;
    case 'font':
      s.fontFamily = def.family;
      if (def.weight) s.fontWeight = def.weight;
      break;
    case 'spacing':
      s.padding = def.value;
      break;
    case 'radius':
      s.borderRadius = def.value;
      break;
    case 'text_style':
      if (def.font) s.fontFamily = def.font;
      if (def.size) s.fontSize = def.size;
      if (def.color) s.color = def.color;
      if (def.weight) s.fontWeight = def.weight;
      if (def.align) s.textAlign = def.align;
      break;
    default:
      break; // animation / asset 由渲染端单独处理
  }
  return s;
}

/**
 * 内容字段 → 样式：先解字段自身 ref 指向的定义，再解 text_style.font 二级引用。
 * 背景色语义：kind==='color' 的字段通常作容器背景，但也可能作文字色；
 * 由调用方通过 asBackground 决定落点，默认按文字色处理。
 */
export function fieldStyle(page: Page, field: ContentField, asBackground = false): SceneStyle {
  const def = resolveDef(page, field.ref);
  let style = defToStyle(def);
  if (def?.type === 'text_style' && def.font) {
    const fontDef = page.$defs[def.font];
    if (fontDef?.type === 'font') {
      style = { ...style, fontFamily: fontDef.family, ...(fontDef.weight ? { fontWeight: fontDef.weight } : {}) };
    }
  }
  if (asBackground && style.color) style = { backgroundColor: style.color, color: undefined };
  return style;
}

/** 内容字段值 → 可渲染文本（text/number/boolean）；无值返回 undefined */
export function fieldText(field: ContentField): string | undefined {
  const v = field.value;
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/** 字段是否为资产（kind asset 且带 src） */
export function fieldAssetSrc(field: ContentField): string | undefined {
  if (field.kind !== 'asset' || typeof field.src !== 'string' || field.src.length === 0) return undefined;
  return field.src;
}