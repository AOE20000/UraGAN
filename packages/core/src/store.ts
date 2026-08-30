import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { Component, Issue, Page, ProjectFile, ValidationReport } from '@uragan/shared';
import { ExchangeConfigZ, PageZ, PROJECT_EXT, ProjectFileZ, WORK_DIR_SUFFIX } from '@uragan/shared';
import { expandExchange } from './expander.js';
import { ensureCids } from './expander.js';
import { migrateData } from './migrate.js';
import { parseJsonc } from './parser.js';
import { issuesReport, okReport } from './report.js';
import { validateProjectFile, zodIssues } from './validate.js';

export interface LoadResult {
  file: ProjectFile;
  report: ValidationReport;
}

const FILE_PROJECT = 'project.json';
/** 独立页文件后缀：与整体文件同为 .uragan 单文件（独立文件 = 单页 ProjectFile，可独立再打开） */
const PAGE_EXT = '.uragan';
const DIR_PAGES = 'pages'; // 旧版目录工程的页文件子目录（仅读取兼容）
const DIR_COMPONENTS = 'components';

/* ------------------------------------------------------------------ */
/* 工程目录形态（T2：打开时自动生成目录；导入的整体文件拆分为每页一个独立文件）     */
/* · 独立文件 = 工程目录根下的 <pageId>.uragan：完整单页 ProjectFile，可当整体文件用  */
/* · 直接移入（未走导入）的整体文件 → 扫描吸收，页序按来源文件锁定成组              */
/* ------------------------------------------------------------------ */

/** 独立页文件路径：工程目录根下 <pageId>.uragan */
function pageFilePath(dir: string, pageId: string): string {
  return join(dir, `${pageId}${PAGE_EXT}`);
}

interface ProjectManifest {
  schemaVersion?: string;
  project?: unknown;
  /** 播放顺序（独立文件 pageId 的有序列表） */
  order?: unknown;
  /** 页组锁定（整体文件直接移入时的源内页序） */
  groups?: unknown;
}

function readManifest(dir: string): ProjectManifest {
  try {
    return JSON.parse(readFileSync(join(dir, FILE_PROJECT), 'utf8')) as ProjectManifest;
  } catch {
    return {};
  }
}

function writeManifest(dir: string, file: ProjectFile): void {
  atomicWrite(
    join(dir, FILE_PROJECT),
    JSON.stringify(
      {
        schemaVersion: file.schemaVersion,
        project: file.project,
        order: file.pages.map((p) => p.pageId),
        groups: file.project.pageGroups ?? [],
      },
      null,
      2,
    ) + '\n',
  );
}

/** 是否为「工程目录」：目录且含 project.json */
export function isProjectDir(path: string): boolean {
  try {
    return statSync(path).isDirectory() && existsSync(join(path, FILE_PROJECT));
  } catch {
    return false;
  }
}

/** 是否存在且为普通文件（目录 / 不存在均返回 false） */
export function isExistingFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 任意源路径 → 工程目录路径（name.uragan/ 目录形态）。promo.json → promo.uragan/ */
export function projectDirFor(source: string): string {
  const ext = extname(source);
  return (ext ? source.slice(0, -ext.length) : source) + PROJECT_EXT;
}

/**
 * 「.uragan 持久文件」→ 其工作目录（<源名>.uragan.work/）。
 * 原文件要原样留着承担持久存储，目录只能另起名字 —— 文件与目录不能同名。
 */
export function workingDirFor(durablePath: string): string {
  return durablePath + WORK_DIR_SUFFIX;
}

/** 是否工作目录名（供文件管理器等识别可打开的工程目录） */
export function isWorkingDirName(path: string): boolean {
  return path.toLowerCase().endsWith(PROJECT_EXT + WORK_DIR_SUFFIX);
}

/** 是否「.uragan 持久文件」：存在、是普通文件、且后缀为 .uragan */
export function isDurableSource(path: string): boolean {
  return isExistingFile(path) && path.toLowerCase().endsWith(PROJECT_EXT);
}

/**
 * 产出 / 资产目录：用户的 assets/、render.mp4、导出单页都在这一层。
 * - 有持久文件 → 原 .uragan 所在目录（工程目录只是内部的按页拆分区）
 * - 否则 → 工程目录本身
 * TUI / CLI / MCP 共用一份实现，避免三处各算一套导致行为不一致。
 */
