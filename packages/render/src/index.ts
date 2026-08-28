import { fileURLToPath } from 'node:url';
import type { ProjectFile } from '@uragan/shared';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { checkAssets, collectAssetRefs, resolveAssetSrc } from './assets.js';
import { browserForRender, vendoredBrowserPath } from './browser.js';
import { progressFromFrames } from './progress.js';
import { COMPOSITION_ID } from './remotion/Root.js';
import { translateProject } from './translate.js';

export interface RenderOptions {
  /** 输出 mp4 路径（必填） */
  output: string;
  /** 工程文件所在目录（相对路径资产以此解析） */
  projectDir?: string;
  /** 视频编码，默认 h264 */
  codec?: 'h264' | 'h265' | 'vp8' | 'vp9';
  /** 控制台/后台可见的并发度（委托 Remotion，v1 默认） */
  concurrency?: number;
  /** 显式指定浏览器可执行文件（缺省自动使用包内内置 chrome-headless-shell，离线可用） */
  browserExecutable?: string;
  /** 渲染进度回调（0-1），用于 CLI/GUI/TUI 进度条 */
  onProgress?: (progress: number) => void;
  /** 渲染前打印浏览器选择等诊断信息 */
  verbose?: boolean;
}

export interface RenderResult {
  output: string;
  /** 全片时长（秒） */
  durationSeconds: number;
  /** 实际使用的浏览器可执行文件（undefined = Remotion 默认下载/缓存） */
  browserExecutable?: string;
}

/**
 * 渲染视频（设计文档 §6 完整管线，离线优先）：
 * 1. translateProject 组装 render-config（顺序/时长/canvas/fps）
 * 2. bundle 编译 Remotion 工程（入口 = 本包 remotion/entry）
 * 3. 解析浏览器：优先包内内置 chrome-headless-shell（随包发布，无需联网）
 * 4. selectComposition + renderMedia → out.mp4
 * 资产按 §3.8 在翻译层解析（URL 原样 / 相对路径 → projectDir）。
 */
export async function renderProject(file: ProjectFile, opts: RenderOptions): Promise<RenderResult> {
  const scenes = translateProject(file, { projectDir: opts.projectDir });
  const entryPoint = fileURLToPath(new URL('./remotion/entry.js', import.meta.url));
  const serveUrl = await bundle({ entryPoint });
  const inputProps = { scenes };
  const browserExecutable = browserForRender({ browserExecutable: opts.browserExecutable });
  if (opts.verbose) {
    if (browserExecutable) process.stderr.write(`[render] 使用内置浏览器（离线）：${browserExecutable}\n`);
    else process.stderr.write('[render] 未发现内置浏览器，委托 Remotion 下载/使用缓存\n');
  }
  const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, browserExecutable });
  await renderMedia({
    composition,
    serveUrl,
    codec: opts.codec ?? 'h264',
    outputLocation: opts.output,
    inputProps,
    ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
    ...(browserExecutable ? { browserExecutable } : {}),
    ...(opts.onProgress
      ? {
          onProgress: (p: { renderedFrames?: number; encodedFrames?: number; totalFrames?: number }) => {
            opts.onProgress?.(progressFromFrames(p));
          },
        }
      : {}),
    overwrite: true,
  });
  return {
    output: opts.output,
    durationSeconds: composition.durationInFrames / composition.fps,
    ...(browserExecutable ? { browserExecutable } : {}),
  };
}

export { checkAssets, collectAssetRefs, resolveAssetSrc, translateProject, vendoredBrowserPath };
export type { RenderedProject, SceneAnimation, SceneNode, SceneStyle, TranslateOptions } from './types.js';