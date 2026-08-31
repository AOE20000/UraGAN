#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import type { Issue, ProjectFile, ValidationReport } from '@uragan/shared';
import {
  Uragan,
  blankFile,
  exportSkeleton,
  exportSkeletonText,
  outputDirFor,
  parseSkeletonText,
  withProjectExt,
  writeProjectFile,
  type OpenResult,
} from '@uragan/core';

const program = new Command();
program.version('0.1.0').description('UraGAN · AI 动画视频生成框架（选页面、填文案、导出视频；命令面 = MCP 工具面）');
program.option('-p, --project <path>', '工程路径（目录工程或 .uragan 文件）', 'project.uragan');

const C = (code: string, message: string, path = '$', hint?: string) => ({ code, severity: 'error' as const, path, message, hint });
const issues = (list: Issue[]): ValidationReport => ({ ok: false, level: 'error', errors: list });

function reportOut(report: ValidationReport, msg: string): void {
  const errors = report.errors.filter((e) => e.severity === 'error');
  if (errors.length > 0) {
    for (const e of errors) console.log(`✗ [${e.code}] ${e.message} @${e.path}${e.hint ? `（${e.hint}）` : ''}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
    for (const w of report.errors.filter((e) => e.severity === 'warning')) {
      console.log(`⚠ [${w.code}] ${w.message} @${w.path}`);
    }
  }
}

/**
 * 打开工程（与 TUI 同一套语义）：
 * - 目录工程（<名>.uragan/ 或 <名>.uragan.work/）→ 聚合读取
 * - .uragan 单文件 → 导入到 <源名>.uragan.work/ 工作目录后读取（原文件留作持久存储）
 * 必须走这里而不是直接 readProjectFile，否则 CLI 读到的是可能已过期的持久文件，与 TUI 看到的内容不一致。
 */
function loadProject(target: string): OpenResult {
  const path = withProjectExt(target);
  if (!existsSync(path)) throw new Error(`工程文件不存在：${path}`);
  const r = Uragan.openProject(path);
  if (r.report.errors.some((e) => e.severity === 'error') && r.file.pages.length === 0) {
    throw new Error(r.report.errors.map((e) => `[${e.code}] ${e.message}`).join('；'));
  }
  return r;
}

/** 写回工程：落工程目录；有持久文件时一并导出回原 .uragan（CLI 是显式操作，等价于「保存」） */
function saveProject(r: OpenResult, file: ProjectFile): void {
  writeProjectFile(r.projectPath, file);
  if (r.durablePath) writeProjectFile(r.durablePath, file);
}

/** 产出 / 资产目录（assets/、render.mp4） */
const assetDir = (r: OpenResult): string => outputDirFor(r.projectPath, r.durablePath);

function requireProject(opts: unknown): string {
  const o = opts as { project?: string };
  return o.project ?? 'project.uragan';
}

/** 是否交互终端（可进 TUI） */
const isInteractive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** 命令行里是否显式指定了 -p/--project */
function hasExplicitProject(): boolean {
  return process.argv.some((a) => a === '-p' || a === '--project' || a.startsWith('--project=') || /^-p.+$/.test(a));
}

/**
 * 安装目录保护：资源管理器双击 bin/uragan.cmd 时工作目录就是安装目录，
 * 工程建在这里会在下次打包（rm -rf build/uragan）时被清空。
 * 因此「未显式指定 -p 且当前目录位于安装目录内」时，切到用户工作区。
 */
function ensureWorkspace(): void {
  const self = dirname(fileURLToPath(import.meta.url)); // <安装根>/node_modules/@uragan/cli/dist
  const root = resolve(self, '..', '..', '..', '..'); // dist → cli → @uragan → node_modules → 安装根
  const cwd = process.cwd();
  if (cwd !== root && !cwd.startsWith(root + sep)) return;
  const docs = join(homedir(), 'Documents');
  const base = existsSync(docs) ? join(docs, 'UraGAN') : join(homedir(), 'UraGAN');
  const dir = process.env.URAGAN_WORKDIR ? resolve(process.env.URAGAN_WORKDIR) : base;
  if (dir === cwd) return;
  try {
    mkdirSync(dir, { recursive: true });
    process.chdir(dir);
    console.error(`⚠ 当前目录是程序安装目录，已切换到工作区：${dir}`);
  } catch (e) {
    console.error(`⚠ 无法切换到工作区 ${dir}：${(e as Error).message}`);
  }
}

/** 启动 TUI 的统一入口（先做工作区保护，再交给 ink） */
async function runTui(cmd: Command): Promise<void> {
  if (!hasExplicitProject()) ensureWorkspace();
  const target = requireProject(cmd.optsWithGlobals());
  const { launchTui } = await import('./tui/index.js');
  process.exitCode = await launchTui(target);
}

/* ========== 0 建工程 ========== */
program
  .command('init')
  .description('新建空白工程：生成 <path>.uragan 目录工程（每页一个独立文件）')
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
    console.log(`✓ 已创建空工程：${target}`);
  });

/* ========== 1/2 校验 + 导入展开 ========== */
program
  .command('import')
  .description('导入交换配置（$shared 形态）整体创建或覆盖工程，可指定输出名'
    + '（与「打开工程」不同：打开是把 .uragan 导入到 <名>.uragan.work 工作目录、原文件留作持久存储）')
  .argument('<config>', '配置文件路径（JSONC）')
  .option('-o, --out <path>', '输出工程路径（生成 <out>.uragan 目录工程）', 'project.uragan')
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
    console.log(`✓ 已导入 ${file.pages.length} 个页面 → ${target}`);
  });

program
  .command('export')
  .description('导出整体交换配置（$shared 去重视图：各页重复定义提为共享池，'
    + '便于一次性整体改主色/字体等共享值；工程本体不受影响）')
  .argument('<path>', '工程路径（目录工程 或 .uragan 持久文件）')
  .option('-o, --out <path>', '输出配置路径', 'config.json')
  .action((path: string, opts: { out: string }) => {
    const file = loadProject(path).file;
    const { config } = Uragan.exportConfig(file);
    writeFileSync(opts.out, JSON.stringify(config, null, 2) + '\n', 'utf8');
    console.log(`✓ 已导出整体交换配置（$shared ${Object.keys(config.$shared).length} 项）→ ${opts.out}`);
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
  .description('按播放顺序列出页面（第 3 步：选择排序）')
  .action((_opts: unknown, cmd: Command) => {
    const file = loadProject(requireProject(cmd.optsWithGlobals())).file;
    Uragan.listPages(file).forEach((p, i) => console.log(`${i + 1}. ${p.pageId}  ${p.name}  <${p.kind}>`));
  });
pages
  .command('reorder <ids...>')
  .description('调整播放顺序（挑选 + 排序，第 3 步）')
  .action((ids: string[], _opts: unknown, cmd: Command) => {
    const target = requireProject(cmd.optsWithGlobals());
    const opened = loadProject(target);
    const { file, report } = Uragan.reorder(opened.file, ids);
    if (!report.ok) return reportOut(report, '');
    saveProject(opened, file);
    console.log(`✓ 已调整顺序：${file.pages.map((p) => p.pageId).join(' → ')}`);
  });

/* ========== 单页循环 ========== */
const page = program.command('page').description('单页操作');
page
  .command('get <id>')
  .description('导出单个独立页（含头部 $defs）')
  .option('-o, --out <path>', '输出路径', 'page.json')
  .action((id: string, opts: { out: string }, cmd: Command) => {
    const file = loadProject(requireProject(cmd.optsWithGlobals())).file;
    const p = Uragan.getPage(file, id);
    if (!p) return reportOut(issues([C('U-9004', `页 ${id} 不存在`)]), '');
    writeFileSync(opts.out, JSON.stringify(p, null, 2) + '\n', 'utf8');
    console.log(`✓ 已导出 ${id} → ${opts.out}`);
  });
page
  .command('overwrite <id> <file>')
  .description('用独立页文件覆盖指定页（含 $defs 校验）')
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
    const opened = loadProject(target);
    const { file: next, report } = Uragan.overwritePage(opened.file, pageInput);
    if (!report.ok) return reportOut(report, '');
    saveProject(opened, next);
    console.log(`✓ 已覆盖页 ${id}`);
  });

/* ========== 4/5 文案框架 ========== */
const copy = program.command('copy').description('文案框架');
copy
  .command('export')
  .description('导出待填充文案框架（JSON 权威形态 / Markdown 人读表单）')
  .option('-o, --out <path>', '输出路径', 'skeleton.json')
  .option('--format <json|md>', '输出格式：json（默认）或 md（人读文本框架）', 'json')
  .action((opts: { out: string; format: string }, cmd: Command) => {
    const file = loadProject(requireProject(cmd.optsWithGlobals())).file;
    if (opts.format === 'md') {
      const { text } = exportSkeletonText(file);
      writeFileSync(opts.out, text, 'utf8');
      const n = text.split('\n').filter((l) => /^\| c/.test(l)).length;
      console.log(`✓ 已导出文本文案框架（${n} 个占位符）→ ${opts.out}`);
      return;
    }
    const { skeleton } = exportSkeleton(file);
    writeFileSync(opts.out, JSON.stringify(skeleton, null, 2) + '\n', 'utf8');
    const n = skeleton.pages.reduce((s, p) => s + p.items.length, 0);
    console.log(`✓ 已导出文案框架（${n} 个占位符）→ ${opts.out}`);
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
    const opened = loadProject(target);
    const { file: next, report } = Uragan.applySkeleton(opened.file, skeleton);
    if (!report.ok) return reportOut(report, '');
    saveProject(opened, next);
    console.log('✓ 文案填充完成');
  });

/* ========== 共享池查看 ========== */
const shared = program.command('shared').description('共享池');
shared
  .command('list')
  .description('查看当前 $shared（经 dedup 导出投影）')
  .action((_opts: unknown, cmd: Command) => {
    const file = loadProject(requireProject(cmd.optsWithGlobals())).file;
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
    const file = loadProject(requireProject(cmd.optsWithGlobals())).file;
    const list = file.components ?? [];
    if (list.length === 0) return console.log('（无组件）');
    for (const c of list) console.log(`${c.componentId}  ${c.name}  （$defs ${Object.keys(c.$defs).length} 项）`);
  });
component
  .command('inline <pageId> <componentId>')
  .description('复制代码到页面：组件 code/$defs 并入目标页，断开父子关系')
  .action((pageId: string, componentId: string, _opts: unknown, cmd: Command) => {
    const target = requireProject(cmd.optsWithGlobals());
    const opened = loadProject(target);
    const { file, report } = Uragan.inlineComponent(opened.file, pageId, componentId);
    const errors = report.errors.filter((e) => e.severity === 'error');
    if (errors.length > 0) return reportOut(report, '');
    saveProject(opened, file);
    const warns = report.errors.filter((e) => e.severity === 'warning');
    console.log(`✓ 已内联组件 ${componentId} → 页 ${pageId}`);
    for (const w of warns) console.log(`⚠ [${w.code}] ${w.message} @${w.path}`);
  });

/* ========== 6 渲染（M4） ========== */
program
  .command('render')
  .description('渲染视频（Remotion 合成，内置离线浏览器）')
  .argument('[out]', '输出 mp4 路径', 'out.mp4')
  .option('--codec <codec>', '视频编码：h264/h265/vp8/vp9', 'h264')
  .action(async (out: string, opts: { codec: string }, cmd: Command) => {
    const target = requireProject(cmd.optsWithGlobals());
    const opened = loadProject(target);
    const file = opened.file;
    // 单文件版（uragan.exe）未打包 Remotion：给出可读提示，而不是裸崩
    let renderApi;
    try {
      renderApi = await import('@uragan/render');
    } catch {
      console.error('✗ 渲染引擎（Remotion）未随此版本打包：单文件版不含渲染依赖。');
      console.error('  请使用完整分发包（pnpm run pack）或安装版后执行渲染。');
      process.exitCode = 1;
      return;
    }
    const { renderProject, vendoredBrowserPath } = renderApi;
    const baked = vendoredBrowserPath();
    if (baked) console.log(`✓ 使用内置浏览器（离线渲染可用）：${baked}`);
    else console.log('⚠ 未发现内置浏览器，渲染将尝试联网下载 Chrome Headless Shell');
    try {
      const { output, durationSeconds } = await renderProject(file, {
        output: out,
        projectDir: assetDir(opened),
        codec: opts.codec as 'h264' | 'h265' | 'vp8' | 'vp9',
        verbose: true,
      });
      console.log(`✓ 渲染完成 → ${output}（${durationSeconds.toFixed(1)}s）`);
    } catch (e) {
      console.error(`✗ 渲染失败：${(e as Error).message}`);
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
    const opened = loadProject(target);
    let checkAssets;
    try {
      ({ checkAssets } = await import('@uragan/render'));
    } catch {
      console.error('✗ 资产体检依赖渲染包（Remotion），单文件版不含渲染依赖。');
      process.exitCode = 1;
      return;
    }
    const { ok, issues } = await checkAssets(opened.file, assetDir(opened), 'assets');
    if (issues.length === 0) return console.log('✓ 资产引用全部有效');
    for (const i of issues) console.log(`${i.severity === 'error' ? '✗' : '⚠'} [${i.code}] ${i.message} @${i.path}`);
    if (!ok) process.exitCode = 1;
  });

program
  .command('tui')
  .description('启动交互式终端界面（TUI，当前窗口渲染）')
  .action(async (_opts: unknown, cmd: Command) => {
    await runTui(cmd);
  });

/**
 * 无子命令（典型：资源管理器双击 uragan.cmd）：
 * - 交互终端 → 直接进 TUI（否则窗口一闪而过，看起来像「闪退」）
 * - 非交互（管道/脚本）→ 打印帮助
 * - 带未知操作数 → 报错（不误当 TUI 启动）
 */
program.action(async (_opts: unknown, cmd: Command) => {
  const rest = cmd.args ?? [];
  if (rest.length > 0) {
    console.error(`✗ 未知命令「${rest.join(' ')}」；运行 uragan --help 查看命令列表`);
    process.exitCode = 1;
    return;
  }
  if (!isInteractive()) {
    program.outputHelp();
    return;
  }
  await runTui(cmd);
});

program
  .command('gui')
  .description('以 GUI 模式启动（预留入口：原生 GUI 将在未来版本提供）')
  .action(() => {
    console.error('✗ GUI 模式尚未实现：未来将以原生方式提供（实现方案 Qt/GTK 等待定）。当前交互界面请使用：uragan tui');
    process.exitCode = 1;
  });

program
  .command('serve-mcp')
  .description('启动 MCP Server（stdio；工具面 = 命令面）')
  .action(async () => {
    const { startServer } = await import('@uragan/mcp');
    console.error('UraGAN MCP Server 启动（stdio）…');
    await startServer();
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exitCode = 1;
});