export function outputDirFor(projectPath: string, durablePath?: string): string {
  if (durablePath) return dirname(durablePath);
  return isProjectDir(projectPath) ? projectPath : dirname(projectPath);
}

/** 独立文件 → 页（独立文件为单页 ProjectFile；兼容旧版「裸页」形态；无法解析返回 undefined） */
function pageFromStandalone(raw: Record<string, unknown> | undefined): Page | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const z = ProjectFileZ.safeParse(raw);
  if (z.success) return z.data.pages[0];
  const pz = PageZ.safeParse(raw);
  if (pz.success) return pz.data;
  return undefined;
}

/** 直接移入工程目录的额外 .uragan 文件 → 页面（整体/独立兼可，走同一条解析链） */
function absorbForeignPageFile(dir: string, f: string, issues: Issue[]): Page[] | undefined {
  try {
    return parseProjectText(readFileSync(join(dir, f), 'utf8'), join(dir, f)).file.pages;
  } catch (e) {
    issues.push({
      code: 'U-9012',
      severity: 'error',
      path: '$',
      message: `直接移入工程目录的文件无法解析：${f}（${e instanceof Error ? e.message : String(e)}）`,
    });
    return undefined;
  }
}

/** 聚合读工程目录：project.json(order/groups) + 根目录独立文件 + components/*.json → ProjectFile */
export function readProjectDir(dir: string): LoadResult {
  const issues: Issue[] = [];
  const manifest = readManifest(dir);
  const order: string[] = Array.isArray(manifest.order)
    ? (manifest.order as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const seen = new Set<string>();
  const pages: Page[] = [];
  // ① manifest 播放顺序：根目录 <pageId>.uragan（独立文件）；旧版 fallback pages/<pageId>.json
  for (const pageId of order) {
    if (seen.has(pageId)) continue;
    seen.add(pageId);
    const p = pageFilePath(dir, pageId);
    if (existsSync(p)) {
      const page = pageFromStandalone(JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>);
      if (page) {
        pages.push(page);
      } else {
        issues.push({ code: 'U-9011', severity: 'error', path: `pages.${pageId}`, message: `独立页文件无法解析：${p}` });
      }
      continue;
    }
    const legacy = join(dir, DIR_PAGES, `${pageId}.json`);
    if (existsSync(legacy)) {
      pages.push(JSON.parse(readFileSync(legacy, 'utf8')) as Page);
      continue;
    }
    issues.push({ code: 'U-9010', severity: 'error', path: `pages.${pageId}`, message: `工程目录缺失独立页文件：${p}` });
  }
  // ② 页组锁定恢复（manifest.groups 持久化了直接移入整体文件的源内页序）
  const pageGroups: { id: string; pages: string[] }[] = [];
  const groupSeen = new Set<string>();
  if (Array.isArray(manifest.groups)) {
    for (const g of manifest.groups) {
      if (!g || typeof g !== 'object') continue;
      const rec = g as { id?: unknown; pages?: unknown };
      const id = typeof rec.id === 'string' ? rec.id : '';
      const gids = Array.isArray(rec.pages) ? rec.pages.filter((x): x is string => typeof x === 'string' && seen.has(x)) : [];
      if (id && gids.length >= 2) {
        pageGroups.push({ id, pages: gids });
        groupSeen.add(id);
      }
    }
  }
  // ③ 直接移入而未走导入的整体/独立 .uragan：按文件名吸收 → 整体文件按源内页序锁定成组
  for (const f of readdirSync(dir).filter((x) => x.endsWith(PAGE_EXT)).sort()) {
    const incoming = absorbForeignPageFile(dir, f, issues);
    if (!incoming) continue;
    const fresh = incoming.filter((p) => !seen.has(p.pageId));
    if (fresh.length === 0) continue;
    for (const p of fresh) {
      seen.add(p.pageId);
      pages.push(p);
    }
    if (fresh.length > 1) {
      // 多页即整体文件：页序锁定 → 改变页面1顺序时页面2跟着动
      const stem = f.slice(0, -PAGE_EXT.length);
      let gid = stem;
      let n = 2;
      while (groupSeen.has(gid)) gid = `${stem}_${n++}`;
      groupSeen.add(gid);
      pageGroups.push({ id: gid, pages: fresh.map((p) => p.pageId) });
    }
  }
  // ④ 组件
  const components: Component[] = [];
  const compDir = join(dir, DIR_COMPONENTS);
  if (existsSync(compDir)) {
    for (const f of readdirSync(compDir).sort()) {
      if (!f.endsWith('.json')) continue;
      components.push(JSON.parse(readFileSync(join(compDir, f), 'utf8')) as Component);
    }
  }
  const blank = blankFile('', '');
  const assembled: Record<string, unknown> = {
    schemaVersion: manifest.schemaVersion ?? '1',
    project: {
      ...((manifest.project as Record<string, unknown> | undefined) ?? blank.project),
      ...(pageGroups.length > 0 ? { pageGroups } : {}),
    },
    pages,
    ...(components.length > 0 ? { components } : {}),
  };
  return finalizeProject(assembled, issues);
}

/** 拆分写工程目录：project.json(order/groups) + 每页一个独立文件 + 每组件一个文件（原子写） */
export function writeProjectDir(dir: string, file: ProjectFile): void {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, DIR_COMPONENTS), { recursive: true });
  // 清理被移除页的旧独立文件，避免下次读取“复活”已删除的页（只清 manifest 旧序中登记过的页）
  const prev = readManifest(dir);
  if (Array.isArray(prev.order)) {
    for (const pid of prev.order) {
      if (typeof pid !== 'string' || file.pages.some((p) => p.pageId === pid)) continue;
      const stale = pageFilePath(dir, pid);
      if (existsSync(stale)) rmSync(stale);
      const legacy = join(dir, DIR_PAGES, `${pid}.json`);
      if (existsSync(legacy)) rmSync(legacy);
    }
  }
  // 每页 → 独立文件（单页 ProjectFile，自含 project 元信息，可独立再打开/再导出）
  const base: ProjectFile = { schemaVersion: file.schemaVersion, project: file.project, pages: [] };
  for (const page of file.pages) {
    atomicWrite(pageFilePath(dir, page.pageId), JSON.stringify({ ...base, pages: [page] }, null, 2) + '\n');
  }
  for (const c of file.components ?? []) {
    atomicWrite(join(dir, DIR_COMPONENTS, `${c.componentId}.json`), JSON.stringify(c, null, 2) + '\n');
  }
  writeManifest(dir, file);
}

