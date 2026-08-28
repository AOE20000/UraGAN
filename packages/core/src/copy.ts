import type { CopyItem, CopySkeleton, ProjectFile, ValidationReport } from '@uragan/shared';
import { CopySkeletonZ, SKELETON_KIND, SCHEMA_VERSION } from '@uragan/shared';
import { issuesReport, okReport } from './report.js';
import { copyFieldsOf } from './validate.js';

export interface SkeletonResult {
  skeleton: CopySkeleton;
  report: ValidationReport;
}

export interface ApplyResult {
  file: ProjectFile;
  report: ValidationReport;
}

/**
 * 导出文案框架（按 pages 顺序生成）：
 * schema 中 copy:true 的内容字段 → CopyItem。sample = 当前值文本。
 */
export function exportSkeleton(file: ProjectFile): SkeletonResult {
  const pages = file.pages.map((page) => ({
    pageId: page.pageId,
    name: page.name,
    items: copyFieldsOf(page).flatMap(({ name, field }): CopyItem[] => {
      const cid = field.cid;
      if (!cid) return []; // cid 缺失由校验器拦截；此处兜底跳过
      if (field.kind === 'color' || field.kind === 'asset') return []; // 仅文本类可填
      const kind = field.kind === 'number' ? 'number' : field.kind === 'boolean' ? 'boolean' : 'text';
      return [
        {
          pageId: page.pageId,
          cid,
          field: 'value',
          kind,
          label: field.label,
          sample: field.value !== undefined ? String(field.value) : undefined,
          placeholder: field.placeholder,
        },
      ];
    }),
  }));

  const skeleton: CopySkeleton = { schemaVersion: SCHEMA_VERSION, kind: SKELETON_KIND, pages };
  return { skeleton, report: okReport() };
}

/**
 * 导入填充：按 pageId+cid+field 定位，替换 value（只做类型校验，不碰设计字段）。
 * 无该 cid / 类型不符 → 记 issue（U-3006 / U-3004），成功项照常写入。
 */
export function applySkeleton(file: ProjectFile, skeleton: CopySkeleton): ApplyResult {
  const out: ValidationReport['errors'] = [];
  const next = structuredClone(file);
  const pageById = new Map(next.pages.map((p) => [p.pageId, p]));
  skeleton.pages.forEach((sp, pi) => {
    const page = pageById.get(sp.pageId);
    if (!page) {
      out.push({ code: 'U-3006', severity: 'error', path: `pages[${pi}].pageId`, message: `文案框架引用了不存在的页 ${sp.pageId}` });
      return;
    }
    sp.items.forEach((item, ii) => {
      const path = `pages[${pi}].items[${ii}]`;
      if (item.value === undefined) return; // 未填充的占位符跳过
      const field = Object.values(page.content).find((f) => f.cid === item.cid);
      if (!field) {
        out.push({ code: 'U-3006', severity: 'error', path, message: `页 ${sp.pageId} 无 cid=${item.cid} 的内容节点` });
        return;
      }
      if (item.kind === 'number' && typeof item.value !== 'number') {
        out.push({ code: 'U-3004', severity: 'error', path: `${path}.value`, message: `期望 number，得到 ${typeof item.value}` });
        return;
      }
      if (item.kind === 'boolean' && typeof item.value !== 'boolean') {
        out.push({ code: 'U-3004', severity: 'error', path: `${path}.value`, message: `期望 boolean，得到 ${typeof item.value}` });
        return;
      }
      if (item.kind === 'text' && typeof item.value !== 'string') {
        out.push({ code: 'U-3004', severity: 'error', path: `${path}.value`, message: `期望 string，得到 ${typeof item.value}` });
        return;
      }
      field.value = item.value;
    });
  });
  const report = out.length > 0 ? issuesReport(out) : okReport();
  return { file: next, report };
}

export const SkeletonZ = CopySkeletonZ;
export type { CopySkeleton };