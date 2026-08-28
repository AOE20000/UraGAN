import type { ValidationReport } from '@uragan/shared';
import { issue, issuesReport, okReport } from './report.js';

export interface ParseResult {
  data: unknown;
  report: ValidationReport;
}

/** 去除 JSONC 的行注释与块注释（字符串内外区分），保留位置用于报错定位 */
export function stripJsonc(src: string): string {
  let out = '';
  let inString = false;
  let quote = '';
  let line = false;
  let block = false;
  let prev = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] ?? '';
    const next = src[i + 1] ?? '';
    if (!inString && !line && !block) {
      if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
        out += ch;
        prev = ch;
        continue;
      }
      if (ch === '/' && next === '/') {
        line = true;
        out += '  ';
        i++;
        prev = '';
        continue;
      }
      if (ch === '/' && next === '*') {
        block = true;
        out += '  ';
        i++;
        prev = '';
        continue;
      }
      out += ch;
      prev = ch;
      continue;
    }
    if (line) {
      if (ch === '\n') {
        line = false;
        out += ch;
      } else out += ' ';
      prev = ch;
      continue;
    }
    if (block) {
      if (ch === '*' && next === '/') {
        block = false;
        out += '  ';
        i++;
      } else out += ch === '\n' ? '\n' : ' ';
      prev = ch;
      continue;
    }
    // inString
    if (ch === '\\' && prev !== '\\') {
      out += ch + (next === '\\' ? next : '');
      if (next === '\\') i++;
      prev = ch;
      continue;
    }
    if (ch === quote && prev !== '\\') {
      inString = false;
      quote = '';
    }
    out += ch;
    prev = ch;
  }
  return out;
}

/** 解析 JSON/JSONC 文本；结构错误归为 U-1001 */
export function parseJsonc(src: string): ParseResult {
  const stripped = stripJsonc(src);
  try {
    return { data: JSON.parse(stripped) as unknown, report: okReport() };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      data: undefined,
      report: issuesReport([issue('U-1001', 'error', '$', `JSON 解析失败：${message}`)]),
    };
  }
}