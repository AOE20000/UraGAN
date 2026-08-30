#!/usr/bin/env node
/**
 * 打包便携分发包（产物独立性）：
 * 把 monorepo 五包 + 全部第三方依赖扁平化到 build/uragan/，
 * 生成 bin/uragan(.cmd) 与 bin/uragan-mcp(.cmd) —— 任意目录、无需 pnpm/源码即可运行。
 *
 * 原理：node_modules 平铺（npm v2 风格）。每个包的真实安装内容来自仓库 node_modules
 * 的 .pnpm 目录（经过 realpath 解析），其传递依赖持续展开到顶层 node_modules。
 * 包内自带的 node_modules 不拷贝（避免符号链接无限展开）。
 *
 * 用法：
 *   node scripts/package-portable.mjs          # 全量（含 @remotion/* 渲染依赖）
 *   node scripts/package-portable.mjs --lite   # 精简：不含渲染依赖（渲染时提示缺失）
 */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'build', 'uragan');
const LITE = process.argv.includes('--lite');
const PKGS = ['shared', 'core', 'render', 'mcp', 'cli'];
const OWN = '@uragan';
const BIN_ONLY = process.argv.includes('--bin-only');

// 相对 bin 的 JS 入口（%%~dp0.. = 分发包根）
const relCli = [OWN, 'cli', 'dist', 'index.js'].join('/');
const relMcp = [OWN, 'mcp', 'dist', 'cli.js'].join('/');

/**
 * 依赖查找域：
 * - 根 node_modules + 各包 node_modules（pnpm isolated 下链接分散在包级）
 * - 每解析出一个真实包后，把它所在的 .pnpm/<pkg>@v/node_modules 层也纳入查找域，
 *   这样该包的传递依赖（同级链接）都能继续解析 —— 这是 pnpm 严格隔离的关键。
 * 每次解析真实路径（realpath），保证拷贝到的是真实文件（非链接）。
 */
const searchBases = new Set([join(ROOT, 'node_modules'), ...PKGS.map((p) => join(ROOT, 'packages', p, 'node_modules'))]);

/** 解析某包名的真实安装目录（含 package.json）；找不到返回 undefined */
function realDir(name) {
  const parts = name.split('/');
  const baseList = [...searchBases];
  for (const base of baseList) {
    const cand = join(base, ...parts);
    if (!existsSync(cand)) continue;
    try {
      const rp = realpathSync(cand);
      if (!existsSync(join(rp, 'package.json'))) continue;
      // pnpm 依赖层：.../node_modules/<scope>/<pkg> 的链接层在 .../node_modules 本身
      // （scoped 包链接形如 .../node_modules/@remotion/renderer，需再剥一层 scope 目录）
      let holder = dirname(rp);
      while (basename(holder).startsWith('@')) holder = dirname(holder);
      searchBases.add(holder);
      return rp;
    } catch {
      /* 权限/链接环：跳过 */
    }
  }
  return undefined;
}

/** 扁平拷贝包内容：递归展开目录，显式跳过嵌套的 node_modules/.bin（避免符号链接无限展开） */
async function copyFlat(srcDir, destDir) {
  if (existsSync(destDir)) return true; // 已拷贝过（首个版本为准）
  await mkdir(destDir, { recursive: true });
  const stack = [[srcDir, destDir]];
  while (stack.length > 0) {
    const [s, d] = stack.pop();
    let entries;
    try {
      entries = await readdir(s, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.bin') continue;
      const sPath = join(s, e.name);
      const dPath = join(d, e.name);
      if (e.isSymbolicLink()) {
        // 符号链接：按目标类型跟随（文件→拷贝；目录→继续展开）
        try {
          const st = (await import('node:fs')).statSync(sPath);
          if (st.isDirectory()) stack.push([sPath, dPath]);
          else await cp(sPath, dPath, { dereference: true, force: true });
        } catch {
          /* 悬空链接：跳过 */
        }
      } else if (e.isDirectory()) {
        stack.push([sPath, dPath]);
      } else {
        await cp(sPath, dPath, { force: true });
      }
    }
  }
  return true;
}

async function pkgFile(name) {
  const dir = realDir(name);
  if (!dir) return undefined;
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/* ---------------- 0) --bin-only：只重建入口，跳过构建与依赖拷贝 ---------------- */
if (BIN_ONLY) {
  const binDir = await writeBins();
  console.log(`✔ 已重建入口：${binDir}`);
  process.exit(0);
}

/* ---------------- 1) 先构建全部包（保证 dist 最新） ---------------- */
const built = spawnSync('pnpm build', { cwd: ROOT, stdio: 'inherit', shell: true });
if (built.error || built.status !== 0) {
  console.error('✗ pnpm build 失败，中止打包');
  process.exit(1);
}

/* ---------------- 2) 清空输出 ---------------- */
await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'node_modules', OWN), { recursive: true });

