import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Uragan, blankFile, readProjectFile, withProjectExt, writeProjectFile } from '@uragan/core';
import type { ValidationReport } from '@uragan/shared';

/**
 * MCP 工具处理器（纯函数，返回 { ok, text }，可由 index.ts 包装为 CallToolResult）。
 * 数据面 = core 门面（命令面 = MCP 工具面 = core 能力面）。
 */

export interface ToolResult {
  ok: boolean;
  text: string;
}
/** 失败结果：ok 为字面量 false，供 Loaded 判别联合收窄 */
export type FailResult = { ok: false; text: string };

const ok = (text: string): ToolResult => ({ ok: true, text });
const fail = (text: string): FailResult => ({ ok: false, text });

function reportText(report: ValidationReport, fallback: string): string {
  const errors = report.errors.filter((e) => e.severity === 'error');
  if (errors.length === 0) {
    const warns = report.errors.filter((e) => e.severity === 'warning').map((e) => `[${e.code}] ${e.message} @${e.path}`);
    return warns.length > 0 ? `${fallback}\n⚠ ${warns.join('\n⚠ ')}` : fallback;
  }
  return errors.map((e) => `[${e.code}] ${e.message} @${e.path}${e.hint ? `（${e.hint}）` : ''}`).join('\n');
}

type Loaded = { ok: true; file: ReturnType<typeof readProjectFile>['file']; dir: string } | FailResult;

function load(path: string): Loaded {
  const resolved = withProjectExt(path);
  if (!existsSync(resolved)) return fail(`工程文件不存在：${resolved}`);
  try {
    const { file } = readProjectFile(resolved);
    return { ok: true, file, dir: dirname(resolved) };
  } catch (e: unknown) {
    return fail(`读取 ${resolved} 失败：${(e as Error).message}`);
  }
}

