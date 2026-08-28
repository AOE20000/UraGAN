import type { ProjectFile, ValidationReport } from '@uragan/shared';
import { issuesReport, okReport } from './report.js';

export interface InlineResult {
  file: ProjectFile;
  report: ValidationReport;
}

/**
 * 「复制代码到页面」：把组件 code 内联进目标页、组件 $defs 并入页 $defs、
 * 移除页面中的 component 引用，此后该页与组件彻底断开。
 * v1 实现：页面 content 中形如 { component: "<id>", slot: {...} } 的字段会被
 * code 替换（code 结构体中的 {slot.xxx} 占位以 slot 值填充，支持一级替换）。
 */
export function inlineComponent(file: ProjectFile, pageId: string, componentId: string): InlineResult {
  const page = file.pages.find((p) => p.pageId === pageId);
  if (!page) {
    return { file, report: issuesReport([{ code: 'U-9004', severity: 'error', path: 'pages', message: `页 ${pageId} 不存在` }]) };
  }
  const component = file.components?.find((c) => c.componentId === componentId);
  if (!component) {
    return { file, report: issuesReport([{ code: 'U-9005', severity: 'error', path: 'components', message: `组件 ${componentId} 不存在` }]) };
  }
  const code = structuredClone(component.code) as Record<string, unknown>;

  // 1. $defs 并入（键冲突沿用重命名规则：后来者加 pageId 后缀）
  const out: string[] = [];
  for (const [key, def] of Object.entries(component.$defs)) {
    let k = key;
    if (page.$defs[k] !== undefined && !defsEqualShallow(page.$defs[k], def)) k = `${key}_${pageId}`;
    page.$defs[k] = structuredClone(def);
    if (k !== key) out.push(`${key} → ${k}`);
  }

  // 2. 替换 component 字段
  for (const [name, field] of Object.entries(page.content)) {
    if ((field as Record<string, unknown>).component !== componentId) continue;
    const slot = ((field as Record<string, unknown>).slot ?? {}) as Record<string, unknown>;
    page.content[name] = { cid: field.cid, value: fillSlots(code, slot) };
  }
  if (out.length > 0) {
    return {
      file,
      report: issuesReport([
        { code: 'U-3007', severity: 'warning', path: `pages[${page.pageId}].defs`, message: `组件定义并入时发生键冲突，已重命名：${out.join('、')}` },
      ]),
    };
  }
  return { file, report: okReport() };
}

/** {slot.xxx} 一级插槽填充 */
function fillSlots(code: unknown, slot: Record<string, unknown>): unknown {
  if (typeof code === 'string') {
    // 整个字符串就是一个占位符：直接返回原始值，保留其类型（数字/布尔不会被字符串化）
    const exact = /^\{slot\.([\w.]+)\}$/.exec(code);
    if (exact && slot[exact[1]!] !== undefined) return slot[exact[1]!];
    return code.replace(/\{slot\.([\w.]+)\}/g, (_m, p: string) => (slot[p] !== undefined ? String(slot[p]) : `{slot.${p}}`));
  }
  if (Array.isArray(code)) return code.map((v) => fillSlots(v, slot));
  if (code && typeof code === 'object') {
    const rec = code as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) next[k] = fillSlots(v, slot);
    return next;
  }
  return code;
}

function defsEqualShallow(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type { ValidationReport };