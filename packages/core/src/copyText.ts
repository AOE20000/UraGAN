import type { CopyItem, CopySkeleton, Page, ProjectFile, ValidationReport } from '@uragan/shared';
import { SCHEMA_VERSION, SKELETON_KIND } from '@uragan/shared';
import { issue, issuesReport, okReport } from './report.js';
import { copyFieldsOf } from './validate.js';

/**
 * 文案框架的 Markdown 文本形态（设计文档 §3.9）：
 * - 程序/权威形态仍是 §3.6 的 JSON；这里仅是人读表单的导出/导入兼容层。
 * - 普通用户只看到表格与中文列名；多行/含符号内容承载于文末围栏块，单元格以 f@编号 引用。
 * - 代码块内容零转义；表头/分隔行/说明行程序忽略。
 */

export interface SkeletonTextResult {
  text: string;
  report: ValidationReport;
}

export interface ParseSkeletonTextResult {
  skeleton: CopySkeleton;
  report: ValidationReport;
}

/** 表格列定义（导出与解析共用同一列序） */
const COLUMNS = ['节点', '位置', '类型', '提示语', '当前值', '填写'] as const;
const NODE = 0;
const KIND = 2;
const PLACEHOLDER = 3;
const SAMPLE = 4;
const FILL = 5;

const convert = (raw: string, kind: CopyItem['kind']): { ok: true; value: string | number | boolean } | { ok: false } => {
  if (kind === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) && !/ /.test(raw) ? { ok: true, value: n } : { ok: false };
  }
  if (kind === 'boolean') {
    if (raw === 'true') return { ok: true, value: true };
    if (raw === 'false') return { ok: true, value: false };
    return { ok: false };
  }
  return { ok: true, value: raw };
};

function cellEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/** 表格数据行拆列：先保护转义（\| 与 \\ 占位），再按 | 拆，最后还原 */
function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  const protectedBody = body.replace(/\\\|/g, '\u0000').replace(/\\\\/g, '\u0001');
  return protectedBody.split('|').map((c) => c.trim().replace(/\u0000/g, '|').replace(/\u0001/g, '\\'));
}

const CID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/* ------------------------------------------------------------------ */
/* 导出                                                                 */
/* ------------------------------------------------------------------ */

/** 生成 Markdown 文本框架。所有占位符 1 行 1 项；多行 sample 写入围栏块以 @编号 引用。 */
export function exportSkeletonText(file: ProjectFile): SkeletonTextResult {
  const fences: string[] = [];
  const fenceRef = (s: string): string => {
    const idx = fences.length + 1;
    fences.push(s);
    return `@${idx}`;
  };

  const pageBlocks: string[] = [];
  for (const page of file.pages) {
    const items: CopyItem[] = [];
    for (const { name, field } of copyFieldsOf(page)) {
      const cid = field.cid;
      if (!cid) continue;
      if (field.kind === 'color' || field.kind === 'asset') continue;
      const kind: CopyItem['kind'] = field.kind === 'number' ? 'number' : field.kind === 'boolean' ? 'boolean' : 'text';
      items.push({
        pageId: page.pageId,
        cid,
        field: 'value',
        kind,
        label: field.label ?? name,
        sample: field.value !== undefined ? String(field.value) : undefined,
        placeholder: field.placeholder,
      });
    }

    const rows: string[] = [
      `| ${COLUMNS.join(' | ')} |`,
      `|${COLUMNS.map(() => '---').join('|')}|`,
      ...items.map((it) => {
        const sample = it.sample;
        const sampleCell = sample !== undefined && (sample.includes('\n') || sample.length > 60)
          ? fenceRef(sample)
          : sample ?? '';
        return `| ${it.cid} | ${cellEscape(it.label ?? '')} | ${it.kind} | ${cellEscape(it.placeholder ?? '')} | ${cellEscape(sampleCell)} |  |`;
      }),
    ];
    const kind = page.kind;
    pageBlocks.push(`## 页面 ${page.pageId} · ${page.name}（${kind}）\n\n${rows.join('\n')}`);
  }

  const fenceSection =
    fences.length > 0
      ? `## 代码块区（多行 / 含符号内容）\n\n${fences
          .map((s) => `\`\`\`text {:id ${fences.indexOf(s) + 1}}` + '\n' + s + '\n```')
          .join('\n\n')}`
      : '';

  const head = `# 文案框架 · ${file.project.name}（UraGAN copy-skeleton v${SCHEMA_VERSION}）\n\n> 使用说明：在「填写」列直接写文案（单行）；多行/含符号内容写在文末代码块区，\n> 并在填写列写 f@编号。留空的填写项不会被改动。\n\n${pageBlocks.join('\n\n')}${fenceSection ? '\n\n' + fenceSection : ''}\n`;
  return { text: head, report: okReport() };
}