function write(out: string, data: unknown): void {
  writeFileSync(withProjectExt(out), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/* ---------------- 0 建工程 ---------------- */

export interface ProjectNewArgs {
  path?: string;
  name?: string;
  canvas?: string;
  fps?: number;
}
export function projectNew(a: ProjectNewArgs = {}): ToolResult {
  const m = /^(\d+)x(\d+)$/.exec(a.canvas ?? '1280x720');
  if (!m) return fail(`canvas 格式应为 宽x高，如 1280x720，收到：${a.canvas}`);
  const file = blankFile();
  file.project.name = a.name ?? '未命名';
  file.project.canvas = { width: Number(m[1]!), height: Number(m[2]!), fps: a.fps ?? 30 };
  const target = withProjectExt(a.path ?? 'project.uragan');
  writeProjectFile(target, file);
  return ok(`已创建空工程 ${file.pages.length} 页 → ${target}`);
}

/* ---------------- 1/2 导入 / 导出 / 校验 ---------------- */

export interface ProjectImportArgs {
  configPath: string;
  out?: string;
}
export function projectImport(a: ProjectImportArgs): ToolResult {
  let text: string;
  try {
    text = readFileSync(a.configPath, 'utf8');
  } catch (e) {
    return fail(`读取 ${a.configPath} 失败：${(e as Error).message}`);
  }
  const { file, report } = Uragan.importFromText(text);
  if (!report.ok) return fail(reportText(report, '导入失败'));
  const target = withProjectExt(a.out ?? 'project.uragan');
  writeProjectFile(target, file);
  return ok(`已导入 ${file.pages.length} 个页面 → ${target}${report.errors.length > 0 ? '\n' + reportText(report, '') : ''}`);
}

export interface ProjectExportArgs {
  path?: string;
  out?: string;
}
export function projectExport(a: ProjectExportArgs = {}): ToolResult {
  const r = load(a.path ?? 'project.uragan');
  if (!r.ok) return r;
  const { config, report } = Uragan.exportConfig(r.file);
  if (!report.ok) return fail(reportText(report, '导出失败'));
  const json = JSON.stringify(config, null, 2);
  if (a.out) {
    write(a.out, config);
    return ok(`已导出整体交换配置（$shared ${Object.keys(config.$shared).length} 项）→ ${withProjectExt(a.out)}`);
  }
  return ok(json);
}

export function validate(path = 'project.uragan'): ToolResult {
  const r = load(path);
  if (!r.ok) return r;
  const report = Uragan.exportConfig(r.file).report;
  return report.errors.length === 0 ? ok(`配置有效（${report.errors.length} 处提醒）`) : fail(reportText(report, ''));
}

/* ---------------- 3 选择排序 / 页面 ---------------- */

export function listPages(path = 'project.uragan'): ToolResult {
  const r = load(path);
  if (!r.ok) return r;
  const rows = Uragan.listPages(r.file).map((p, i) => `${i + 1}. ${p.pageId}  ${p.name}  <${p.kind}>  ${p.duration}s`);
  return ok(rows.length > 0 ? rows.join('\n') : '（无页面）');
}

export interface ReorderPagesArgs {
  path?: string;
  ids: string[];
}
export function reorderPages(a: ReorderPagesArgs): ToolResult {
  const r = load(a.path ?? 'project.uragan');
  if (!r.ok) return r;
  const { file, report } = Uragan.reorder(r.file, a.ids);
  if (!report.ok) return fail(reportText(report, '调整失败'));
  writeProjectFile(withProjectExt(a.path ?? 'project.uragan'), file);
  return ok(`已调整顺序：${file.pages.map((p) => p.pageId).join(' → ')}`);
}

export interface PageGetArgs {
  path?: string;
  pageId: string;
  out?: string;
}
export function pageGet(a: PageGetArgs): ToolResult {
  const r = load(a.path ?? 'project.uragan');
  if (!r.ok) return r;
  const p = Uragan.getPage(r.file, a.pageId);
  if (!p) return fail(`页 ${a.pageId} 不存在`);
  const json = JSON.stringify(p, null, 2);
  if (a.out) {
    writeFileSync(a.out, json + '\n', 'utf8');
    return ok(`已导出 ${a.pageId} → ${a.out}`);
  }
  return ok(json);
}

export interface PageOverwriteArgs {
  path?: string;
  pageId: string;
  pageJson: string;
}
export function pageOverwrite(a: PageOverwriteArgs): ToolResult {
  const r = load(a.path ?? 'project.uragan');
  if (!r.ok) return r;
  let input: unknown;
  try {
    input = JSON.parse(a.pageJson);
  } catch {
    return fail('pageJson 不是合法 JSON');
  }
  if ((input as { pageId?: unknown }).pageId !== a.pageId) {
    return fail(`pageJson 的 pageId（${String((input as { pageId?: unknown }).pageId)}）与参数 ${a.pageId} 不一致`);
  }
  const { file, report } = Uragan.overwritePage(r.file, input);
  if (!report.ok) return fail(reportText(report, '覆盖失败'));
  writeProjectFile(withProjectExt(a.path ?? 'project.uragan'), file);
  return ok(`已覆盖页 ${a.pageId}`);
}

/* ---------------- 4/5 文案框架 ---------------- */

export interface CopyExportArgs {
  path?: string;
  out?: string;
}
export function copyExport(a: CopyExportArgs = {}): ToolResult {
  const r = load(a.path ?? 'project.uragan');
  if (!r.ok) return r;
  const { skeleton } = Uragan.exportSkeleton(r.file);
  const json = JSON.stringify(skeleton, null, 2);
  if (a.out) {
    writeFileSync(a.out, json + '\n', 'utf8');
    const n = skeleton.pages.reduce((s, p) => s + p.items.length, 0);
    return ok(`已导出文案框架（${n} 个占位符）→ ${a.out}`);
  }
  return ok(json);
}

export interface CopyImportArgs {
  path?: string;
  skeletonJson: string;
}
export function copyImport(a: CopyImportArgs): ToolResult {
  const r = load(a.path ?? 'project.uragan');
  if (!r.ok) return r;
  let skeleton: unknown;
  try {
    skeleton = JSON.parse(a.skeletonJson);
  } catch {
    return fail('skeletonJson 不是合法 JSON');
  }
  const { file, report } = Uragan.applySkeleton(r.file, skeleton as Parameters<typeof Uragan.applySkeleton>[1]);
  if (!report.ok) return fail(reportText(report, '文案填充失败'));
  writeProjectFile(withProjectExt(a.path ?? 'project.uragan'), file);
  return ok('文案填充完成');
}

/* ---------------- 共享池 / 资产 / 渲染 ---------------- */

export function sharedPool(path = 'project.uragan'): ToolResult {
  const r = load(path);
  if (!r.ok) return r;
  const { config, report } = Uragan.exportConfig(r.file);
  if (!report.ok) return fail(reportText(report, ''));
  const keys = Object.keys(config.$shared);
  if (keys.length === 0) return ok('（空）');
  return ok(keys.map((k) => `${k} = ${JSON.stringify(config.$shared[k])}`).join('\n'));
}

export interface RenderVideoArgs {
  path?: string;
  out?: string;
  codec?: 'h264' | 'h265' | 'vp8' | 'vp9';
}
export async function renderVideo(a: RenderVideoArgs = {}): Promise<ToolResult> {
  const r = load(a.path ?? 'project.uragan');
  if (!r.ok) return r;
  const { renderProject } = await import('@uragan/render');
  try {
    const { output, durationSeconds } = await renderProject(r.file, {
      output: a.out ?? 'out.mp4',
      projectDir: r.dir,
      codec: a.codec ?? 'h264',
    });
    return ok(`✓ 渲染完成 → ${output}（${durationSeconds.toFixed(1)}s）`);
  } catch (e: unknown) {
    return fail(`渲染失败：${(e as Error).message}`);
  }
}

export interface AssetsCheckArgs {
  path?: string;
}
export async function assetsCheck(a: AssetsCheckArgs = {}): Promise<ToolResult> {
  const r = load(a.path ?? 'project.uragan');
  if (!r.ok) return r;
  const { checkAssets } = await import('@uragan/render');
  const { ok: pass, issues } = await checkAssets(r.file, r.dir, 'assets');
  if (issues.length === 0) return ok('✓ 资产引用全部有效');
  const lines = issues.map((i) => `${i.severity === 'error' ? '[error]' : '[warn ]'} [${i.code}] ${i.message} @${i.path}`);
  return pass ? ok(lines.join('\n')) : fail(lines.join('\n'));
}