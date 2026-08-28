import type { Content, Def, ExchangeConfig, Page, ProjectFile, ValidationReport } from '@uragan/shared';
import { REF_PREFIX, SCHEMA_VERSION } from '@uragan/shared';
import { issuesReport } from './report.js';

export interface ExportResult {
  config: ExchangeConfig;
  report: ValidationReport;
}

/** 纯 JSON 值深比较（对象键序无关），用于判定定义是否「值相同」 */
export function defsEqual(a: Def | undefined, b: Def | undefined): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, idx) => (ka[idx] as string) === (kb[idx] as string) && defsEqual((a as Record<string, unknown>)[k] as Def, (b as Record<string, unknown>)[kb[idx] as string] as Def));
}

export { defsEqual as areDefsEqual };

/** 将页内容中指向 `defs/<key>` 的引用改写为 `defs/<newKey>`（原地修改） */
export function rewriteRefs(content: Content, key: string, newKey: string): void {
  for (const f of Object.values(content)) {
    if (f?.ref === `${REF_PREFIX}${key}`) f.ref = `${REF_PREFIX}${newKey}`;
  }
}

/**
 * 导出整体交换配置：工程文件 → 交换配置。
 * - 每页 content 深拷贝（用于改写引用），$defs 不保留。
 * - 扫描所有页面 $defs（保持页面顺序、键排序，保证确定性）：
 *   - 同 key 同值 → 合并进 $shared，保留原 key
 *   - 同 key 异值 → 先出现页保留原 key；后出现页重命名 `<key>_<pageId>`，并改写该页引用
 * 幂等：对同一文件重复导出结果一致（重命名键唯一且稳定）。
 */
export function exportExchange(file: ProjectFile): ExportResult {
  const shared = new Map<string, Def>();
  const pages: ExchangeConfig['pages'] = file.pages.map((page) => {
    const content: Content = structuredClone(page.content);
    const defKeys = Object.keys(page.$defs).sort();
    for (const key of defKeys) {
      const def = page.$defs[key];
      const existing = shared.get(key);
      if (existing === undefined) {
        shared.set(key, def!);
      } else if (!defsEqual(existing, def)) {
        const newKey = renamedKey(key, page.pageId, shared);
        shared.set(newKey, def!);
        rewriteRefs(content, key, newKey);
      }
    }
    return {
      pageId: page.pageId,
      name: page.name,
      kind: page.kind,
      content,
      animations: page.animations,
      ...(page.duration !== undefined ? { duration: page.duration } : {}),
    };
  });

  const config: ExchangeConfig = {
    schemaVersion: SCHEMA_VERSION,
    project: structuredClone(file.project),
    $shared: Object.fromEntries(shared),
    pages,
  };
  return { config, report: issuesReport([]) };
}

/** 生成冲突后的新键：`<key>_<pageId>` 仍撞车则追加 `_2/_3…`（确定性兜底） */
function renamedKey(key: string, pageId: string, shared: Map<string, Def>): string {
  let candidate = `${key}_${pageId}`;
  let n = 2;
  while (shared.has(candidate)) {
    candidate = `${key}_${pageId}_${n}`;
    n++;
  }
  return candidate;
}

export type { ValidationReport };