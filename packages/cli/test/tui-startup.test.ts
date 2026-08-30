import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { describe, expect, it } from 'vitest';
import { Uragan, readProjectFile, writeProjectFile } from '@uragan/core';
import { TuiApp } from '../src/tui/app.js';
import { emptySnapshot, isUnopened } from '../src/tui/state.js';

/** 假终端：让 ink 认为 stdin 支持 raw mode（否则 useInput 直接抛错，无法渲染） */
function fakeStdin(): NodeJS.ReadStream {
  const s = new PassThrough() as unknown as NodeJS.ReadStream & { setRawMode: (m: boolean) => boolean };
  s.isTTY = true;
  s.setRawMode = () => true;
  // ink 会 ref/unref stdin（保持事件循环引用计数），PassThrough 不带这两个方法
  (s as unknown as { ref: () => unknown; unref: () => unknown }).ref = () => s;
  (s as unknown as { ref: () => unknown; unref: () => unknown }).unref = () => s;
  return s;
}

/** 渲染 TuiApp 若干毫秒，返回最后一帧文本（debug 模式：每帧完整输出，便于断言终态） */
async function renderLastFrame(node: React.ReactElement, ms = 400): Promise<string> {
  const { frames } = await renderCollect(node, ms);
  const last = [...frames].reverse().find((f) => f.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '').trim().length > 0) ?? '';
  return last.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '');
}

/** 渲染并收集全部帧（可中途向 stdin 注入按键）；返回去重后的纯文本 */
async function renderCollect(node: React.ReactElement, ms: number, keys: string[] = []) {
  const frames: string[] = [];
  const stdin = fakeStdin();
  const stdout = {
    write: (s: string) => {
      frames.push(s);
      return true;
    },
    columns: 120,
    rows: 40,
    isTTY: true,
    on: () => undefined,
    off: () => undefined,
  } as unknown as NodeJS.WriteStream;
  const app = render(node, { stdout, stdin, patchConsole: false, debug: true });
  await new Promise((r) => setTimeout(r, ms));
  for (const k of keys) {
    stdin.write(k); // 模拟按键（O 进文件管理器 / Enter 打开选中项）
    await new Promise((r) => setTimeout(r, 250));
  }
  app.unmount();
  const plain = frames.map((f) => f.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, ''));
  // 单帧文本（快捷键栏重复与否要在同一帧里数，跨帧累加会翻倍）
  const last = [...plain].reverse().find((f) => f.trim().length > 0) ?? '';
  return { frames, text: plain.join('\n'), last };
}

function realProjectInTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'uragan-tui-'));
  const file = Uragan.importFromText(
    JSON.stringify({
      schemaVersion: '1',
      project: { id: 'demo', name: '回归工程', canvas: { width: 1280, height: 720, fps: 30 } },
      $shared: { color_primary: { type: 'color', value: '#4F46E5' } },
      pages: [
        { pageId: 'p01', name: '开场页', kind: 'hero', content: { title: { cid: 'c0001', copy: true, kind: 'text', value: '你的品牌' } }, animations: [] },
      ],
    }),
  ).file;
  const target = join(dir, 'demo.uragan');
  writeProjectFile(target, file);
  return target;
}

describe('TUI 启动（回归：工程打不开时不得卡在「正在启动…」）', () => {
  it('工程不存在 → 落到空载态并提示 N 新建 / O 打开', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uragan-tui-empty-'));
    const frame = await renderLastFrame(React.createElement(TuiApp, { projectPath: join(dir, '不存在.uragan') }));
    expect(frame).not.toContain('正在启动');
    expect(frame).toContain('未打开工程');
    expect(frame).toContain('N 新建');
    rmSync(dir, { recursive: true, force: true });
  });

  it('工程存在 → 正常进入界面，显示工程名与页面', async () => {
    const target = realProjectInTmp();
    const frame = await renderLastFrame(React.createElement(TuiApp, { projectPath: target }));
    expect(frame).not.toContain('正在启动');
    expect(frame).toContain('UraGAN');
    expect(frame).toContain('回归工程');
    expect(frame).toContain('开场页');
  });
});