/* ---------------- 3) 五包：仅拷贝发布白名单（dist + package.json，render 另带 vendor） ---------------- */
const versions = new Map();
for (const p of PKGS) {
  const src = join(ROOT, 'packages', p);
  const meta = JSON.parse(await readFile(join(src, 'package.json'), 'utf8'));
  versions.set(meta.name, meta.version || '0.1.0');
  const dest = join(OUT, 'node_modules', OWN, p);
  await mkdir(join(dest), { recursive: true });
  for (const f of meta.files ?? []) {
    await cp(join(src, f), join(dest, f), { recursive: true, dereference: true });
  }
  if (meta.bin) await writeFile(join(dest, 'package.json'), JSON.stringify(meta, null, 2), 'utf8');
  else await cp(join(src, 'package.json'), join(dest, 'package.json'));
  if (p === 'render' && existsSync(join(src, 'vendor'))) {
    // 离线渲染浏览器（约 270MB）：随分发包携带，真正“随处可用、无需网络”
    await cp(join(src, 'vendor'), join(dest, 'vendor'), { recursive: true, dereference: true });
  }
}

/* ---------------- 4) 第三方依赖闭包平铺 ---------------- */
const queue = [];
for (const p of PKGS) {
  const meta = JSON.parse(await readFile(join(ROOT, 'packages', p, 'package.json'), 'utf8'));
  // optionalDependencies 也必须带上：原生二进制的平台绑定（如 @rspack/binding-win32-x64-msvc）走它申明
  for (const dep of Object.keys({ ...meta.dependencies, ...meta.peerDependencies, ...meta.optionalDependencies })) queue.push(dep);
}
const SKIP = new Set([OWN]); // 已由白名单元处理
const copied = new Set(); // 已平铺的包名（首个版本）
let count = 0;
while (queue.length > 0) {
  const name = queue.shift();
  if (!name || SKIP.has(name)) continue;
  if (LITE && /^@remotion\//.test(name)) {
    SKIP.add(name);
    continue;
  }
  const dir = realDir(name);
  if (!dir) continue; // optional / 平台相关（找不到 = 该环境不安装，跳过）
  if (await copyFlat(dir, join(OUT, 'node_modules', name))) {
    copied.add(name);
    count += 1;
    const meta = await pkgFile(name);
    if (meta) {
      const deps = { ...meta.dependencies, ...meta.peerDependencies, ...meta.optionalDependencies };
      for (const d of Object.keys(deps)) if (!copied.has(d)) queue.push(d);
    }
  }
}
console.log(`✓ 已平铺 ${count} 个第三方依赖${LITE ? '（精简模式，跳过 @remotion/*）' : ''}`);

