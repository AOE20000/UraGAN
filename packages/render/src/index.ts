import { fileURLToPath } from 'node:url';
import type { ProjectFile } from '@uragan/shared';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { checkAssets, collectAssetRefs, resolveAssetSrc } from './assets.js';
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
}

export interface RenderResult {
  output: string;
  /** 全片时长（秒） */
  durationSeconds: number;
}

/**
 * 渲染视频（设计文档 §6 完整管线）：
 * 1. translateProject 组装 render-config（顺序/时长/canvas/fps）
 * 2. bundle 编译 Remotion 工程（入口 = 本包 remotion/entry）
 * 3. selectComposition + renderMedia → out.mp4
 * 资产按 §3.8 在翻译层解析（URL 原样 / 相对路径 → projectDir）。
 */
export async function renderProject(file: ProjectFile, opts: RenderOptions): Promise<RenderResult> {
  const scenes = translateProject(file, { projectDir: opts.projectDir });
  const entryPoint = fileURLToPath(new URL('./remotion/entry.js', import.meta.url));
  const serveUrl = await bundle({ entryPoint });
  const inputProps = { scenes };
  const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps });
  await renderMedia({
    composition,
    serveUrl,
    codec: opts.codec ?? 'h264',
    outputLocation: opts.output,
    inputProps,
    ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
    overwrite: true,
  });
  return { output: opts.output, durationSeconds: composition.durationInFrames / composition.fps };
}

export { checkAssets, collectAssetRefs, resolveAssetSrc, translateProject };
export type { RenderedProject, SceneAnimation, SceneNode, SceneStyle, TranslateOptions } from './types.js';