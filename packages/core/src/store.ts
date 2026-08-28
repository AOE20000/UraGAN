import { readFileSync, writeFileSync } from 'node:fs';
import type { ProjectFile, ValidationReport } from '@uragan/shared';
import { PROJECT_EXT, ProjectFileZ } from '@uragan/shared';
import { parseJsonc } from './parser.js';
import { issuesReport } from './report.js';
import { validateProjectFile, zodPath } from './validate.js';

export interface LoadResult {
  file: ProjectFile;
  report: ValidationReport;
}

/** 读取工程文件（严格 JSON，UTF-8） */
export function readProjectFile(path: string): LoadResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { file: blankFile('', ''), report: issuesReport([{ code: 'U-9001', severity: 'error', path: '$', message: `读取失败：${message}` }]) };
  }
  return parseProjectText(text, path);
}

/** 解析工程文件文本：结构 + 语义校验，错误时 file 为空工程占位 */
export function parseProjectText(text: string, source = '<text>'): LoadResult {
  const { data, report } = parseJsonc(text);
  if (!report.ok || data === undefined || typeof data !== 'object' || data === null) {
    return { file: blankFile('', ''), report };
  }
  const parsed = ProjectFileZ.safeParse(data);
  if (!parsed.success) {
    const issues = (parsed as { error: { issues: { path: (string | number)[]; message: string }[] } }).error.issues.map((e) => ({
      code: 'U-1002',
      severity: 'error' as const,
      path: zodPath(e.path),
      message: e.message,
    }));
    return { file: blankFile('', ''), report: issuesReport(issues) };
  }
  const semantic = validateProjectFile(parsed.data);
  return {
    file: parsed.data,
    report: { ok: semantic.ok, level: semantic.level, errors: [...report.errors, ...semantic.errors] },
  };
}

/** 写回工程文件（格式化 JSON，UTF-8） */
export function writeProjectFile(path: string, file: ProjectFile): void {
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', 'utf8');
}

/** 确保工程文件带扩展名 */
export function withProjectExt(path: string): string {
  return path.toLowerCase().endsWith(PROJECT_EXT) ? path : `${path}${PROJECT_EXT}`;
}

/** 空白工程占位（供报告使用；对外统一走 engine 的 blankFile） */
function blankFile(id: string, name: string): ProjectFile {
  return {
    schemaVersion: '1',
    project: { id, name, canvas: { width: 1280, height: 720, fps: 30 } },
    pages: [],
  };
}