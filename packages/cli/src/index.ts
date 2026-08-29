#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Command } from 'commander';
import type { Issue, ValidationReport } from '@uragan/shared';
import {
  Uragan,
  blankFile,
  exportSkeleton,
  exportSkeletonText,
  parseSkeletonText,
  readProjectFile,
  withProjectExt,
  writeProjectFile,
} from '@uragan/core';

const program = new Command();
program.version('0.1.0').description('UraGAN · AI 动画视频生成框架（命令面 = MCP 工具面）');
program.option('-p, --project <path>', '工程文件路径', 'project.uragan');

const C = (code: string, message: string, path = '$', hint?: string) => ({ code, severity: 'error' as const, path, message, hint });
const issues = (list: Issue[]): ValidationReport => ({ ok: false, level: 'error', errors: list });

function reportOut(report: ValidationReport, msg: string): void {
  const errors = report.errors.filter((e) => e.severity === 'error');
  if (errors.length > 0) {
    for (const e of errors) console.log(`[${e.code}] ${e.message} @${e.path}${e.hint ? `（${e.hint}）` : ''}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
    for (const w of report.errors.filter((e) => e.severity === 'warning')) {
      console.log(`⚠ [${w.code}] ${w.message} @${w.path}`);
    }
  }
}

function loadFile(target: string) {
  const path = withProjectExt(target);
  if (!existsSync(path)) throw new Error(`工程文件不存在：${path}`);
  return readProjectFile(path).file;
}

function requireProject(opts: unknown): string {
  const o = opts as { project?: string };
  return o.project ?? 'project.uragan';
}

/* ========== 0 建工程 ========== */
program
  .command('init')
  .description('初始化空白工程文件')
  .argument('<path>', '输出路径（自动补 .uragan 后缀）')
  .option('--canvas <WxH>', '画布尺寸，如 1280x720', '1280x720')
  .option('--name <name>', '工程名')
  .action((path: string, opts: { canvas: string; name?: string }) => {
    const [, wRaw, hRaw] = /^(\d+)x(\d+)$/.exec(opts.canvas) ?? [];
    const width = Number(wRaw);
    const height = Number(hRaw);
    if (!width || !height) {
      return reportOut(issues([C('U-9008', '--canvas 格式应为 宽x高，如 1280x720')]), '');
    }
    const file = blankFile();
    file.project.name = opts.name ?? '未命名';
    file.project.canvas = { width, height, fps: 30 };
    const target = withProjectExt(path);
    writeProjectFile(target, file);
    console.log(`已创建空工程：${target}`);
  });

/* ========== 1/2 校验 + 导入展开 ========== */
program
  .command('import')
  .description('导入整体交换配置（或展开形工程文件）→ 工程文件')
  .argument('<config>', '配置文件路径（JSONC）')
  .option('-o, --out <path>', '输出工程文件路径', 'project.uragan')
  .action((config: string, opts: { out: string }) => {
    let text: string;
    try {
      text = readFileSync(config, 'utf8');
    } catch (e) {
      return reportOut(issues([C('U-9001', `读取 ${config} 失败：${(e as Error).message}`)]), '');
    }
    const { file, report } = Uragan.importFromText(text);
    if (!report.ok) return reportOut(report, '');
    const target = withProjectExt(opts.out);
    writeProjectFile(target, file);
    console.log(`已导入 ${file.pages.length} 个页面 → ${target}`);
  });

program
  .command('export')
  .description('导出整体交换配置（dedup 重投影到 $shared）')
  .argument('<path>', '工程文件路径')
  .option('-o, --out <path>', '输出配置路径', 'config.json')
  .action((path: string, opts: { out: string }) => {
    const file = loadFile(path);
    const { config } = Uragan.exportConfig(file);
    writeFileSync(opts.out, JSON.stringify(config, null, 2) + '\n', 'utf8');
    console.log(`已导出整体交换配置（$shared ${Object.keys(config.$shared).length} 项）→ ${opts.out}`);
  });

program
  .command('validate')
  .description('校验配置文件（交换配置或工程文件）')
  .argument('<config>', '配置文件路径')
  .action((config: string) => {
    let text: string;
    try {
      text = readFileSync(config, 'utf8');
    } catch (e) {
      return reportOut(issues([C('U-9001', `读取 ${config} 失败：${(e as Error).message}`)]), '');
    }
    const { report } = Uragan.importFromText(text);
    reportOut(report, `配置有效（${report.errors.length} 处提醒）`);
  });

/* ========== 3 选择排序 ========== */
const pages = program.command('pages').description('页面操作');
pages
  .command('list')
  .description('按播放顺序列出页面')
  .action((_opts: unknown, cmd: Command) => {
    const file = loadFile(requireProject(cmd.optsWithGlobals()));
    Uragan.listPages(file).forEach((p, i) => console.log(`${i + 1}. ${p.pageId}  ${p.name}  <${p.kind}>`));
  });
pages
  .command('reorder <ids...>')
  .description('调整播放顺序（挑选 + 排序）')
  .action((ids: string[], _opts: unknown, cmd: Command) => {
    const target = requireProject(cmd.optsWithGlobals());
    const { file, report } = Uragan.reorder(loadFile(target), ids);
    if (!report.ok) return reportOut(report, '');
    writeProjectFile(target, file);
    console.log(`已调整顺序：${file.pages.map((p) => p.pageId).join(' → ')}`);
  });

/* ========== 单页循环 ========== */
const page = program.command('page').description('单页操作');
page
  .command('get <id>')
  .description('导出单个独立页（含头部 $defs）')
  .option('-o, --out <path>', '输出路径', 'page.json')
  .action((id: string, opts: { out: string }, cmd: Command) => {
    const file = loadFile(requireProject(cmd.optsWithGlobals()));
    const p = Uragan.getPage(file, id);
    if (!p) return reportOut(issues([C('U-9004', `页 ${id} 不存在`)]), '');
    writeFileSync(opts.out, JSON.stringify(p, null, 2) + '\n', 'utf8');
    console.log(`已导出 ${id} → ${opts.out}`);
  });
page
  .command('overwrite <id> <file>')
  .description('用独立页文件暴力覆盖（含 $defs 校验）')
  .action((id: string, file: string, _opts: unknown, cmd: Command) => {
    let input: string;
    try {
      input = readFileSync(file, 'utf8');
    } catch (e) {
      return reportOut(issues([C('U-9001', `读取 ${file} 失败：${(e as Error).message}`)]), '');
    }
    let pageInput: unknown;
    try {
      pageInput = JSON.parse(input);
    } catch {
      return reportOut(issues([C('U-1001', `解析 ${file} 失败`)]), '');
    }
    const target = requireProject(cmd.optsWithGlobals());
    const { file: next, report } = Uragan.overwritePage(loadFile(target), pageInput);
    if (!report.ok) return reportOut(report, '');
    writeProjectFile(target, next);
    console.log(`已覆盖页 ${id}`);
  });

/* ========== 4/5 文案框架 ========== */
const copy = program.command('copy').description('文案框架');
copy
  .command('export')
  .description('导出待填充文案框架（JSON / Markdown 文本形态）')
  .option('-o, --out <path>', '输出路径', 'skeleton.json')
  .option('--format <json|md>', '输出格式：json（默认）或 md（人读文本框架）', 'json')
  .action((opts: { out: string; format: string }, cmd: Command) => {
    const file = loadFile(requireProject(cmd.optsWithGlobals()));
    if (opts.format === 'md') {
      const { text } = exportSkeletonText(file);
      writeFileSync(opts.out, text, 'utf8');
      const n = text.split('\n').filter((l) => /^\| c/.test(l)).length;
      console.log(`已导出文本文案框架（${n} 个占位符）→ ${opts.out}`);
      return;
    }
    const { skeleton } = exportSkeleton(file);
    writeFileSync(opts.out, JSON.stringify(skeleton, null, 2) + '\n', 'utf8');
    const n = skeleton.pages.reduce((s, p) => s + p.items.length, 0);
    console.log(`已导出文案框架（${n} 个占位符）→ ${opts.out}`);
  });
copy
  .command('import <file>')
  .description('导入已填充文案框架（自动识别 JSON / Markdown 文本）')
  .action((file: string, _opts: unknown, cmd: Command) => {
    const raw = readFileSync(file, 'utf8');
    let skeleton;
    try {
      skeleton = JSON.parse(raw);
    } catch {
      const parsed = parseSkeletonText(raw);
      if (!parsed.report.ok) return reportOut(parsed.report, '');
      skeleton = parsed.skeleton;
    }
    const target = requireProject(cmd.optsWithGlobals());
    const { file: next, report } = Uragan.applySkeleton(loadFile(target), skeleton);
    if (!report.ok) return reportOut(report, '');
    writeProjectFile(target, next);
    console.log('✓ 文案填充完成');
  });

/* ========== 共享池查看 ========== */
const shared = program.command('shared').description('共享池');
shared
  .command('list')
  .description('查看当前 $shared（经 dedup 导出投影）')
  .action((_opts: unknown, cmd: Command) => {
    const file = loadFile(requireProject(cmd.optsWithGlobals()));
    const { config } = Uragan.exportConfig(file);
    const keys = Object.keys(config.$shared);
    if (keys.length === 0) return console.log('（空）');
    for (const k of keys) console.log(`${k} = ${JSON.stringify(config.$shared[k])}`);
  });

/* ========== 组件 ========== */
const component = program.command('component').description('全局组件操作');
component
  .command('list')
  .description('列出全局组件')
  .action((_opts: unknown, cmd: Command) => {
    const file = loadFile(requireProject(cmd.optsWithGlobals()));
    const list = file.components ?? [];
    if (list.length === 0) return console.log('（无组件）');
    for (const c of list) console.log(`${c.componentId}  ${c.name}  （$defs ${Object.keys(c.$defs).length} 项）`);
  });
component
  .command('inline <pageId> <componentId>')
  .description('复制代码到页面：组件 code/$defs 并入目标页，断开父子关系')
  .action((pageId: string, componentId: string, _opts: unknown, cmd: Command) => {
    const target = requireProject(cmd.optsWithGlobals());
    const { file, report } = Uragan.inlineComponent(loadFile(target), pageId, componentId);
    const errors = report.errors.filter((e) => e.severity === 'error');
    if (errors.length > 0) return reportOut(report, '');
    writeProjectFile(target, file);
    const warns = report.errors.filter((e) => e.severity === 'warning');
    console.log(`已内联组件 ${componentId} → 页 ${pageId}`);
    for (const w of warns) console.log(`⚠ [${w.code}] ${w.message} @${w.path}`);
  });

/* ========== 6 渲染（M4） ========== */
program
  .command('render')
  .description('渲染视频（Remotion）')
  .argument('[out]', '输出 mp4 路径', 'out.mp4')
  .option('--codec <codec>', '视频编码：h264/h265/vp8/vp9', 'h264')
  .action(async (out: string, opts: { codec: string }, cmd: Command) => {
    const target = requireProject(cmd.optsWithGlobals());
    const file = loadFile(target);
    const { renderProject, vendoredBrowserPath } = await import('@uragan/render');
    const baked = vendoredBrowserPath();
    if (baked) console.log(`✓ 使用内置浏览器（离线渲染可用）：${baked}`);
    else console.log('⚠ 未发现内置浏览器，渲染将尝试联网下载 Chrome Headless Shell');
    try {
      const { output, durationSeconds } = await renderProject(file, {
        output: out,
        projectDir: dirname(target),
        codec: opts.codec as 'h264' | 'h265' | 'vp8' | 'vp9',
        verbose: true,
      });
      console.log(`✓ 渲染完成 → ${output}（${durationSeconds.toFixed(1)}s）`);
    } catch (e) {
      console.error(`error: 渲染失败：${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command('assets')
  .description('资产操作')
  .command('check')
  .description('校验资产引用（渲染前暴露失效引用）')
  .action(async (_opts: unknown, cmd: Command) => {
    const target = requireProject(cmd.optsWithGlobals());
    const file = loadFile(target);
    const { checkAssets } = await import('@uragan/render');
    const { ok, issues } = await checkAssets(file, dirname(target), 'assets');
    if (issues.length === 0) return console.log('✓ 资产引用全部有效');
    for (const i of issues) console.log(`${i.severity === 'error' ? '[error]' : '[warn ]'} [${i.code}] ${i.message} @${i.path}`);
    if (!ok) process.exitCode = 1;
  });

program
  .command('tui')
  .description('启动交互式终端界面（TUI，当前窗口渲染）')
  .action(async (_opts: unknown, cmd: Command) => {
    const target = requireProject(cmd.optsWithGlobals());
    const { launchTui } = await import('./tui/index.js');
    process.exitCode = await launchTui(target);
  });

program
  .command('gui')
  .description('以 GUI 模式启动（预留入口：原生 GUI 将在未来版本提供）')
  .action(() => {
    console.error('GUI 模式尚未实现：未来将以原生方式提供（实现方案 Qt/GTK 等待定）。当前交互界面请使用：uragan tui');
    process.exitCode = 1;
  });

program
  .command('serve-mcp')
  .description('启动 MCP Server（stdio，工具面 = 命令面）')
  .action(async () => {
    const { startServer } = await import('@uragan/mcp');
    console.error('UraGAN MCP Server 启动（stdio）…');
    await startServer();
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});