import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { describe, expect, it } from 'vitest';
import { Uragan } from '@uragan/core';
import { TuiApp } from '../src/tui/app.js';

/** 假终端（与 tui-startup.test.ts 同款机制） */
function fakeStdin(): NodeJS.ReadStream {
  const s = new PassThrough() as unknown as NodeJS.ReadStream & { setRawMode: (m: boolean) => boolean };
  s.isTTY = true;
  s.setRawMode = () => true;
  (s as unknown as { ref: () => unknown; unref: () => unknown }).ref = () => s;
  (s as unknown as { ref: () => unknown; unref: () => unknown }).unref = () => s;
  return s;
}

/**
 * 渲染 TuiApp 并注入按键。ink 重绘分多次 write（增量片段），单帧不完整；
 * 因此合并所有帧 —— 任一帧渲染过的状态都会出现，用于断言「该状态被渲染过」。
 */
async function renderAll(file: string, keys: string[], ms = 350): Promise<string> {
  const frames: string[] = [];
  const stdin = fakeStdin();
  const stdout = {
    write: (s: string) => {
      frames.push(s);
      return true;
    },
    columns: 100,
    rows: 24,
    isTTY: true,
    on: () => undefined,
    off: () => undefined,
  } as unknown as NodeJS.WriteStream;
  const app = render(React.createElement(TuiApp, { projectPath: file }), { stdout, stdin, patchConsole: false, debug: true });
  await new Promise((r) => setTimeout(r, ms));
  for (const k of keys) {
    stdin.write(k);
    await new Promise((r) => setTimeout(r, 180));
  }
  app.unmount();
  return frames.map((f) => f.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')).join('\n');
}

function makeProject(name: string, pages: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'uragan-win-'));
  const file = Uragan.importFromText(
    JSON.stringify({ schemaVersion: '1', project: { id: 'demo', name, canvas: { width: 1280, height: 720, fps: 30 } }, pages }),
  ).file;
  const target = join(dir, `${name}.uragan`);
  writeFileSync(target, JSON.stringify(file), 'utf8');
  return target;
}

describe('TUI 列表超出隐藏 + 上下提示（页面 / 详情栏）', () => {
  it('页面超过可视行数：底部出现「下方还有 N 项」，选中第 1 页时无「上方还有」；每行都被渲染过', async () => {
    const pages = [];
    for (let i = 1; i <= 10; i++) {
      pages.push({ pageId: `p${String(i).padStart(2, '0')}`, name: `页面${i}`, kind: i % 2 === 0 ? 'grid' : 'hero', $defs: {}, content: { title: { cid: `c${i}`, copy: true, kind: 'text', value: `标题${i}` } }, animations: [] });
    }
    const file = makeProject('十页工程', pages);
    const merged = await renderAll(file, []);
    expect(merged).toContain('↓ 下方还有');
    expect(merged).not.toContain('↑ 上方还有');
    // 窗口内的页面行都被渲染过（真实终端完整显示；测试侧 ink 分片写入需合并断言）
    for (const i of [1, 2, 3, 4]) expect(merged).toContain(` 0${i} 页面${i}`);
    // 超出可视行的部分被隐藏（不渲染、不给提示外的文本）
    expect(merged).not.toContain(' 06 页面6');
    expect(merged).not.toContain(' 09 页面9');
    rmSync(dirname(file), { recursive: true, force: true });
  });

  it('下移到末尾：窗口跟随，「上方还有」出现、选中第 9 页可见', async () => {
    const pages = [];
    for (let i = 1; i <= 10; i++) {
      pages.push({ pageId: `p${String(i).padStart(2, '0')}`, name: `页面${i}`, kind: 'hero', $defs: {}, content: {}, animations: [] });
    }
    const file = makeProject('十页工程', pages);
    const keys = Array(8).fill('\u001b[B'); // ↓ ×8 → 选中第 9 页
    const merged = await renderAll(file, keys);
    expect(merged).toContain('↑ 上方还有');
    expect(/▶\s*09\s*页面9/.test(merged)).toBe(true); // 窗口跟随，选中第 9 页被渲染过
    rmSync(dirname(file), { recursive: true, force: true });
  });

  it('详情栏字段超过可视行数：底部提示；字段下移后选中项可见、上下提示并存', async () => {
    const content: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) content[`field_${i}`] = { cid: `c${String(i).padStart(4, '0')}`, copy: true, kind: 'text', value: `字段值${i}` };
    const file = makeProject('多字段工程', [{ pageId: 'p1', name: '开场页', kind: 'hero', $defs: {}, content, animations: [] }]);
    // 初始：Tab 进入字段态，选中 field_0，底部提示
    const first = await renderAll(file, ['\t']);
    expect(first).toContain('↓ 下方还有');
    expect(/❯\s*field_0/.test(first)).toBe(true);
    // 下移 12 次 → 选中 field_12，窗口居中跟随，上下提示并存
    const moved = await renderAll(file, ['\t', ...Array(12).fill('\u001b[B')]);
    expect(/❯\s*field_12/.test(moved)).toBe(true);
    expect(moved).toContain('↑ 上方还有');
    expect(moved).toContain('↓ 下方还有');
    rmSync(dirname(file), { recursive: true, force: true });
  });
});