/** 组装 + 迁移 + 语义校验为最终 LoadResult（file 始终有效对象，错误入 report） */
function finalizeProject(raw: Record<string, unknown> | undefined, pre: Issue[] = []): LoadResult {
  if (!raw || typeof raw !== 'object') return { file: blankFile('', ''), report: issuesReport(pre) };
  const { data: migrated, report: mig } = migrateData(raw);
  if (!mig.ok) return { file: blankFile('', ''), report: mig };
  let candidate = migrated as Record<string, unknown>;
  let z = ProjectFileZ.safeParse(candidate);
  if (!z.success && looksLikeProject(candidate)) {
    // T6 宽松化：工程外形但缺 $defs 等结构字段时自动补齐重试（页文件被手工精简的场景）
    candidate = salvageProjectShape(candidate);
    z = ProjectFileZ.safeParse(candidate);
  }
  if (!z.success) return { file: blankFile('', ''), report: issuesReport([...pre, ...zodIssues(z)] as Issue[]) };
  for (const p of z.data.pages) ensureCids(p.content);
  const semantic = validateProjectFile(z.data);
  return {
    file: z.data,
    report: {
      ok: semantic.ok,
      level: semantic.level,
      errors: [...pre, ...semantic.errors],
    },
  };
}

/* ------------------------------------------------------------------ */
/* 工程文件（legacy 单文件）读取：结构 + 语义校验；无法按工程解析时回退交换配置     */
/* ------------------------------------------------------------------ */

/** 读取工程（自动识别：目录工程 → 聚合；单文件 → legacy/交换配置解析） */
export function readProjectFile(path: string): LoadResult {
  if (isProjectDir(path)) return readProjectDir(path);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { file: blankFile('', ''), report: issuesReport([ioIssue(path, message)]) };
  }
  return parseProjectText(text, path);
}

