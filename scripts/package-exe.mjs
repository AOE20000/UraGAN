#!/usr/bin/env node
/**
 * 单文件可执行版（uragan.exe）：Node SEA（Single Executable Application）。
 *
 * 原理：webpack 把 CLI（commander + core + shared + ink + react + mcp）打成单个 CJS 文件
 * （webpack 的 topLevelAwait 实验特性把 ink/yoga-layout 的顶层 await 转成异步模块，CJS 可执行；
 *  esbuild 不支持顶层 await → CJS，Node SEA 在 Windows 上又无法加载 ESM 主入口，故选 webpack）。
 * 再用 Node 官方 --experimental-sea-config 生成运行快照 blob，postject 注入 node.exe 副本，
 * 得到「一个真正独立的 exe」——目标机器无需安装 Node，双击即进 TUI。
 *
 * 覆盖范围（精简语义，与 pack:lite 一致）：
 * - 可用：全部 CLI 命令（init/import/export/validate/pages/page/copy/shared/component/...）、
 *         TUI（无参数双击 / tui 子命令）、serve-mcp（MCP Server，命令面 = 工具面）
 * - 不含：渲染引擎（Remotion）与内置离线浏览器 —— render / assets check 会给出可读提示
 *   （Remotion 依赖原生绑定 @rspack/binding-win32-*，无法随 SEA 单文件携带）
 *
 * 用法：
 *   node scripts/package-exe.mjs
 * 产物：
 *   build/uragan/uragan.exe   （拷贝到任意位置即可运行）
 */
import webpack from 'webpack';
import postject from 'postject';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, 'build', 'uragan');
const EXE_PATH = join(OUT_DIR, 'uragan.exe');
const WORK = join(ROOT, 'build', 'exe');
const BUNDLE = join(WORK, 'bundle.cjs');
const SEA_CONFIG = join(WORK, 'sea-config.json');
const SEA_BLOB = join(WORK, 'sea-prep.blob');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/** 版本号取 cli 包 package.json */
const cliMeta = JSON.parse(await readFile(join(ROOT, 'packages', 'cli', 'package.json'), 'utf8'));
const VERSION = cliMeta.version || '0.1.0';

/* ---------------- 1) 构建全部包（保证 dist 最新） ---------------- */
const built = spawnSync('pnpm build', { cwd: ROOT, stdio: 'inherit', shell: true });
if (built.error || built.status !== 0) {
  console.error('✗ pnpm build 失败，中止打包');
  process.exit(1);
}

/* ---------------- 2) webpack 单文件打包（CJS；topLevelAwait → 异步模块） ----------------
 * external：
 * - @uragan/render：其顶层静态 import @remotion/*（含原生绑定），既不进单文件，也不随包走；
 *   cli 里 render/assets 命令已做 try/catch 优雅提示。
 * - @remotion/*：兜底（render 已 external，不需要；防误引）。
 * - react-devtools-core：ink 的可选 devtools 依赖（未安装），仅在 DEV=true 时动态加载，正常路径永不执行。
 */
console.log('· webpack 打包 CLI → 单个 CJS 文件 …');
await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
const stats = await new Promise((resolve, reject) => {
  webpack(
    {
      mode: 'production',
      target: 'node',
      entry: join(ROOT, 'packages', 'cli', 'dist', 'index.js'),
      output: {
        path: WORK,
        filename: 'bundle.cjs',
        library: { type: 'commonjs2' },
        clean: false,
      },
      resolve: { extensions: ['.js', '.mjs', '.json'] },
      // eager：动态 import() 不拆 chunk，全部内联进单文件（SEA 只能加载一个文件）
      module: { parser: { javascript: { dynamicImportMode: 'eager' } } },
      // 关压缩 + 关模块拼接：webpack 5 的 topLevelAwait 异步模块与 terser 压缩/scope
      // hoisting 存在已知冲突（压缩后 "X is not a constructor"；拼接会把 stack-utils 的
      // 类体错误替换成命名空间引用）。bundle 体积相对 node.exe（~86MB）可忽略。
      optimization: { minimize: false, concatenateModules: false },
      externals: [/^@remotion\//, '@uragan/render', 'react-devtools-core'],
      experiments: { topLevelAwait: true },
      stats: 'errors-warnings',
    },
    (err, s) => (err ? reject(err) : resolve(s)),
  );
});
if (stats.hasErrors()) {
  console.error(stats.toString({ colors: true, errors: true }));
  console.error('✗ webpack 打包失败，中止');
  process.exit(1);
}
console.log(`  ✓ ${BUNDLE}（${(await statKb(BUNDLE)).toFixed(0)} KB）`);

/* ---------------- 3) SEA 配置 + 运行快照 blob ---------------- */
await writeFile(
  SEA_CONFIG,
  JSON.stringify(
    {
      main: BUNDLE,
      output: SEA_BLOB,
      disableExperimentalSEAWarning: true,
      // CJS 主入口可用 V8 code cache 加速启动；异常时改为 false 再试（仅影响启动耗时）
      useCodeCache: true,
    },
    null,
    2,
  ),
  'utf8',
);
const sea = spawnSync(process.execPath, ['--experimental-sea-config', SEA_CONFIG], { cwd: ROOT, stdio: 'inherit' });
if (sea.error || sea.status !== 0) {
  console.error('✗ 生成 SEA blob 失败（本机 Node 需 ≥ 20.12 支持 --experimental-sea-config）');
  process.exit(1);
}
console.log(`  ✓ ${SEA_BLOB}`);

/* ---------------- 4) node.exe 副本 + postject 注入 blob ---------------- */
await mkdir(OUT_DIR, { recursive: true });
await cp(process.execPath, EXE_PATH);
console.log('· postject 注入 SEA blob（追加到 exe 尾部）…');
await postject.inject(EXE_PATH, 'NODE_SEA_BLOB', await readFile(SEA_BLOB), { sentinelFuse: FUSE });

/* ---------------- 5) 版本标记 ---------------- */
await writeFile(join(OUT_DIR, 'VERSION'), `${VERSION}-exe\n生成于 ${new Date().toISOString()}\n`, 'utf8');

console.log(`\n✔ 单文件版已生成：${EXE_PATH}（${(await statKb(EXE_PATH)).toFixed(0)} KB ≈ ${((await statKb(EXE_PATH)) / 1024).toFixed(0)} MB）`);
console.log('  拷贝这一个文件到任意位置即可运行：');
console.log('    uragan.exe                       # 交互终端双击/运行 → 直接进 TUI');
console.log('    uragan.exe serve-mcp             # MCP Server（stdio，命令面 = 工具面）');
console.log('    uragan.exe tui -p demo.uragan    # 指定工程进 TUI');
console.log('  注意：render / assets check 需要 Remotion，单文件版给出提示；完整渲染请用 pnpm run pack。');

/* ---------------- 工具 ---------------- */
async function statKb(p) {
  if (!existsSync(p)) return 0;
  const { statSync } = await import('node:fs');
  return statSync(p).size / 1024;
}
