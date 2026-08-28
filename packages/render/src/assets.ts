import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Issue, ProjectFile } from '@uragan/shared';
import { resolveDef } from './style.js';

export interface AssetRef {
  /** 原始引用串（相对路径 / URL） */
  src: string;
  /** 定位：content 字段 / 页 $defs / 组件 $defs */
  where: string;
}

/** 枚举工程内全部资产引用：content 的 asset 字段 + 各页/组件 $defs 中 asset 定义 */
export function collectAssetRefs(file: ProjectFile): AssetRef[] {
  const refs: AssetRef[] = [];
  const push = (src: string, where: string) => refs.push({ src, where });

  for (const page of file.pages) {
    for (const [name, field] of Object.entries(page.content)) {
      const src = field.kind === 'asset' && typeof field.src === 'string' ? field.src : undefined;
      if (src) push(src, `pages.${page.pageId}.content.${name}`);
    }
    for (const [key, def] of Object.entries(page.$defs)) {
      if (def.type === 'asset') push(def.src, `pages.${page.pageId}.defs.${key}`);
    }
  }
  for (const [ci, comp] of (file.components ?? []).entries()) {
    for (const [key, def] of Object.entries(comp.$defs)) {
      if (def.type === 'asset') push(def.src, `components[${ci}].${comp.componentId}.defs.${key}`);
    }
  }
  return refs;
}

/** 相对路径参照物：工程文件所在目录 */
export function projectBaseDir(projectFilePath: string): string {
  return dirname(isAbsolute(projectFilePath) ? projectFilePath : resolve(projectFilePath));
}

/** 解析引用为渲染可用地址：URL 原样，相对路径 → 相对工程目录的绝对路径 */
export function resolveAssetSrc(src: string, projectDir: string): string {
  if (/^https?:\/\//i.test(src)) return src;
  return join(projectDir, src);
}

export interface CheckResult {
  ok: boolean;
  issues: Issue[];
}

/**
 * 资产引用体检（设计文档 §3.8/§5 assets check，MCP assets_check）：
 * 相对路径 → 文件存在性；URL → HEAD 可达性（3s 超时）。
 * 不触碰网络本地验证失败不硬判错：网络不可达归为 warning，本地缺失归为 error。
 */
export async function checkAssets(file: ProjectFile, projectDir: string, where = 'assets'): Promise<CheckResult> {
  const issues: Issue[] = [];
  for (const ref of collectAssetRefs(file)) {
    if (/^https?:\/\//i.test(ref.src)) {
      try {
        const res = await fetch(ref.src, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
        if (!res.ok) {
          issues.push({
            code: 'U-5002',
            severity: 'error',
            path: `${where}.${ref.where}`,
            message: `资产 URL 不可达（HTTP ${res.status}）：${ref.src}`,
          });
        }
      } catch {
        issues.push({
          code: 'U-5003',
          severity: 'warning',
          path: `${where}.${ref.where}`,
          message: `资产 URL 探测失败（可能离线，渲染时重试）：${ref.src}`,
        });
      }
      continue;
    }
    if (!existsSync(resolveAssetSrc(ref.src, projectDir))) {
      issues.push({
        code: 'U-5001',
        severity: 'error',
        path: `${where}.${ref.where}`,
        message: `本地素材不存在：${ref.src}（相对 ${projectDir} 解析）`,
        hint: '将素材放入工程文件旁的 assets/ 目录，或以相对路径引用（设计文档 §3.8）',
      });
    }
  }
  return { ok: issues.every((i) => i.severity !== 'error'), issues };
}

export { resolveDef };