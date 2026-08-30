import type { CopySkeleton, ExchangeConfig, Page, ProjectFile, ValidationReport } from '@uragan/shared';
import { ExchangeConfigZ, PageZ, ProjectFileZ, SCHEMA_VERSION } from '@uragan/shared';
import { existsSync, readFileSync } from 'node:fs';
import { applySkeleton, exportSkeleton } from './copy.js';
import { exportExchange } from './dedup.js';
import { ensureCids, expandExchange } from './expander.js';
import { inlineComponent } from './inline.js';
import { migrateData } from './migrate.js';
import { parseJsonc } from './parser.js';
import { issuesReport, okReport } from './report.js';
import {
  isDurableSource,
  isProjectDir,
  projectDirFor,
  readProjectDir,
  salvageProjectShape,
  workingDirFor,
  writeProjectDir,
} from './store.js';
import { validateProjectFile, zodIssues } from './validate.js';

export type { CopySkeleton, ExchangeConfig, Page, ProjectFile, ValidationReport };

export interface OpenResult {
  /** 打开的工程路径（目录工程时指向目录；.uragan 持久文件时指向其 <源名>.uragan.work/ 工作目录） */
  projectPath: string;
  file: ProjectFile;
  report: ValidationReport;
  /** true = 源是配置文件，本次已自动展开并生成工程目录（工作目录已存在时复用，为 false） */
  converted: boolean;
  /**
   * 持久文件（原 .uragan）：非空表示「工程在工作目录中进行，原文件承担持久存储」——
   * 编辑实时写入工作目录，显式保存时才导出回这个文件。仅 .uragan 单文件源才有。
   */
  durablePath?: string;
}

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
      // T6 宽松化：手续齐整但缺 $defs 等结构字段的“工程外形”文件 → 自动补齐后重试（不再返回空占位工程）
      const salvaged = salvageProjectShape(data);
      const retry = ProjectFileZ.safeParse(salvaged);
      if (!retry.success) return { file: blankFile(), report: issuesReport(zodIssues(project)) };
      for (const page of retry.data.pages) ensureCids(page.content);
      const report = validateProjectFile(retry.data);
      return { file: retry.data, report };
    }
    for (const page of project.data.pages) ensureCids(page.content);
    const report = validateProjectFile(project.data);
    return { file: project.data, report };
  }

  /**
   * 打开工程：一律导入到工程目录中进行（T2：不再维护易碎的“单文件内部形态”）。
   * - 工程目录（<名>.uragan/ 或 <名>.uragan.work/）→ 聚合读取
   * - .uragan 单文件（整体工程 / 独立页面）→ **导入**：原地派生 <源名>.uragan.work/ 工作目录，
   *   按页拆分成独立文件；原 .uragan 文件原样保留，承担持久存储（保存 = 导出回它）
   * - 其它后缀（.json / .jsonc 交换配置）→ 展开成 <名>.uragan/ 目录，与原文件脱钩
   */
  static openProject(sourcePath: string): OpenResult {
    if (!sourcePath.trim()) {
      return { projectPath: sourcePath, file: blankFile(), report: issuesReport([{ code: 'U-9001', severity: 'error', path: '$', message: '未指定工程路径' }]), converted: false };
    }
    if (isProjectDir(sourcePath)) {
      const r = readProjectDir(sourcePath);
      return { projectPath: sourcePath, file: r.file, report: r.report, converted: false };
    }
    if (!existsSync(sourcePath)) {
      return { projectPath: sourcePath, file: blankFile(), report: issuesReport([{ code: 'U-9001', severity: 'error', path: '$', message: `工程不存在：${sourcePath}` }]), converted: false };
    }
    let text: string;
    try {
      text = readFileSync(sourcePath, 'utf8');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { projectPath: sourcePath, file: blankFile(), report: issuesReport([{ code: 'U-9001', severity: 'error', path: '$', message: `读取失败：${message}` }]), converted: false };
    }
    const imp = Uragan.importFromText(text);
    if (!imp.report.ok) {
      return { projectPath: sourcePath, file: imp.file, report: imp.report, converted: false };
    }
    // .uragan 单文件：原文件留下做持久存储，工程在派生的 <源名>.uragan.work/ 中进行
    const durable = isDurableSource(sourcePath) ? sourcePath : undefined;
    const dir = durable ? workingDirFor(durable) : projectDirFor(sourcePath);

    // 工作目录已存在 → 直接接着用（里面可能有尚未导出回持久文件的改动，不能被重新导入覆盖）
    if (isProjectDir(dir)) {
      const r = readProjectDir(dir);
      return { projectPath: dir, file: r.file, report: r.report, converted: false, durablePath: durable };
    }
    try {
      writeProjectDir(dir, imp.file);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 落盘失败不应抛出：调用方（TUI）拿到 report 自行提示，进程不能崩
      return {
        projectPath: sourcePath,
        file: imp.file,
        report: issuesReport([{ code: 'U-9013', severity: 'error', path: '$', message: `导入到工作目录失败：${dir}（${message}）` }]),
        converted: false,
        durablePath: durable,
      };
    }
    const r = readProjectDir(dir);
    return { projectPath: dir, file: r.file, report: r.report, converted: true, durablePath: durable };
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
    // 页组锁定（整体文件直接移入）：组内页面在输入列表中保持连续，整组按组内顺序归位
    const order = normalizeGroupOrder(pageIds, file.project.pageGroups ?? []);
    const all = file.pages.map((p) => p.pageId);
    const missing = all.filter((id) => !order.includes(id));
    const unknown = order.filter((id) => !byId.has(id));
    if (missing.length > 0 || unknown.length > 0) {
      const bad = [...missing, ...unknown];
      return {
        file,
        report: issuesReport([{ code: 'U-3008', severity: 'error', path: 'pages', message: `未知 pageId：${bad.join('、')}` }]),
      };
    }
    return { file: { ...file, pages: order.map((id) => byId.get(id) as Page) }, report: okReport() };
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

/**
 * 页组锁定归一化：把“期望顺序”整理成合法的最终顺序。
 * - 组内页面已在输入中 → 令其在首次出现处成段归位（保持组内原序），避免组被拆散
 * - 非组页面原样保留
 * 返回结果可用于直接重建 pages 数组（配合 U-3008 校验缺页/未知页）。
 */
export function normalizeGroupOrder(ids: string[], groups: { id: string; pages: string[] }[] = []): string[] {
  const groupOf = new Map<string, { id: string; pages: string[] }>();
  for (const g of groups) for (const p of g.pages) groupOf.set(p, g);
  const out: string[] = [];
  const placedPages = new Set<string>();
  const placedGroups = new Set<string>();
  for (const id of ids) {
    const g = groupOf.get(id);
    if (g && !placedGroups.has(g.id)) {
      placedGroups.add(g.id);
      for (const m of g.pages) {
        if (!placedPages.has(m)) {
          out.push(m);
          placedPages.add(m);
        }
      }
    } else if (!g && !placedPages.has(id)) {
      out.push(id);
      placedPages.add(id);
    }
  }
  return out;
}

function blankFile(): ProjectFile {
  return { schemaVersion: SCHEMA_VERSION, project: { id: 'project', name: '未命名', canvas: { width: 1280, height: 720, fps: 30 } }, pages: [] };
}

export { blankFile };