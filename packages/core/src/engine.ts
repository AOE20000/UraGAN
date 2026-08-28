import type { CopySkeleton, ExchangeConfig, Page, ProjectFile, ValidationReport } from '@uragan/shared';
import { ExchangeConfigZ, PageZ, ProjectFileZ, SCHEMA_VERSION } from '@uragan/shared';
import { applySkeleton, exportSkeleton } from './copy.js';
import { exportExchange } from './dedup.js';
import { ensureCids, expandExchange } from './expander.js';
import { inlineComponent } from './inline.js';
import { migrateData } from './migrate.js';
import { parseJsonc } from './parser.js';
import { issuesReport, okReport } from './report.js';
import { validateProjectFile, zodIssues } from './validate.js';

export type { CopySkeleton, ExchangeConfig, Page, ProjectFile, ValidationReport };

/**
 * 门面：6 步闭环所需全部能力（导入展开 / 导出整体配置 / 页面操作 / 文案 / 组件内联）。
 * 数据不落地：所有操作接受/返回 ProjectFile 对象，IO 由 store 层负责。
 */
export class Uragan {
  /* ---------------- 导入 / 导出 ---------------- */

  /** 导入：接受 交换配置($shared+pages) 或 工程文件(展开形)，统一产出工程文件 */
  static importFromText(text: string): { file: ProjectFile; report: ValidationReport } {
    const parsed = parseJsonc(text);
    if (!parsed.report.ok || parsed.data === undefined) return { file: blankFile(), report: parsed.report };
    // schemaVersion 迁移：链式升级到当前版本；未知版本由 U-1009 拦截
    const { data: migrated, report: migrateReport } = migrateData(parsed.data);
    if (!migrateReport.ok) return { file: blankFile(), report: migrateReport };
    const data = migrated as Record<string, unknown>;
    if ('$shared' in data) {
      const exchange = ExchangeConfigZ.safeParse(data);
      if (!exchange.success) {
        return { file: blankFile(), report: issuesReport(zodIssues(exchange)) };
      }
      return expandExchange(exchange.data);
    }
    const project = ProjectFileZ.safeParse(data);
    if (!project.success) {
      return { file: blankFile(), report: issuesReport(zodIssues(project)) };
    }
    for (const page of project.data.pages) ensureCids(page.content);
    const report = validateProjectFile(project.data);
    return { file: project.data, report };
  }

  /** 导出整体交换配置：工程文件 → dedup($shared) 形态 */
  static exportConfig(file: ProjectFile): { config: ExchangeConfig; report: ValidationReport } {
    return exportExchange(file);
  }

  /* ---------------- 页面操作 ---------------- */

  static listPages(file: ProjectFile): { pageId: string; name: string; kind: Page['kind']; duration: number }[] {
    return file.pages.map((p) => ({ pageId: p.pageId, name: p.name, kind: p.kind, duration: pageDuration(p) }));
  }

  /** 调整顺序：任何顺序都合法（挑选 + 排序），仅作为 pages 数组的新排列 */
  static reorder(file: ProjectFile, pageIds: string[]): { file: ProjectFile; report: ValidationReport } {
    const byId = new Map(file.pages.map((p) => [p.pageId, p]));
    const missing = pageIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      return {
        file,
        report: issuesReport([{ code: 'U-3008', severity: 'error', path: 'pages', message: `未知 pageId：${missing.join('、')}` }]),
      };
    }
    return { file: { ...file, pages: pageIds.map((id) => byId.get(id) as Page) }, report: okReport() };
  }

  static getPage(file: ProjectFile, pageId: string): Page | undefined {
    return file.pages.find((p) => p.pageId === pageId);
  }

  /** 单页覆盖导入：接受完整独立页（含头部 $defs），按 pageId 替换或追加 */
  static overwritePage(file: ProjectFile, pageInput: unknown): { file: ProjectFile; report: ValidationReport } {
    const parsed = PageZ.safeParse(pageInput);
    if (!parsed.success) {
      return { file, report: issuesReport(zodIssues(parsed)) };
    }
    const incoming: Page = { ...parsed.data, content: ensureCids(structuredClone(parsed.data.content)) };
    const idx = file.pages.findIndex((p) => p.pageId === incoming.pageId);
    const pages = idx >= 0 ? file.pages.map((p, i) => (i === idx ? incoming : p)) : [...file.pages, incoming];
    const next = validateProjectFile({ ...file, pages });
    return { file: { ...file, pages }, report: next };
  }

  /* ---------------- 文案 ---------------- */

  static exportSkeleton(file: ProjectFile) {
    return exportSkeleton(file);
  }

  static applySkeleton(file: ProjectFile, skeleton: CopySkeleton) {
    return applySkeleton(file, skeleton);
  }

  /* ---------------- 组件 ---------------- */

  static inlineComponent(file: ProjectFile, pageId: string, componentId: string) {
    return inlineComponent(file, pageId, componentId);
  }
}

/** 页面应用时长：页级 duration > project.defaults.pageDuration > 默认值 */
export function pageDuration(page: Page): number {
  return page.duration ?? 2.5;
}

function blankFile(): ProjectFile {
  return { schemaVersion: SCHEMA_VERSION, project: { id: 'project', name: '未命名', canvas: { width: 1280, height: 720, fps: 30 } }, pages: [] };
}

export { blankFile };