/* ---------------- 5) workspace:* → 真实版本号（元数据完整性） ---------------- */
for (const p of PKGS) {
  const path = join(OUT, 'node_modules', OWN, p, 'package.json');
  const meta = JSON.parse(await readFile(path, 'utf8'));
  for (const key of ['dependencies', 'peerDependencies']) {
    if (meta[key]) {
      for (const [d, v] of Object.entries(meta[key])) {
        if (v === 'workspace:*' && versions.has(d)) meta[key][d] = versions.get(d);
      }
    }
  }
  await writeFile(path, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

/* ---------------- 6) 入口命令（Windows .cmd + sh） ---------------- */
/**
 * cmd 包装：%~dp0.. 定位分发包根，再拼 node_modules/@uragan/... 目标。
 * 额外处理两件「一看就像程序坏了」的事：
 * 1) 缺 node：给出可读提示（否则双击只看到黑窗一闪，无从排查）
 * 2) 双击启动：%CMDCMDLINE% 同时含 /c 与本脚本名 —— 此时失败要 pause，别让窗口直接消失
 * pauseOnError：仅交互入口（uragan.cmd）开启；MCP 由客户端拉起，绝不能阻塞
 */
function wrapCmd(name, rel, { pauseOnError }) {
  const lines = [
    '@echo off',
    'setlocal',
    `set "URA_PKG=%~dp0..\\node_modules\\@uragan"`,
    'set "URA_DCLICK=0"',
    'if defined CMDCMDLINE (',
    '  echo %CMDCMDLINE% | findstr /i /c:"/c" >nul',
    '  if not errorlevel 1 (',
    `    echo %CMDCMDLINE% | findstr /i /c:"${name}.cmd" >nul`,
    '    if not errorlevel 1 set "URA_DCLICK=1"',
    '  )',
    ')',
    'where node >nul 2>nul',
    'if errorlevel 1 (',
    '  echo [UraGAN] 未检测到 node。请先安装 Node.js 20 及以上版本并确保 node 在 PATH 中。',
    '  echo          下载： https://nodejs.org/',
  ];
  if (pauseOnError) lines.push('  if "%URA_DCLICK%"=="1" pause');
  lines.push(
    '  exit /b 1',
    ')',
    `node "%URA_PKG%\\${rel.split('/').join('\\')}" %*`,
    'set "URA_CODE=%errorlevel%"',
  );
  // 仅在「双击且没带参数」时暂停：脚本里 cmd /c uragan.cmd <子命令> 失败不该卡住等待按键
  if (pauseOnError) lines.push('if not "%URA_CODE%"=="0" if "%URA_DCLICK%"=="1" if "%~1"=="" pause');
  lines.push('exit /b %URA_CODE%');
  return lines.join('\r\n') + '\r\n';
}

function wrapSh(rel) {
  return `#!/usr/bin/env sh\nBASE="$(CDPATH= cd -- "$(dirname -- "$0")/../node_modules/@uragan" && pwd)"\nexec node "$BASE/${rel}" "$@"\n`;
}

/** 写 bin 入口（Windows .cmd + sh）；--bin-only 时只跑这一步，避免重拷 270MB 离线浏览器 */
async function writeBins() {
  const binDir = join(OUT, 'bin');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'uragan.cmd'), wrapCmd('uragan', relCli.replace(`${OWN}/`, ''), { pauseOnError: true }), 'utf8');
  await writeFile(join(binDir, 'uragan-mcp.cmd'), wrapCmd('uragan-mcp', relMcp.replace(`${OWN}/`, ''), { pauseOnError: false }), 'utf8');
  await writeFile(join(binDir, 'uragan'), wrapSh(relCli.replace(`${OWN}/`, '')), 'utf8');
  await writeFile(join(binDir, 'uragan-mcp'), wrapSh(relMcp.replace(`${OWN}/`, '')), 'utf8');
  return binDir;
}

const binDir = await writeBins();

/* ---------------- 7) 版本标记 ---------------- */
await writeFile(
  join(OUT, 'VERSION'),
  `${versions.get(OWN + '/cli')}${LITE ? '-lite' : ''}\n生成于 ${new Date().toISOString()}\n`,
  'utf8',
);

console.log(`\n✔ 便携分发包已生成：${OUT}`);
if (!LITE && !existsSync(join(OUT, 'node_modules', OWN, 'render', 'vendor'))) {
  console.log('⚠ 未包含离线渲染浏览器（packages/render/vendor 缺失），渲染将尝试联网下载');
}
console.log(`  入口：${join(binDir, 'uragan.cmd')} / ${join(binDir, 'uragan-mcp.cmd')}`);
console.log('  任意目录可运行：build\\uragan\\bin\\uragan.cmd --version');