/* ------------------------------------------------------------------ */
/* 解析                                                                 */
/* ------------------------------------------------------------------ */

interface ParsedRow {
  cid: string;
  kind: string;
  placeholder: string;
  sample: string;
  fill: string;
}

/** 解析 Markdown 文本 → CopySkeleton（带 value），可直接喂 applySkeleton。 */
export function parseSkeletonText(text: string): ParseSkeletonTextResult {
  const errors: ValidationReport['errors'] = [];
  const rows: { pageId: string; row: ParsedRow; line: number }[] = [];
  let currentPage = '';
  const fences = new Map<number, string>();
  let activeFence: { id: number; lines: string[] } | null = null;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (activeFence) {
      if (/^```+/.test(line.trim())) {
        fences.set(activeFence.id, activeFence.lines.join('\n'));
        activeFence = null;
      } else {
        activeFence.lines.push(line);
      }
      continue;
    }

    const fenceOpen = /^```+text\s*\{:id\s+(\d+)\}\s*$/.exec(line.trim());
    if (fenceOpen) {
      activeFence = { id: Number(fenceOpen[1]!), lines: [] };
      continue;
    }

    const pageHead = /^##+\s*页面\s+([A-Za-z][\w-]*)/.exec(line);
    if (pageHead) {
      currentPage = pageHead[1]!;
      continue;
    }
    if (!line.trim().startsWith('|')) continue; // 头部/说明/空行忽略

    const cells = splitRow(line);
    const cid = cells[NODE] ?? '';
    if (!CID_RE.test(cid)) continue; // 表头行 #/节点/空 与分隔行
    if (cells.some((c) => /^-+$/.test(c)) ) continue; // 分隔行兜底
    if (!currentPage) {
      errors.push(issue('U-3021', 'error', `L${i + 1}`, `表格行 cid=${cid} 出现在任何「## 页面」之前`, '文本框架的每个页面小节需以「## 页面 <pageId>」开头'));
      continue;
    }
    rows.push({
      pageId: currentPage,
      row: {
        cid,
        kind: cells[KIND] ?? '',
        placeholder: cells[PLACEHOLDER] ?? '',
        sample: cells[SAMPLE] ?? '',
        fill: cells[FILL] ?? '',
      },
      line: i + 1,
    });
  }
  if (activeFence) errors.push(issue('U-3022', 'error', '$', '代码块未闭合（缺少结尾 ```）'));

  const pages = new Map<string, CopyItem[]>();
  for (const { pageId, row, line } of rows) {
    const items = pages.get(pageId) ?? [];
    const fill = row.fill;
    let value: string | number | boolean | undefined;
    if (fill.length === 0) {
      value = undefined; // 留空 → 跳过（applySkeleton 不写入）
    } else {
      const m = /^f@(\d+)$/.exec(fill);
      if (m) {
        const block = fences.get(Number(m[1]!));
        if (block === undefined) {
          errors.push(issue('U-3023', 'error', `L${line}`, `填写引用了不存在的代码块 f@${m[1]}`));
        } else {
          const c = convert(block, kindOf(row.kind));
          if (!c.ok) errors.push(issue('U-3004', 'error', `L${line}`, `代码块内容无法转为 ${row.kind} 类型的填写值`));
          else value = c.value;
        }
      } else {
        const c = convert(fill, kindOf(row.kind));
        if (!c.ok) errors.push(issue('U-3004', 'error', `L${line}`, `填写列「${row.fill}」不是合法的 ${row.kind} 值`));
        else value = c.value;
      }
    }
    items.push({
      pageId,
      cid: row.cid,
      field: 'value',
      kind: kindOf(row.kind),
      ...(value !== undefined ? { value } : {}),
    });
    pages.set(pageId, items);
  }

  const result: CopySkeleton = {
    schemaVersion: SCHEMA_VERSION,
    kind: SKELETON_KIND,
    pages: [...pages.entries()].map(([pageId, items]) => ({ pageId, items })),
  };
  return { skeleton: result, report: errors.length > 0 ? issuesReport(errors) : okReport() };
}

function kindOf(raw: string): CopyItem['kind'] {
  if (raw === 'number') return 'number';
  if (raw === 'boolean') return 'boolean';
  return 'text';
}

/** 骨架 JSON 对象是否可序列化为文本 → 便于 CLI/MCP 自动探测（简化判定：非 JSON） */
export function looksLikeSkeletonText(text: string): boolean {
  const head = text.trimStart();
  return head.startsWith('#') && /##\s*页面/.test(text);
}

export type { Page };
export type { ValidationReport };