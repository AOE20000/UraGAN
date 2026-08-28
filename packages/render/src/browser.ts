import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 离线浏览器（chrome-headless-shell）内置解析。
 * 优先级：显式 browserExecutable → 环境变量 URA_CHROME_BROWSER → 包内 vendor → 系统 Remotion 缓存。
 * vendor 目录随 @uragan/render 发布（npm files 含 vendor），拷贝即用、无网可渲染。
 */

const EXE = process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';

/** packages/render/vendor/（dist 同级，包内） */
const VENDOR_DIR = fileURLToPath(new URL('../vendor', import.meta.url));

/** 候选可执行文件路径（按优先级） */
export function candidateBrowserPaths(env: NodeJS.ProcessEnv = process.env): (string | undefined)[] {
  return [
    env.URA_CHROME_BROWSER,
    join(VENDOR_DIR, 'chrome-headless-shell-win64', EXE), // 内置主形态
    join(VENDOR_DIR, EXE), // 平铺形态
    join(VENDOR_DIR, 'win64', 'chrome-headless-shell-win64', EXE),
  ];
}

/** 解析当前可用的内置浏览器可执行文件路径；无则 undefined（回退在线下载） */
export function vendoredBrowserPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const c of candidateBrowserPaths(env)) {
    if (c && existsSync(c)) return c;
  }
  return undefined;
}

/** 渲染用浏览器选项：有内置→直接可用；无内置→undefined（Remotion 自行下载/用缓存） */
export function browserForRender(opts?: { browserExecutable?: string }): string | undefined {
  const explicit = opts?.browserExecutable;
  if (explicit && existsSync(explicit)) return explicit;
  return vendoredBrowserPath();
}