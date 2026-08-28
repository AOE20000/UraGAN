import type { Content, ExchangeConfig, Page, ProjectFile } from '@uragan/shared';
import { ProjectFileZ, SCHEMA_VERSION } from '@uragan/shared';
import { okReport } from './report.js';
import { validateExchange, zodIssues } from './validate.js';
import type { ValidationReport } from '@uragan/shared';

export interface ExpandResult {
  file: ProjectFile;
  report: ValidationReport;
}

/** 生成页内唯一 cid（c + 4 位 hex） */
export function genCid(existing: Set<string>): string {
  for (;;) {
    const cid = `c${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')}`;
    if (!existing.has(cid)) return cid;
  }
}

/** 为页内所有缺 cid 的内容字段补齐 cid（幂等：已有 cid 不动） */
export function ensureCids(content: Content): Content {
  const used = new Set<string>();
  for (const f of Object.values(content)) if (f?.cid) used.add(f.cid);
  for (const f of Object.values(content)) {
    if (f && !f.cid) f.cid = genCid(used);
    used.add(f.cid as string);
  }
  return content;
}

/**
 * 导入展开：交换配置 → 工程文件。
 * - 每个页面「完整拷贝全部」$shared 定义（深拷贝，全量），此后各页自治。
 * - 补齐 cid；ref 仍为 "defs/<key>"，经过拷贝后必然命中本页 $defs。
 */
export function expandExchange(config: ExchangeConfig): ExpandResult {
  const report = validateExchange(config);
  const pages: Page[] = config.pages.map((input, i) => {
    const $defs = structuredClone(config.$shared); // 完整拷贝全部定义
    const content = ensureCids(structuredClone(input.content));
    return {
      schemaVersion: SCHEMA_VERSION,
      pageId: input.pageId,
      name: input.name,
      kind: input.kind,
      $defs,
      content,
      animations: input.animations ?? [],
      ...(input.duration !== undefined ? { duration: input.duration } : {}),
    };
  });
  const file: ProjectFile = {
    schemaVersion: SCHEMA_VERSION,
    project: structuredClone(config.project),
    pages,
  };
  const structural = zodIssues(ProjectFileZ.safeParse(file));
  return {
    file,
    report: report.ok && structural.length === 0 ? okReport() : { ...report, ok: false, errors: [...report.errors, ...structural] },
  };
}