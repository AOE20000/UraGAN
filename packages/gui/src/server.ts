#!/usr/bin/env node
import { createHttp } from './http.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Uragan, readProjectFile, withProjectExt, writeProjectFile } from '@uragan/core';
import type { CopySkeleton, ValidationReport } from '@uragan/shared';

export { withProjectExt };

const htmlPath = fileURLToPath(new URL('../public/index.html', import.meta.url));

export interface GuiOptions {
  /** 工程文件路径（.uragan） */
  project: string;
  /** 监听端口 */
  port: number;
}

export interface RenderState {
  running: boolean;
  done: boolean;
  output: string;
  durationSeconds: number;
  error: string;
}

/** 启动 M7 最小 GUI：静态服务 + JSON API（命令面 = core 能力面） */
export async function startGui(opts: GuiOptions): Promise<{ port: number; url: string }> {
  const projectPath = withProjectExt(opts.project);
  if (!existsSync(projectPath)) throw new Error(`工程文件不存在：${projectPath}`);
  const projectDir = dirname(resolve(projectPath));
  const state: RenderState = { running: false, done: false, output: '', durationSeconds: 0, error: '' };

  const load = (): ReturnType<typeof readProjectFile>['file'] => readProjectFile(projectPath).file;
  const save = (file: ReturnType<typeof load>): void => writeProjectFile(projectPath, file);
  const bad = (report: ValidationReport): { status: number; body: ValidationReport } => ({ status: 400, body: report });

  const server = createHttp();

  /* ---------- 页面 ---------- */
  server.get('/', () => ({ status: 200, body: readFileSync(htmlPath, 'utf8'), type: 'html' as const }));

  /* ---------- 工程信息 ---------- */
  server.get('/api/project', () => {
    const file = load();
    return {
      status: 200,
      body: {
        schemaVersion: file.schemaVersion,
        name: file.project.name,
        canvas: file.project.canvas,
        pages: Uragan.listPages(file),
      },
    };
  });

  /* ---------- 排序 ---------- */
  server.post('/api/reorder', async (req) => {
    const { ids } = (await req.json()) as { ids?: string[] };
    const { file, report } = Uragan.reorder(load(), ids ?? []);
    if (!report.ok) return bad(report);
    save(file);
    return { status: 200, body: { ok: true, pages: file.pages.map((p) => p.pageId) } };
  });

  /* ---------- 单页循环 ---------- */
  server.get('/api/page', (req) => {
    const pageId = req.query.get('id') ?? '';
    const p = Uragan.getPage(load(), pageId);
    return p ? { status: 200, body: p } : { status: 404, body: { ok: false, message: `页 ${pageId} 不存在` } };
  });

  server.post('/api/page', async (req) => {
    const pageInput: unknown = await req.json();
    const { file, report } = Uragan.overwritePage(load(), pageInput);
    if (!report.ok) return bad(report);
    save(file);
    return { status: 200, body: { ok: true } };
  });

  /* ---------- 文案框架 ---------- */
  server.get('/api/skeleton', () => ({ status: 200, body: Uragan.exportSkeleton(load()).skeleton }));

  server.post('/api/skeleton', async (req) => {
    const skeleton = (await req.json()) as CopySkeleton;
    const { file, report } = Uragan.applySkeleton(load(), skeleton);
    if (!report.ok) return bad(report);
    save(file);
    return { status: 200, body: { ok: true } };
  });

  /* ---------- 共享池 / 组件 ---------- */
  server.get('/api/shared', () => {
    const { config, report } = Uragan.exportConfig(load());
    return report.ok ? { status: 200, body: { ok: true, shared: config.$shared } } : { status: 400, body: report };
  });

  server.get('/api/components', () => {
    const file = load();
    return { status: 200, body: { ok: true, components: (file.components ?? []).map((c) => ({ componentId: c.componentId, name: c.name, defs: Object.keys(c.$defs).length, hasCode: Boolean(c.code) })) } };
  });

  server.post('/api/component/inline', async (req) => {
    const { pageId, componentId } = (await req.json()) as { pageId?: string; componentId?: string };
    if (!pageId || !componentId) return { status: 400, body: { ok: false, message: '需要 pageId 与 componentId' } };
    const { file, report } = Uragan.inlineComponent(load(), pageId, componentId);
    if (!report.ok) return { status: 400, body: report };
    save(file);
    return { status: 200, body: { ok: true, warnings: report.errors.filter((e) => e.severity === 'warning') } };
  });

  /* ---------- 整体配置循环（导入覆盖 / 导出下载） ---------- */
  server.post('/api/import', async (req) => {
    const { configText } = (await req.json()) as { configText?: string };
    if (typeof configText !== 'string' || configText.trim().length === 0) return { status: 400, body: { ok: false, message: '缺少配置文本' } };
    const { file, report } = Uragan.importFromText(configText);
    if (!report.ok) return { status: 400, body: report };
    save(file);
    return { status: 200, body: { ok: true, pages: file.pages.length } };
  });

  server.get('/api/export', () => {
    const { config, report } = Uragan.exportConfig(load());
    return report.ok ? { status: 200, body: { ok: true, config } } : { status: 400, body: report };
  });

  /* ---------- 资产体检 ---------- */
  server.post('/api/assets/check', async () => {
    const { checkAssets } = await import('@uragan/render');
    const { ok, issues } = await checkAssets(load(), projectDir, 'assets');
    return { status: 200, body: { ok, issues } };
  });

  /* ---------- 渲染（后台执行 + 状态轮询） ---------- */
  server.post('/api/render', async (req) => {
    if (state.running) return { status: 409, body: { ok: false, message: '渲染进行中' } };
    try {
      const raw = await req.json().catch(() => ({}));
      const out = (raw as { out?: unknown }).out ? String((raw as { out?: unknown }).out).trim() : 'render.mp4';
      state.running = true;
      state.done = false;
      state.error = '';
      state.output = join(projectDir, out);
      void (async () => {
        try {
          const { renderProject } = await import('@uragan/render');
          const r = await renderProject(load(), { output: state.output, projectDir });
          state.durationSeconds = r.durationSeconds;
          state.done = true;
        } catch (e: unknown) {
          state.error = (e as Error).message;
          state.done = true;
        } finally {
          state.running = false;
        }
      })();
      return { status: 202, body: { ok: true, output: state.output } };
    } catch (e: unknown) {
      return { status: 500, body: { ok: false, message: `渲染调度失败：${(e as Error).message}` } };
    }
  });

  server.get('/api/render/status', () => ({ status: 200, body: state }));

  /* ---------- 渲染产物视频流 ---------- */
  server.stream('/video/', (req) => {
    const rel = decodeURIComponent(req.pathname.slice('/video/'.length));
    const file = join(projectDir, rel);
    if (!existsSync(file)) return undefined;
    return { path: file, mime: 'video/mp4' };
  });

  return server.listen(opts.port);
}

/* ---------- CLI 入口 ---------- */
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry).replace(/\\/g, '/') === fileURLToPath(import.meta.url).replace(/\\/g, '/');
  } catch {
    return false;
  }
})();

if (isMain) {
  const arg = (flag: string): string | undefined => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const portArg = Number(arg('--port') ?? '5173');
  startGui({ project: arg('--project') ?? 'project.uragan', port: Number.isFinite(portArg) ? portArg : 5173 })
    .then(({ url }) => console.log(`UraGAN GUI 已启动：${url}`))
    .catch((e: unknown) => {
      console.error(`启动失败：${(e as Error).message}`);
      process.exitCode = 1;
    });
}