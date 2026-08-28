import type {
  Content,
  ContentField,
  ExchangeConfig,
  Issue,
  Page,
  ProjectFile,
  ValidationReport,
} from '@uragan/shared';
import { REF_PREFIX } from '@uragan/shared';
import { issuesReport } from './report.js';

/** zod 错误路径 → JSON Pointer 风格字符串（如 pages[0].content.title） */
export function zodPath(keys: readonly (string | number)[]): string {
  return keys
    .map((k) => (typeof k === 'number' ? `[${k}]` : k))
    .join('')
    .replace(/\.\[/g, '[');
}

/** zod safeParse 失败 → 结构类 issue（U-1002），成功返回 [] */
export function zodIssues<T>(parsed: { success: true; data: T } | { success: false; error: unknown }): Issue[] {
  if (parsed.success) return [];
  const err = parsed as unknown as {
    error: { issues?: { path: (string | number)[]; message: string }[] };
  };
  return (err?.error?.issues ?? []).map((e) => issue('U-1002', 'error', zodPath(e.path), e.message));
}

function issue(
  code: string,
  severity: 'error' | 'warning',
  path: string,
  message: string,
  hint?: string,
): Issue {
  return { code, severity, path, message, ...(hint ? { hint } : {}) };
}

/* ------------------------------------------------------------------ */
/* 交换配置语义校验（导入边界）：ref 必须命中 $shared                    */
/* ------------------------------------------------------------------ */

export function validateExchange(config: ExchangeConfig): ValidationReport {
  const out: Issue[] = [];
  const sharedKeys = new Set(Object.keys(config.$shared));
  config.pages.forEach((page, i) => {
    for (const [name, field] of Object.entries(page.content)) {
      if (!field.ref) continue;
      const key = field.ref.slice(REF_PREFIX.length);
      if (!key || !sharedKeys.has(key)) {
        out.push(
          issue(
            'U-2001',
            'error',
            `pages[${i}].content.${name}.ref`,
            `ref "${field.ref}" 未在 $shared 中定义`,
            '交换配置的 ref 必须指向 $shared 中的定义键',
          ),
        );
      }
    }
  });
  return issuesReport(out);
}

/* ------------------------------------------------------------------ */
/* 工程文件语义校验：本地引用不变量 + 全局唯一 + 动画/cid 一致性         */
/* ------------------------------------------------------------------ */

export function validateProjectFile(file: ProjectFile): ValidationReport {
  const out: Issue[] = [];
  const seen = new Map<string, number>();
  file.pages.forEach((page, i) => {
    const prev = seen.get(page.pageId);
    seen.set(page.pageId, i);
    if (prev !== undefined) {
      out.push(
        issue('U-3001', 'error', `pages[${i}].pageId`, `pageId "${page.pageId}" 重复（首次出现在 pages[${prev}]）`),
      );
    }
    out.push(...validatePage(page, `pages[${i}]`));
  });
  return issuesReport(out);
}

/** 单页语义校验：ref 只指向本页 $defs；动画 target 存在；copy 字段有 cid */
export function validatePage(page: Page, path: string): Issue[] {
  const out: Issue[] = [];
  const defKeys = new Set(Object.keys(page.$defs));
  const cidSet = new Set<string>();
  for (const [name, f] of Object.entries(page.content)) {
    const base = `${path}.content.${name}`;
    // 本地引用不变量
    if (f.ref) {
      const key = f.ref.slice(REF_PREFIX.length);
      if (!defKeys.has(key)) {
        out.push(
          issue(
            'U-2001',
            'error',
            `${base}.ref`,
            `ref "${f.ref}" 未在本页 $defs 中定义`,
            '导入展开后禁止跨页引用：引用必须指向本页 $defs',
          ),
        );
      }
    }
    if (f.cid) {
      if (cidSet.has(f.cid)) out.push(issue('U-3003', 'error', `${base}.cid`, `cid "${f.cid}" 在本页内重复`));
      cidSet.add(f.cid);
    }
    if (f.copy && !f.cid) {
      out.push(
        issue('U-3002', 'error', `${base}.copy`, 'copy:true 的内容字段必须有 cid', '占位符寻址依赖 cid，导入展开时会自动补齐'),
      );
    }
  }
  for (const anim of page.animations) {
    if (!cidSet.has(anim.target)) {
      out.push(issue('U-3005', 'warning', `${path}.animations.target`, `动画目标 "${anim.target}" 不是本页任何 cid`));
    }
  }
  return out;
}

/** 页内全部 cid */
export function pageCids(content: Content): Set<string> {
  const s = new Set<string>();
  for (const f of Object.values(content)) if (f?.cid) s.add(f.cid);
  return s;
}

/** 页内 copy 字段列表 */
export function copyFieldsOf(page: Page): { name: string; field: ContentField }[] {
  return Object.entries(page.content)
    .filter(([, f]) => f.copy === true)
    .map(([name, field]) => ({ name, field }));
}

export type { ValidationReport };