/**
 * T6 宽松化：外形是工程（project + pages）但缺 $defs 等结构字段时自动补齐，
 * 不再整份判错返回空占位工程（空工程会静默导出 0s 视频）。只补必需结构，语义问题仍报错。
 */
export function salvageProjectShape(data: Record<string, unknown>): Record<string, unknown> {
  if (!data || typeof data !== 'object' || !Array.isArray(data.pages)) return data;
  const pages = data.pages.map((p) => {
    if (!p || typeof p !== 'object') return p;
    const rec = { ...(p as Record<string, unknown>) };
    if (rec.$defs === undefined) rec.$defs = {};
    if (rec.content === undefined) rec.content = {};
    if (rec.animations === undefined) rec.animations = [];
    if (rec.name === undefined && typeof rec.pageId === 'string') rec.name = rec.pageId;
    return rec;
  });
  return { ...data, pages };
}

/** 是否呈工程外形（有 project + pages 数组） */
function looksLikeProject(data: Record<string, unknown>): boolean {
  return Boolean(data && typeof data.project === 'object' && data.project !== null && Array.isArray(data.pages));
}

/**
 * 解析工程文本（T6 宽松化）：工程文件(展开形) → 交换配置($shared 自动展开) → 工程外形缺结构自动补齐。
 * 三种路径都保证 file 是有效对象，错误进 report，不再“缺 $defs 就直接空占位”。
 */
export function parseProjectText(text: string, source = '<text>'): LoadResult {
  const { data, report } = parseJsonc(text);
  if (!report.ok || data === undefined || typeof data !== 'object' || data === null) {
    return { file: blankFile('', ''), report };
  }
  const project = ProjectFileZ.safeParse(data);
  if (project.success) return finalizeProject(data as Record<string, unknown>);
  if (isExchangeShape(data)) {
    const ex = ExchangeConfigZ.safeParse(data);
    if (ex.success) return finalizeProject(expandExchange(ex.data).file as unknown as Record<string, unknown>);
    return { file: blankFile('', ''), report: issuesReport([...zodIssues(project), ...zodIssues(ex)]) };
  }
  if (looksLikeProject(data as Record<string, unknown>)) {
    const salvaged = salvageProjectShape(data as Record<string, unknown>);
    const retry = ProjectFileZ.safeParse(salvaged);
    if (retry.success) return finalizeProject(salvaged);
  }
  return { file: blankFile('', ''), report: issuesReport(zodIssues(project)) };
}

/** 是否为交换配置形态（含 $shared） */
function isExchangeShape(data: unknown): boolean {
  return Boolean(data && typeof data === 'object' && '$shared' in (data as Record<string, unknown>));
}

/* ------------------------------------------------------------------ */
/* 写回工程（自动识别形态：目录工程 / 新路径 .uragan → 目录；其它后缀 → 单文件）   */
/* ------------------------------------------------------------------ */

/**
 * 写回工程（形态由磁盘现状决定：目录 → 拆分写；不存在的 .uragan → 目录形态；其余 → 单文件 legacy）。
 * 注意：同名的 legacy 单文件存在时必须保持单文件形态 —— 文件与目录不能同名，强行建目录必然 EEXIST。
 */
export function writeProjectFile(path: string, file: ProjectFile): void {
  if (isProjectDir(path)) {
    writeProjectDir(path, file);
    return;
  }
  if (!isExistingFile(path) && path.toLowerCase().endsWith(PROJECT_EXT)) {
    writeProjectDir(path, file);
    return;
  }
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', 'utf8');
}

/** 确保工程路径带扩展名 */
export function withProjectExt(path: string): string {
  return path.toLowerCase().endsWith(PROJECT_EXT) ? path : `${path}${PROJECT_EXT}`;
}

/* ------------------------------------------------------------------ */
/* 辅助                                                               */
/* ------------------------------------------------------------------ */

function ioIssue(path: string, message: string): Issue {
  return { code: 'U-9001', severity: 'error', path: '$', message: `读取失败（${path}）：${message}` };
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

/** 空白工程占位（对外统一走 engine 的 blankFile 生成新工程） */
function blankFile(id: string, name: string): ProjectFile {
  return {
    schemaVersion: '1',
    project: { id, name, canvas: { width: 1280, height: 720, fps: 30 } },
    pages: [],
  };
}

export { okReport };