describe('TUI 持久文件工作流（.uragan → <源名>.uragan.work 工作目录）', () => {
  it('打开 .uragan：派生工作目录；改字段后标记未保存；Ctrl+S 导出回原文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uragan-tui-durable-'));
    const src = join(dir, 'win11-promo.uragan');
    writeFileSync(
      src,
      JSON.stringify({
        schemaVersion: '1',
        project: { id: 'win11', name: 'Win11 宣传', canvas: { width: 1920, height: 1080, fps: 30 } },
        pages: [
          { pageId: 'p01', name: '开场', kind: 'hero', $defs: {}, content: { title: { cid: 'c0001', copy: true, kind: 'text', value: 'Win11' } }, animations: [] },
        ],
      }),
      'utf8',
    );

    // ① 打开：原地派生 .uragan.work 工作目录，原文件保留
    const work = `${src}.work`;
    const first = await renderCollect(React.createElement(TuiApp, { projectPath: src }), 400);
    expect(existsSync(work) && statSync(work).isDirectory()).toBe(true);
    expect(statSync(src).isFile()).toBe(true);
    expect(first.text).toContain('Win11 宣传');
    expect(first.text).toContain('已同步'); // 刚导入，与原文件一致
    expect(first.text).not.toContain('未保存');

    // ② 改一个字段（Tab 进字段 → Enter 编辑 → 输入 → Enter 提交）→ 标记未保存
    const edited = await renderCollect(React.createElement(TuiApp, { projectPath: src }), 400, ['\t', '\r', 'X', '\r']);
    expect(edited.text).toContain('未保存');
    expect(readProjectFile(work).file.pages[0]!.content.title.value).toBe('Win11X'); // 实时进工作目录
    expect(readProjectFile(src).file.pages[0]!.content.title.value).toBe('Win11'); // 原文件还没动

    // ③ Ctrl+S → 导出回原文件
    const saved = await renderCollect(React.createElement(TuiApp, { projectPath: src }), 400, ['\x13']);
    expect(readProjectFile(src).file.pages[0]!.content.title.value).toBe('Win11X');
    expect(statSync(src).isFile()).toBe(true);
    expect(saved.text).toContain('已保存');

    rmSync(dir, { recursive: true, force: true });
  });

  it('文案框架进工程目录：skeleton.* 落在 .uragan.work 里，用户目录不出现', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uragan-tui-outdir-'));
    const src = join(dir, 'promo.uragan');
    writeFileSync(src, JSON.stringify(readProjectFile(realProjectInTmp()).file), 'utf8');

    // S = 导出文案框架 → 工程目录（工作目录）
    await renderCollect(React.createElement(TuiApp, { projectPath: src }), 400, ['s']);
    expect(existsSync(join(`${src}.work`, 'skeleton.json'))).toBe(true);
    expect(existsSync(join(`${src}.work`, 'skeleton.md'))).toBe(true);
    expect(existsSync(join(dir, 'skeleton.json'))).toBe(false);
    expect(existsSync(join(dir, 'skeleton.md'))).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('TUI 交互（回归：文件管理器回车打开 legacy 单文件不得崩溃）', () => {
  it('O 进入文件管理器 → Enter 打开 .uragan 单文件：不抛 EEXIST，界面仍可用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uragan-tui-legacy-'));
    const legacy = join(dir, 'win11-promo.uragan');
    writeFileSync(
      legacy,
      JSON.stringify({
        schemaVersion: '1',
        project: { id: 'win11', name: 'Win11 宣传', canvas: { width: 1920, height: 1080, fps: 30 } },
        pages: [
          { pageId: 'p01', name: '开场', kind: 'hero', $defs: {}, content: { title: { cid: 'c0001', copy: true, kind: 'text', value: 'Win11' } }, animations: [] },
        ],
      }),
      'utf8',
    );
    // 旧行为：目标工程目录名与该文件同名 → writeProjectDir → mkdir EEXIST → 异常冒出 useInput → 整个进程崩
    const { text } = await renderCollect(React.createElement(TuiApp, { projectPath: legacy }), 350, ['o', '\r']);
    expect(text).not.toContain('EEXIST');
    expect(text).not.toContain('ERROR');
    expect(text).toContain('Win11 宣传'); // 打开成功：界面仍显示该工程
    rmSync(dir, { recursive: true, force: true });
  });

  it('页面视图里「导入单页文件」只出现一次（不再两个一样的 U）', async () => {
    const target = realProjectInTmp();
    const { last } = await renderCollect(React.createElement(TuiApp, { projectPath: target }), 400);
    expect(last.split('导入单页文件').length - 1).toBe(1); // 同一帧里只有一个 U
    expect(last).toContain('导出单页文件'); // G 与 U 成对出现在页面视图上下文键位
    rmSync(dirname(target), { recursive: true, force: true });
  });
});

describe('空载态快照（emptySnapshot / isUnopened）', () => {
  it('emptySnapshot 无页面、工程名提示未打开、toast 可携带', () => {
    const s = emptySnapshot('x.uragan');
    expect(s.file.pages).toEqual([]);
    expect(s.file.project.name).toBe('（未打开工程）');
    expect(isUnopened(s)).toBe(true);
    expect(isUnopened({ ...s, toast: 'hi' })).toBe(true);
    expect(emptySnapshot('x.uragan', '未找到').toast).toBe('未找到');
  });

  it('真实工程不被判为空载态（id 不是 none）', () => {
    const f = Uragan.importFromText(
      JSON.stringify({
        schemaVersion: '1',
        project: { id: 'demo', name: '样例', canvas: { width: 1280, height: 720, fps: 30 } },
        pages: [],
      }),
    ).file;
    expect(f.project.id).not.toBe('none');
    expect(isUnopened({ ...emptySnapshot('y.uragan'), file: f })).toBe(false);
  });
});
