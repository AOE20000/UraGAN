import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout, type Key } from 'ink';
import type { Issue, Page, ProjectFile } from '@uragan/shared';
import {
  Uragan,
  blankFile,
  exportSkeleton,
  exportSkeletonText,
  isProjectDir,
  outputDirFor,
  parseSkeletonText,
  readProjectFile,
  validateProjectFile,
  withProjectExt,
  writeProjectFile,
} from '@uragan/core';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import {
  clip,
  coerceValue,
  defSummary,
  displayValue,
  editInput,
  emptySnapshot,
  fieldKind,
  fieldsOfPage,
  isOpenableProject,
  isUnopened,
  lastFmDir,
  moveDown,
  moveUp,
  pageRows,
  pageStats,
  pushLog,
  rememberFmDir,
  selectedField,
  selectedPage,
  snapshot,
  sortFm,
  VIEW_LABEL,
  viewWindow,
  type FieldView,
  type FmEntry,
  type LogLevel,
  type TuiSnapshot,
  type View,
} from './state.js';

/* ---------------- 主题：深色应用面板（黑/白终端背景都清晰） ---------------- */
const P = {
  frame: '#475569', // 外框线
  bg: '#0f172a', // 根背景（深蓝黑，比面板更深，形成层次）
  panel: '#1e293b', // 面板底色
  active: '#3730a3', // 焦点面板/页签（深靛蓝）
  hilite: '#4f46e5', // 选中行（亮一档，与焦点面板区分）
  brand: '#6366f1', // 品牌块底色
  line: '#334155', // 分隔线
  keyCap: '#0b1220', // 键帽底色
  text: '#e2e8f0',
  mute: '#94a3b8',
  green: '#34d399',
  yellow: '#fde047',
  amber: '#fbbf24',
  red: '#f87171',
  cyan: '#67e8f9',
  pink: '#f472b6',
};
const KIND_TAG: Record<string, string> = { hero: '开头', section: '分节', grid: '卡片', chart: '数据' };
const KIND_COLOR: Record<string, string> = { hero: '#67e8f9', section: '#f472b6', grid: '#34d399', chart: '#fbbf24' };

interface Progress {
  progress: number;
  message: string;
}

interface TuiAppProps {
  projectPath: string;
}

const VIEW_KEYS: Record<string, View> = { '1': 'pages', '2': 'shared', '3': 'components', '4': 'assets', '5': 'info', '6': 'log' };

/** 全局快捷键清单（UI 由此渲染，保证功能名完整、可单测） */
export const SHORTCUTS: { k: string; t: string; color?: string }[] = [
  { k: 'S', t: '导出文案框架' },
  { k: 'I', t: '导入文案' },
  { k: 'R', t: '渲染视频' },
  { k: 'V', t: '校验', color: '#34d399' },
  { k: 'T', t: '资产体检', color: '#34d399' },
  { k: 'O', t: '打开工程', color: '#fbbf24' },
  { k: 'N', t: '新建工程', color: '#fbbf24' },
  { k: 'X', t: '关闭工程', color: '#fbbf24' },
  { k: 'Ctrl+S', t: '保存回原文件', color: '#34d399' },
  { k: 'Q', t: '退出', color: '#f87171' },
];

let renderSeq = 0;

export function TuiApp({ projectPath }: TuiAppProps): React.ReactElement {
  const { exit } = useApp();
  /** 终端尺寸：整屏绘制（布局固定为一行一屏，长内容在主体区内部裁剪，不被顶出屏幕） */
  const { stdout } = useStdout();
  const rows = stdout.rows ?? 24;
  const cols = stdout.columns ?? 80;
  const [state, setState] = useState<TuiSnapshot>();
  /** 输入态：文本 + 光标位置（T1：IME 整词上屏、方向键移动光标共用同一状态） */
  const [ed, setEd] = useState<{ text: string; cursor: number }>({ text: '', cursor: 0 });
  const draft = ed.text;
  const cursor = ed.cursor;
  const [res, setRes] = useState<Progress>({ progress: 0, message: '' });
  /** 渲染进行中（用于防重入；完成/失败后复位，可再次渲染） */
  const [rendering, setRendering] = useState(false);
  /** 会话子状态：new（新建工程）/ pageImport（导入单页）+ fm（文件管理器）；null=正常浏览 */
  const [session, setSession] = useState<'new' | 'pageImport' | 'fm' | null>(null);
  /** 文件管理器（O 进入；目录/全部文件展示，记忆上次位置） */
  const [fm, setFm] = useState<{ cwd: string; entries: FmEntry[]; sel: number } | null>(null);
  /** 文件管理器「路径直达」输入态：非 null = 正在输入目标路径（/ 触发，Enter 跳转，Esc 取消） */
  const [fmPath, setFmPath] = useState<string | null>(null);
  /** 校验/资产体检结果缓存（信息/资产视图展示） */
  const [report, setReport] = useState<{ issues: Issue[]; ok: boolean }>({ issues: [], ok: true });
  const [assetIssues, setAssetIssues] = useState<Issue[]>([]);
  const [assetOk, setAssetOk] = useState(true);
  /** 退出确认：有未导出回持久文件的改动时，第一次 Q 只提示，再按一次才真的退出 */
  const [quitArmed, setQuitArmed] = useState(false);

  useEffect(() => {
    if (state) return;
    openProject(projectPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, projectPath]);

  /**
   * 打开工程：
   * - 目录工程（<名>.uragan/ 或 <名>.uragan.work/）→ 聚合读取
   * - .uragan 单文件（整体工程 / 独立页面）→ 导入到 <源名>.uragan.work/ 工作目录，原文件留作持久存储
   * 任何 IO 异常都只转成提示：TUI 不能因为打不开一个文件就把整个进程崩掉。
   */
  const openProject = (path: string): void => {
    try {
      applyOpen(path);
    } catch (e) {
      const why = `打开失败：${(e as Error).message}`;
      setState((s) => (s ? withLog({ ...s, toast: why }, why, 'err') : emptySnapshot(path, `${why} — 按 N 新建 / O 打开`)));
    }
  };

  const applyOpen = (path: string): void => {
    const p = isProjectDir(path) ? path : withProjectExt(path);
    const r = Uragan.openProject(p);
    if (r.report.errors.some((e) => e.severity === 'error') && r.file.pages.length === 0) {
      const why = r.report.errors.map((e) => `[${e.code}] ${e.message}`).join('；');
      setState((s) => (s ? withLog({ ...s, toast: why }, why, 'err') : emptySnapshot(p, `${why} — 按 N 新建 / O 打开`)));
      return;
    }
    setReport({ issues: r.report.errors, ok: r.report.ok });
    setQuitArmed(false);
    const toast = r.durablePath
      ? r.converted
        ? `已导入 → 工作目录 ${basename(r.projectPath)}（原 ${basename(r.durablePath)} 保留为持久文件）`
        : `已打开工作目录 ${basename(r.projectPath)}（持久文件 ${basename(r.durablePath)}）`
      : r.converted
        ? `已导入展开 → ${basename(r.projectPath)}（按页拆分落盘）`
        : `已打开 ${basename(r.projectPath)}`;
    const base = snapshot(r.projectPath, r.file, r.durablePath);
    setState({ ...withLog(base, toast, 'ok'), toast });
  };

  /** 工程所在目录（目录工程 = 目录本身）——相对路径资产/副产品以此为基准 */
  /**
   * 工程目录：工程本体（project.json + 每页独立文件 + components/）与文案框架 skeleton.* 都在这里。
   * 有持久文件时就是派生的 <源名>.uragan.work\，否则就是目录工程本身。
   */
  const workDir = (): string => state?.projectPath ?? '';

  /**
   * 产出 / 资产目录：用户的 assets/、render.mp4、导出的单页文件都落在这里。
   * 有持久文件 → 原 .uragan 所在目录（用户看得见的地方）；没有 → 工程目录本身。
   */
  const outputDir = (): string => (state ? outputDirFor(state.projectPath, state.durablePath) : '');

  /** 追加操作日志（日志视图展示）：返回带 log 的新快照 */
  const withLog = (s: TuiSnapshot, msg: string, level: LogLevel = 'info'): TuiSnapshot => ({ ...s, log: pushLog(s.log, msg, level) });

  /** 编辑落盘：实时写入工程目录（工作目录）；有持久文件时标记为「未保存」 */
  const save = (file: ProjectFile, toast: string): void => {
    const p = state?.projectPath;
    if (!p) return;
    try {
      writeProjectFile(p, file);
    } catch (e) {
      toast = `保存失败：${(e as Error).message}`;
    }
    setState((s) => (s ? { ...s, file, toast, dirty: s.durablePath ? true : s.dirty } : s));
  };

  /** 保存 = 把工作目录的最新内容导出回持久文件（原 .uragan） */
  const saveDurable = (): void => {
    const s = state;
    if (!s) return;
    if (!s.durablePath) {
      setState(withLog({ ...s, toast: '当前工程本身就是目录形态，编辑已实时落盘，无需再导出' }, '当前工程为目录形态，编辑实时落盘，无需导出'));
      return;
    }
    try {
      const { file } = readProjectFile(s.projectPath); // 以工作目录为准（含所有实时改动）
      writeProjectFile(s.durablePath, file);
      setQuitArmed(false);
      const msg = `已保存 → ${basename(s.durablePath)}`;
      setState(withLog({ ...s, file, dirty: false, toast: msg }, msg, 'ok'));
    } catch (e) {
      const msg = `保存失败：${(e as Error).message}`;
      setState(withLog({ ...s, toast: msg }, msg, 'err'));
    }
  };

  /* —— 文件管理器（O 进入；目录/全部文件展示，可开工程打标，记忆上次位置）—— */
  const listFm = (dir: string): FmEntry[] | undefined => {
    try {
      const raw = readdirSync(dir, { withFileTypes: true });
      // 目录 + 全部文件都展示（文件管理视角）；可开工程（.uragan/.json/.jsonc/工程目录）打标
      return sortFm(
        raw.map((d) => ({ name: d.name, isDir: d.isDirectory(), isProject: isOpenableProject(d.name, d.isDirectory()) })),
      );
    } catch {
      return undefined;
    }
  };

  const enterFmDir = (dir: string, toast = ''): void => {
    const abs = resolve(dir); // 归一化绝对路径（路径提示需要；也避免相对路径依赖 cwd）
    const entries = listFm(abs);
    if (!entries) {
      setState((cur) => (cur ? { ...cur, toast: `无法读取目录：${abs}` } : cur));
      return;
    }
    rememberFmDir(abs);
    setFm({ cwd: abs, entries, sel: 0 });
    setSession('fm');
    if (toast) setState((cur) => (cur ? { ...cur, toast } : cur));
  };

  /**
   * 进入文件管理器：起始目录优先级：
   * 1) 工程已打开 → 工程产出目录（资产/导出物所在，最常操作）
   * 2) 本次进程已记忆的上次位置
   * 3) 当前目录；若 cwd 是程序自身目录（双击 exe / 在 exe 目录里运行），退回用户主目录
   */
  const enterFm = (): void => {
    if (state && !isUnopened(state)) {
      enterFmDir(outputDirFor(state.projectPath, state.durablePath));
      return;
    }
    const remembered = lastFmDir('');
    if (remembered) {
      enterFmDir(remembered);
      return;
    }
    const cwd = process.cwd();
    const selfDir = dirname(process.execPath);
    const base = cwd === selfDir || cwd.startsWith(selfDir + sep) ? homedir() : cwd;
    enterFmDir(base);
  };

  /** 上级目录（已到根则提示，不再退出） */
  const goUpFm = (): void => {
    if (!fm) return;
    const parent = dirname(fm.cwd);
    if (parent === fm.cwd) {
      setState((cur) => (cur ? { ...cur, toast: '已在根目录' } : cur));
      return;
    }
    enterFmDir(parent);
  };

  /** 路径直达：绝对路径跳转（支持盘符根如 D:\）；不存在/非目录给出提示 */
  const jumpFmPath = (raw: string): void => {
    const p = raw.trim();
    setFmPath(null);
    if (!p) {
      setState((cur) => (cur ? { ...cur, toast: '未输入路径' } : cur));
      return;
    }
    const abs = resolve(p);
    if (!existsSync(abs)) {
      setState((cur) => (cur ? { ...cur, toast: `路径不存在：${p}` } : cur));
      return;
    }
    if (!statSync(abs).isDirectory()) {
      setState((cur) => (cur ? { ...cur, toast: `不是目录：${p}` } : cur));
      return;
    }
    enterFmDir(abs, `已跳转：${abs}`);
  };

  /**
   * 导入单页文件（对应 G 导出单页）：按 pageId 替换同名页，否则追加。
   * 工程目录本身也支持直接把页文件放进去自动吸收，这个入口用于从别处挑文件导入。
   */
  const importPageFile = (path: string): void => {
    const s = state;
    if (!s) return;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (e) {
      const msg = `读取失败：${(e as Error).message}`;
      setState(withLog({ ...s, toast: msg }, msg, 'err'));
      return;
    }
    let pageInput: unknown;
    try {
      pageInput = JSON.parse(text);
    } catch {
      const msg = `解析失败：${path} 不是合法 JSON 单页文件`;
      setState(withLog({ ...s, toast: msg }, msg, 'err'));
      return;
    }
    const r = Uragan.overwritePage(s.file, pageInput);
    if (!r.report.ok) {
      const msg = `导入单页失败：${r.report.errors.map((e) => `[${e.code}] ${e.message}`).join('；')}`;
      setState(withLog({ ...s, toast: msg }, msg, 'err'));
      return;
    }
    const pageId = (pageInput as { pageId?: string } | undefined)?.pageId ?? '?';
    save(r.file, `已导入单页 ${pageId}（来自 ${basename(path)}）`);
  };

  const createProject = (path: string): void => {
    const p = withProjectExt(path);
    if (existsSync(p)) {
      const msg = `已存在：${p}`;
      setState((s) => (s ? withLog({ ...s, toast: msg }, msg, 'warn') : s));
      return;
    }
    const file = blankFile();
    file.project.name = basename(p).replace(/\.[^.]+$/, '') || '未命名';
    try {
      writeProjectFile(p, file);
      const msg = `已新建 ${basename(p)}`;
      const base = snapshot(p, file);
      setState({ ...withLog(base, msg, 'ok'), toast: msg });
    } catch (e) {
      const msg = `新建失败：${(e as Error).message}`;
      setState((s) => (s ? withLog({ ...s, toast: msg }, msg, 'err') : s));
    }
  };

  /** 导出当前单页为独立文件（含头部 $defs）——落在产出目录，方便拿去给别人 */
  const exportPage = (): void => {
    const s = state;
    if (!s || s.file.pages.length === 0) return;
    const page = selectedPage(s);
    if (!page) return;
    const out = join(outputDir(), `page-${page.pageId}.json`);
    try {
      writeFileSync(out, JSON.stringify(page, null, 2) + '\n', 'utf8');
      const msg = `已导出单页 ${page.pageId} → ${out}`;
      setState(withLog({ ...s, toast: msg }, msg, 'ok'));
    } catch (e) {
      const msg = `导出失败：${(e as Error).message}`;
      setState(withLog({ ...s, toast: msg }, msg, 'err'));
    }
  };

  /** 校验工程 */
  const runValidate = (file?: ProjectFile): void => {
    const f = file ?? state?.file;
    if (!f) return;
    const rep = validateProjectFile(f);
    setReport({ issues: rep.errors, ok: rep.ok });
    const nErr = rep.errors.filter((e) => e.severity === 'error').length;
    const msg = rep.ok ? '✓ 校验通过' : `校验发现 ${nErr} 个错误`;
    setState((s) => (s ? withLog({ ...s, toast: msg }, msg, rep.ok ? 'ok' : 'err') : s));
  };

  /** 资产体检（render 层） */
  const runAssetsCheck = (): void => {
    const s = state;
    if (!s) return;
    setState(withLog({ ...s, toast: '资产体检中…' }, '资产体检开始'));
    void (async () => {
      try {
        const { checkAssets, collectAssetRefs } = await import('@uragan/render');
        collectAssetRefs; // 仅用于展示引用
        const r = await checkAssets(s.file, outputDir(), 'assets');
        setAssetIssues(r.issues);
        setAssetOk(r.ok);
        const msg = r.issues.length === 0 ? '✓ 资产全部有效' : `发现 ${r.issues.filter((i) => i.severity === 'error').length} 个失效`;
        setState((cur) => (cur ? withLog({ ...cur, toast: msg }, msg, r.ok ? 'ok' : 'warn') : cur));
      } catch (e) {
        const msg = `资产体检失败：${(e as Error).message}`;
        setState((cur) => (cur ? withLog({ ...cur, toast: msg }, msg, 'err') : cur));
      }
    })();
  };

  /** 内联组件到当前页 */
  const inlineComponent = (componentId: string): void => {
    const s = state;
    if (!s || s.file.pages.length === 0) {
      setState(s ? { ...s, toast: '请先打开工程并选择目标页' } : s);
      return;
    }
    const pageId = s.file.pages[s.pageIndex]!.pageId;
    const { file, report } = Uragan.inlineComponent(s.file, pageId, componentId);
    if (!report.ok) {
      const msg = `内联失败：${report.errors.map((e) => `[${e.code}] ${e.message}`).join('；')}`;
      setState(withLog({ ...s, toast: msg }, msg, 'err'));
      return;
    }
    save(file, `已内联 ${componentId} → ${pageId}`);
  };

  /** 关闭当前工程（回到空载态） */
  const closeProject = (): void => {
    const s = state;
    if (!s) return;
    setState({ ...withLog(emptySnapshot(s.projectPath), '已关闭工程'), toast: '已关闭工程（O 重新打开）' });
    setReport({ issues: [], ok: true });
    setAssetIssues([]);
  };

  /** 按键处理（T5：文件管理器 / 会话输入 / 全局动作 / 字段编辑 / 视图切换） */
  const handleInput = (input: string, key: Key): void => {
    const s = state;
    if (!s) return;

    /* —— 文件管理器（O 打开工程；↑↓ 选择、Enter 进入/打开、Backspace 上级、/ 路径直达、H 主目录、Esc 关闭）—— */
    if (session === 'fm' && fm) {
      // 路径直达输入态：全部按键进输入框（IME 整词同字段编辑），Enter 跳转、Esc 取消
      if (fmPath !== null) {
        if (key.escape) { setFmPath(null); return; }
        if (key.return) { jumpFmPath(fmPath); return; }
        const r = editInput(fmPath, fmPath.length, input, { leftArrow: key.leftArrow, rightArrow: key.rightArrow, backspace: key.backspace, ctrl: key.ctrl, meta: key.meta });
        setFmPath(r.text);
        return;
      }
      if (key.escape) { setSession(null); setState({ ...s, toast: '已关闭文件管理器' }); return; }
      if (key.upArrow || input === 'k') { setFm({ ...fm, sel: Math.max(0, fm.sel - 1) }); return; }
      if (key.downArrow || input === 'j') { setFm({ ...fm, sel: Math.min(Math.max(0, fm.entries.length - 1), fm.sel + 1) }); return; }
      if (input === '/') { setFmPath(''); return; }
      if (input === 'h' || input === 'H') { enterFmDir(homedir(), `主目录：${homedir()}`); return; }
      if (key.return) {
        const e = fm.entries[fm.sel];
        if (!e) return;
        const full = join(fm.cwd, e.name);
        // 普通目录进入；工程目录（.uragan/）与可开 .uragan 文件直接打开
        if (e.isDir && !e.isProject) { enterFmDir(full); return; }
        rememberFmDir(fm.cwd);
        setSession(null);
        openProject(full);
        return;
      }
      if (key.backspace) { goUpFm(); return; }
      return;
    }

    /* —— 会话输入态（N / U 触发；T1：IME 整词上屏 + 左右方向键移动光标）—— */
    if (session) {
      if (key.escape) {
        setSession(null);
        setState({ ...s, toast: '已取消' });
      } else if (key.return) {
        const p = draft.trim();
        const cur = session;
        setSession(null);
        if (!p) {
          setState({ ...s, toast: '未输入路径' });
        } else if (cur === 'new') {
          createProject(p);
        } else {
          importPageFile(p);
        }
      } else {
        const e = editInput(draft, cursor, input, key);
        if (e.text !== draft || e.cursor !== cursor) setEd(e);
      }
      return;
    }

    /* —— Ctrl+S 保存回原文件：编辑态也要能用，排在所有按键判定之前 —— */
    if (key.ctrl && (input === 's' || input === 'S')) { saveDurable(); return; }

    /* —— 字段编辑态（T1：IME 整词 + 方向键光标；数字 1-5 作为内容输入，不切视图）—— */
    /* 必须排在全局动作键之前：否则 s/i/r/e/o/n/m/u/x… 会被快捷键吃掉，这些字母根本打不进字段值 */
    if (s.sub === 'edit') {
      if (key.escape) {
        setState({ ...s, sub: 'fields', toast: '已取消编辑' });
      } else if (key.return) {
        const field = selectedField(s);
        if (field) {
          const kind = fieldKind(field.field);
          const coerced = coerceValue(kind, draft);
          if (coerced.ok) {
            const file = structuredClone(s.file);
            const page = file.pages[s.pageIndex];
            if (page) page.content[field.name] = { ...field.field, value: coerced.value };
            save(file, `已更新 ${field.name} = ${String(coerced.value)}`);
            setState((cur) => (cur ? { ...cur, sub: 'fields' } : cur));
          } else {
            setState({ ...s, toast: `「${draft}」不是合法的 ${kind} 值` });
          }
        } else {
          setState((cur) => (cur ? { ...cur, sub: 'fields' } : cur));
        }
      } else {
        const e = editInput(draft, cursor, input, key);
        if (e.text !== draft || e.cursor !== cursor) setEd(e);
      }
      return;
    }

    /* —— 全局动作键（任意视图）—— */
    if (input === 'q') {
      if (s.durablePath && s.dirty && !quitArmed) {
        setQuitArmed(true);
        setState({ ...s, toast: `有改动未导出回 ${basename(s.durablePath)}：Ctrl+S 保存，或再按一次 Q 直接退出（工作目录内容仍在）` });
        return;
      }
      exit();
      return;
    }
    setQuitArmed(false);
    if (input === 'o' || input === 'O') { enterFm(); return; }
    if (input === 'n' || input === 'N') { setEd({ text: 'project.uragan', cursor: 'project.uragan'.length }); setSession('new'); return; }
    if (input === 'u' || input === 'U') { setEd({ text: 'page.json', cursor: 'page.json'.length }); setSession('pageImport'); return; }
    if (input === 'x' || input === 'X') { closeProject(); return; }
    if (input === 'v' || input === 'V') { runValidate(); return; }
    if (input === 't' || input === 'T') { runAssetsCheck(); return; }
    if (input === 's' || input === 'S') {
      exportSkeletons(s.file, workDir());
      const msg = '已导出文案框架：skeleton.json / skeleton.md';
      setState(withLog({ ...s, toast: msg }, msg, 'ok'));
      return;
    }
    if (input === 'i' || input === 'I') {
      // 导入的内容经 save 落工程目录并标记未保存（导入本身就是一次改动）
      importSkeletons(s.file, workDir(), s.projectPath, ({ toast, file }) =>
        file ? save(file, toast) : setState(withLog({ ...s, toast }, toast, 'err')),
      );
      return;
    }
    if (input === 'r' || input === 'R') {
      if (rendering) return; // 渲染中防重入；完成后 rendering 复位，可再次渲染
      setRendering(true);
      setRes({ progress: 0, message: '渲染启动…' });
      const mark = ++renderSeq;
      const pdir = outputDir(); // 视频与资产都在产出目录（用户的目录）
      void (async () => {
        try {
          const { renderProject } = await import('@uragan/render');
          const { file } = readProjectFile(s.projectPath);
          const out = join(pdir, 'render.mp4');
          const r = await renderProject(file, {
            output: out,
            projectDir: pdir,
            onProgress: (p) => {
              if (mark === renderSeq) setRes({ progress: p, message: '渲染中…' });
            },
          });
          if (mark === renderSeq) {
            setRes({ progress: 1, message: `完成 → ${out}（${r.durationSeconds.toFixed(1)}s）` });
            const msg = `渲染完成，${r.durationSeconds.toFixed(1)}s`;
            setState((cur) => (cur ? withLog({ ...cur, toast: msg }, `渲染完成 → ${out}`, 'ok') : cur));
          }
        } catch (e) {
          if (mark === renderSeq) {
            setRes({ progress: 0, message: '' });
            const msg = `渲染失败：${(e as Error).message}`;
            setState((cur) => (cur ? withLog({ ...cur, toast: msg }, msg, 'err') : cur));
          }
        } finally {
          if (mark === renderSeq) setRendering(false);
        }
      })();
      return;
    }

    /* —— 视图切换（log 视图默认定位到最新日志）—— */
    const v = VIEW_KEYS[input];
    if (v) {
      setState({ ...s, view: v, sub: 'pages', itemIndex: v === 'log' ? Math.max(0, s.log.length - 1) : 0 });
      return;
    }

    if (s.view === 'pages') {
      /* —— 页面视图内部 —— */
      if (s.sub === 'fields') {
        const fields = fieldsOfPage(selectedPage(s));
        if (key.upArrow || input === 'k') { setState({ ...s, fieldIndex: Math.max(0, s.fieldIndex - 1) }); return; }
        if (key.downArrow || input === 'j') { setState({ ...s, fieldIndex: Math.min(Math.max(0, fields.length - 1), s.fieldIndex + 1) }); return; }
        if (key.return) {
          if (fields.length > 0) {
            const f = selectedField(s);
            const init = f && f.field.value !== undefined && f.field.value !== null ? String(f.field.value) : '';
            setEd({ text: init, cursor: init.length });
            setState({ ...s, sub: 'edit' });
          }
          return;
        }
        if (key.tab || key.escape || key.leftArrow) { setState({ ...s, sub: 'pages' }); return; }
        return;
      }
      if (key.upArrow || input === 'k') { setState({ ...s, pageIndex: Math.max(0, s.pageIndex - 1), fieldIndex: 0 }); return; }
      if (key.downArrow || input === 'j') { setState({ ...s, pageIndex: Math.min(Math.max(0, s.file.pages.length - 1), s.pageIndex + 1), fieldIndex: 0 }); return; }
      if (key.leftArrow || input === 'h') {
        const f2 = moveUp(s.file, s.pageIndex);
        if (f2 !== s.file) {
          const name = f2.pages[s.pageIndex]?.name ?? '';
          save(f2, `上移：${name}`);
          setState((cur) => (cur ? withLog(cur, `上移页面：${name}`) : cur));
        }
        return;
      }
      if (key.rightArrow || input === 'l') {
        const f3 = moveDown(s.file, s.pageIndex);
        if (f3 !== s.file) {
          const name = f3.pages[s.pageIndex]?.name ?? '';
          save(f3, `下移：${name}`);
          setState((cur) => (cur ? withLog(cur, `下移页面：${name}`) : cur));
        }
        return;
      }
      if (key.tab || key.return) { if (s.file.pages.length > 0) setState({ ...s, sub: 'fields', fieldIndex: 0 }); return; }
      if (input === 'g' || input === 'G') { exportPage(); return; }
      return;
    }

    /* —— 其他视图：↑↓ 选择条目 —— */
    const listLen = listLength(s);
    if (key.upArrow || input === 'k') { setState({ ...s, itemIndex: Math.max(0, s.itemIndex - 1) }); return; }
    if (key.downArrow || input === 'j') { setState({ ...s, itemIndex: Math.min(Math.max(0, listLen - 1), s.itemIndex + 1) }); return; }
    if (key.return && s.view === 'components') {
      const comps = s.file.components ?? [];
      const c = comps[s.itemIndex];
      if (c) inlineComponent(c.componentId);
      return;
    }
  };

  // 兜底：任何一次按键里的 IO 异常都只变成底部提示，绝不让 TUI 整体崩溃（丢掉未保存编辑）
  useInput((input, key) => {
    try {
      handleInput(input, key);
    } catch (e) {
      setState((cur) => (cur ? { ...cur, toast: `操作失败：${(e as Error).message}` } : cur));
    }
  });

  if (!state) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={P.mute}>正在启动…</Text>
      </Box>
    );
  }

  const file = state.file;
  const page = selectedPage(state);
  const pages = pageRows(file);
  const total = pages.reduce((a, r) => a + r.duration, 0);
  const hasPages = file.pages.length > 0;
  /** 状态行可用宽度（扣除边框/内边距/前缀符号） */
  const statusW = Math.max(16, cols - 14);
  /**
   * 主体区每栏可视行数（保守估算）。
   * 注意：ink 的 overflowY hidden 在内容超高时会「均匀丢行」（非连续裁剪底部），
   * 因此窗口行数必须保证 标题1 + 上下提示2 + 窗口 ≤ 主体实际可用行数（rows - 固定块 ≈ rows - 16，
   * 再留快捷键栏折行/会话输入等余量）→ rows - 20。
   */
  const bodyLimit = Math.max(3, rows - 20);

  return (
    <Box
      flexDirection="column"
      width="100%"
      height={rows}
      borderStyle="round"
      borderColor={P.frame}
      backgroundColor={P.bg}
      paddingX={1}
      paddingY={1}
    >
      {/* ① 顶栏：品牌块 + 工程 + 统计（固定） */}
      <Box flexDirection="row" flexWrap="wrap" alignItems="center">
        <Box backgroundColor={P.brand} paddingX={1}>
          <Text bold color="#ffffff">◆ UraGAN</Text>
        </Box>
        <Text bold color={P.text}>  {file.project.name}</Text>
        {isUnopened(state) ? (
          <Text color={P.amber}>  未打开工程：N 新建 · O 打开</Text>
        ) : (
          <Text color={P.mute}>  {file.project.canvas.width}×{file.project.canvas.height}@{file.project.canvas.fps}</Text>
        )}
        <Box marginLeft={2} flexDirection="row" flexWrap="wrap">
          <Text color={P.mute}>页 </Text>
          <Text color={P.yellow} bold>{file.pages.length}</Text>
          <Text color={P.mute}> · 全片 </Text>
          <Text color={P.green} bold>{total.toFixed(1)}s</Text>
          {report.issues.length > 0 ? (
            <Text color={report.ok ? P.green : P.red} bold> · {report.ok ? '✓ 校验通过' : `✗ ${report.issues.filter((i) => i.severity === 'error').length} 错`}</Text>
          ) : null}
          {state.durablePath ? (
            <Text color={state.dirty ? P.amber : P.green} bold> · {state.dirty ? `● 未保存（Ctrl+S → ${basename(state.durablePath)}）` : `✓ 已同步 ${basename(state.durablePath)}`}</Text>
          ) : null}
        </Box>
      </Box>

      {/* 分隔线 */}
      <Hr />

      {/* ② 视图页签（1-6 切换；窄屏自动折行） */}
      <Box marginTop={1} flexDirection="row" flexWrap="wrap">
        {(Object.keys(VIEW_LABEL) as View[]).map((v, i) => {
          const active = state.view === v;
          return (
            <Box key={v} marginRight={1} marginY={0} paddingX={1} backgroundColor={active ? P.active : P.panel}>
              <Text color={active ? '#ffffff' : P.mute} bold={active}>[{i + 1}] {VIEW_LABEL[v]}</Text>
            </Box>
          );
        })}
      </Box>

      {/* ③ 主体（flexGrow 占满剩余高度；内容超高在此内部裁剪，布局不被顶走） */}
      <Box marginTop={1} flexGrow={1} flexShrink={1} overflowY="hidden">
        {session === 'fm' && fm ? (
          <FmView cwd={fm.cwd} entries={fm.entries} sel={fm.sel} limit={bodyLimit} pathInput={fmPath} />
        ) : state.view === 'pages' ? (
          <PageView state={state} setState={setState} page={page} pages={pages} draft={draft} cursor={cursor} limit={bodyLimit} />
        ) : state.view === 'shared' ? (
          <SharedView state={state} limit={bodyLimit} />
        ) : state.view === 'components' ? (
          <ComponentsView state={state} hasPages={hasPages} limit={bodyLimit} />
        ) : state.view === 'assets' ? (
          <AssetsView state={state} issues={assetIssues} ok={assetOk} limit={bodyLimit} />
        ) : state.view === 'log' ? (
          <LogView state={state} limit={bodyLimit} />
        ) : (
          <InfoView state={state} issues={report.issues} ok={report.ok} limit={bodyLimit} />
        )}
      </Box>

      {/* ④ 进度 + 状态（固定，长文本单行截断） */}
      <Box marginTop={1} flexDirection="column" flexShrink={0}>
        {res.message ? (
          <Text color={P.green}>
            {'█'.repeat(Math.round(res.progress * 22))}
            {'░'.repeat(22 - Math.round(res.progress * 22))}
            <Text> </Text>
            <Text color={P.yellow}>{String(Math.round(res.progress * 100)).padStart(3)}%</Text>
            <Text color={P.mute}>  {clip(res.message, statusW)}</Text>
          </Text>
        ) : null}
        {session && session !== 'fm' ? (
          <Box flexDirection="row" flexWrap="wrap">
            <Text color={P.amber} bold>{session === 'new' ? '新建工程' : '导入单页文件'}：</Text>
            <Text color={P.text}>
              {draft.slice(Math.max(0, cursor - 40), cursor)}
              <Text color={P.green} bold>▏</Text>
              {draft.slice(cursor, cursor + 40)}
            </Text>
            <Text color={P.mute}>  Enter 确认 · Esc 取消 · ←→ 移光标 · Backspace 删除</Text>
          </Box>
        ) : null}
        <Box flexDirection="row" flexWrap="wrap">
          {state.toast ? (
            <Text color={P.amber}>◇ {clip(state.toast, statusW)}</Text>
          ) : (
            <Text color={P.mute}>按键 1-6 切换视图；操作键见下方快捷键栏</Text>
          )}
        </Box>
      </Box>

      {/* ⑤ 快捷键栏（固定底部；flexWrap 保证窄屏自动折行，键位不丢） */}
      <Box marginTop={1} backgroundColor={P.panel} paddingX={2} paddingY={1} flexDirection="row" flexWrap="wrap" flexShrink={0}>
        {state.view === 'pages' ? (
          <>
            <Key k="↑↓" t="选择页面" color={P.text} />
            <Key k="←→" t="移动顺序" color={P.text} />
            <Key k="Enter" t="进入字段" color={P.text} />
            <Key k="G" t="导出单页文件" color={P.green} />
            {/* U 只在页面视图的上下文键位里出现一次：再进全局 SHORTCUTS 就会重复显示两遍 */}
            <Key k="U" t="导入单页文件" color={P.green} />
          </>
        ) : state.view === 'components' ? (
          <>
            <Key k="↑↓" t="选择组件" color={P.text} />
            <Key k="Enter" t="内联到当前页" color={P.text} />
          </>
        ) : state.view === 'shared' ? (
          <Key k="↑↓" t="浏览共享定义" color={P.text} />
        ) : state.view === 'log' ? (
          <Key k="↑↓" t="浏览操作日志" color={P.text} />
        ) : (
          <></>
        )}
        {SHORTCUTS.map((sc) => (
          <Key key={sc.k} k={sc.k} t={sc.t} color={sc.color} />
        ))}
      </Box>
    </Box>
  );
}

/** 分隔线：整行色块（宽度自动撑满容器，无需关心列数） */
function Hr(): React.ReactElement {
  return <Box height={1} backgroundColor={P.line} />;
}

/* ---------------- 视图子组件 ---------------- */

function Panel({ title, children, active }: { title: string; children: React.ReactNode; active: boolean }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={0} backgroundColor={active ? P.active : P.panel} flexShrink={0}>
      <Box flexDirection="row">
        <Text bold color={active ? '#ffffff' : P.cyan}>▍</Text>
        <Text bold color={active ? '#ffffff' : P.text}>{clip(title, 43)}</Text>
      </Box>
      {children}
    </Box>
  );
}

function PageView(props: {
  state: TuiSnapshot;
  setState: React.Dispatch<React.SetStateAction<TuiSnapshot | undefined>>;
  page: ReturnType<typeof selectedPage>;
  pages: ReturnType<typeof pageRows>;
  draft: string;
  cursor: number;
  limit: number;
}): React.ReactElement {
  const { state, setState, page, pages, draft, cursor, limit } = props;
  const onPages = state.sub === 'pages';
  const onFields = state.sub === 'fields' || state.sub === 'edit';
  const fields = fieldsOfPage(page);
  /** 动画摘要（并入详情标题，省去独立动画行，保证右栏不超高） */
  const animHead = page && page.animations.length > 0 ? ` · ⚡${page.animations[0]!.effect}@${(page.animations[0]!.delay ?? 0).toFixed(1)}s` : '';
  /** 左栏页面列表 / 右栏字段列表的可见窗口（选中项居中跟随，上下被隐藏部分给指示器） */
  const pwin = viewWindow(pages.length, onPages ? state.pageIndex : -1, limit);
  const fwin = viewWindow(fields.length, onFields ? state.fieldIndex : -1, limit);

  return (
    <Box flexDirection="row" width="100%">
      <Panel title={`页面 · 播放顺序  ${onPages ? '●' : ''}`} active={onPages}>
        <Box width={30} flexDirection="column">
          {pages.length === 0 ? (
            <Text color={P.mute}>（无页面，O 打开 / N 新建）</Text>
          ) : (
            <>
              <MoreHint n={pwin.moreTop} dir="top" />
              {pages.slice(pwin.start, pwin.end).map(({ index, page: p, duration }) => {
                const active = index === state.pageIndex && onPages;
                const kindColor = KIND_COLOR[p.kind] ?? P.mute;
                return (
                  <Box key={p.pageId} paddingY={0} backgroundColor={active ? P.hilite : undefined} width="100%">
                    <Text color={active ? P.yellow : P.mute}>{active ? '▶' : ' '} {String(index + 1).padStart(2, '0')} </Text>
                    <Text color={active ? 'white' : P.text} bold>{clip(p.name, 9)}</Text>
                    <Text color={kindColor} bold> {KIND_TAG[p.kind] ?? p.kind}</Text>
                    <Text color={active ? 'white' : P.mute}>{duration.toFixed(1)}s</Text>
                  </Box>
                );
              })}
              <MoreHint n={pwin.moreBottom} dir="bottom" />
            </>
          )}
        </Box>
      </Panel>

      <Box flexGrow={1} marginLeft={1}>
        <Panel
          title={`详情：${page?.name ?? '—'}${page ? ` · ${KIND_TAG[page.kind] ?? page.kind}` : ''}${animHead}${onFields ? ' ●' : ''}`}
          active={onFields}
        >
          {page ? (
            <Box flexDirection="column">
              {fields.length > 0 ? <MoreHint n={fwin.moreTop} dir="top" /> : null}
              {fields.slice(fwin.start, fwin.end).map((f, i) => {
                const idx = fwin.start + i;
                const focus = onFields && idx === state.fieldIndex;
                const editing = state.sub === 'edit' && idx === state.fieldIndex;
                const kind = fieldKind(f.field);
                const kindColor = kind === 'number' ? P.yellow : kind === 'boolean' ? P.cyan : kind === 'asset' ? P.pink : P.mute;
                return (
                  <Box key={f.name} width="100%">
                    <Box width={17} paddingX={1} backgroundColor={focus ? P.hilite : undefined}>
                      <Text color={focus ? 'white' : P.mute}>{focus ? (editing ? '✎ ' : '❯ ') : '  '}{clip(f.name, 12)}</Text>
                    </Box>
                    <Box width={7} backgroundColor={focus ? P.hilite : undefined}>
                      <Text color={kindColor} bold>{kind}</Text>
                    </Box>
                    <Box flexGrow={1} backgroundColor={focus ? P.hilite : undefined} paddingRight={1}>
                      {editing ? (
                        <Text color={P.text}>{draft.slice(0, cursor)}<Text color={P.green} bold>▏</Text>{draft.slice(cursor)}</Text>
                      ) : (
                        <Text color={focus ? 'white' : P.text}>{clip(displayValue(f.field), 42)}</Text>
                      )}
                    </Box>
                  </Box>
                );
              })}
              {fields.length === 0 ? <Text color={P.mute}>（此页无可编辑字段）</Text> : null}
              <MoreHint n={fwin.moreBottom} dir="bottom" />
            </Box>
          ) : (
            <Text color={P.mute}>（未打开工程）</Text>
          )}
        </Panel>
      </Box>
    </Box>
  );
}

/** 列表超出隐藏指示器：顶部「↑ 上方还有 N 项」/ 底部「↓ 下方还有 N 项」；N=0 不渲染 */
function MoreHint({ n, dir }: { n: number; dir: 'top' | 'bottom' }): React.ReactElement | null {
  if (n <= 0) return null;
  return (
    <Box paddingX={1}>
      <Text color={P.amber}>{dir === 'top' ? `↑ 上方还有 ${n} 项` : `↓ 下方还有 ${n} 项`}</Text>
    </Box>
  );
}

/** 文件管理器视图（T5：浏览目录 + 打开工程；仅展示目录与可开工程条目） */
/** 长路径保留尾部（路径提示：开头可省略，末尾最关键） */
function clipPathHead(s: string, n: number): string {
  if (s.length <= n) return s;
  return '…' + s.slice(s.length - Math.max(0, n - 1));
}

function FmView({ cwd, entries, sel, limit, pathInput }: { cwd: string; entries: FmEntry[]; sel: number; limit: number; pathInput: string | null }): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  const win = viewWindow(entries.length, sel, limit);
  return (
    <Box flexDirection="column" width="100%">
      <Panel title="文件管理器 · 打开工程" active={false}>
        <Box flexDirection="column">
          {/* 路径提示栏：当前位置一目了然；长路径省略开头保留末尾 */}
          <Box paddingX={1} marginBottom={1}>
            <Text color={P.cyan}>◈ {clipPathHead(cwd, Math.max(24, cols - 14))}</Text>
          </Box>
          <Box height={1} backgroundColor={P.line} />
          {entries.length === 0 ? <Text color={P.mute}>（空目录）</Text> : null}
          <MoreHint n={win.moreTop} dir="top" />
          {entries.slice(win.start, win.end).map((e, i) => {
            const active = win.start + i === sel;
            return (
              <Box key={e.name} paddingY={0} backgroundColor={active ? P.hilite : undefined} width="100%">
                <Text color={active ? 'white' : P.text}>{active ? '▶ ' : '  '}
                  {e.isDir ? '▸ ' : '  '}{clip(e.name, 40)}{e.isDir ? '/' : ''}</Text>
                {!e.isDir ? (
                  <Text color={active ? 'white' : P.green}>{e.isProject ? '（工程）' : '（文件）'}</Text>
                ) : (
                  <Text color={P.mute}>{e.name.toLowerCase().endsWith('.uragan') ? '（工程）' : ''}</Text>
                )}
              </Box>
            );
          })}
          <MoreHint n={win.moreBottom} dir="bottom" />
          {pathInput !== null ? (
            <Box marginTop={1} paddingX={1} backgroundColor={P.active}>
              <Text color="white">路径: {clip(pathInput, Math.max(10, cols - 24))}▍</Text>
            </Box>
          ) : null}
        </Box>
      </Panel>
      <Box marginY={1}>
        <Text color={P.mute}>↑↓ 选择 · Enter 进入/打开 · Backspace 上级 · H 主目录 · / 输入路径 · Esc 关闭（位置已记忆）</Text>
      </Box>
    </Box>
  );
}

function SharedView({ state, limit }: { state: TuiSnapshot; limit: number }): React.ReactElement {
  const { config } = Uragan.exportConfig(state.file);
  const keys = Object.keys(config.$shared);
  const sel = state.itemIndex;
  const selKey = keys[sel];
  const win = viewWindow(keys.length, sel, limit);
  return (
    <Box flexDirection="row" width="100%">
      <Panel title={`共享池 $shared（${keys.length} 项）`} active={false}>
        <Box width={30} flexDirection="column">
          {keys.length === 0 ? (
            <Text color={P.mute}>（空，导出时自动去重生成）</Text>
          ) : (
            <>
              <MoreHint n={win.moreTop} dir="top" />
              {keys.slice(win.start, win.end).map((k, i) => (
                <Box key={k} paddingY={0} backgroundColor={win.start + i === sel ? P.hilite : undefined} width="100%">
                  <Text color={win.start + i === sel ? 'white' : P.text}>{win.start + i === sel ? '❯ ' : '  '}{clip(k, 24)}</Text>
                </Box>
              ))}
              <MoreHint n={win.moreBottom} dir="bottom" />
            </>
          )}
        </Box>
      </Panel>
      <Box flexGrow={1} marginLeft={1}>
        <Panel title={`定义详情${selKey ? ` · ${selKey}` : ''}`} active={false}>
          {selKey ? (
            <Box flexDirection="column" paddingX={1}>
              <Text color={P.text}>类型：<Text bold color={P.cyan}>{String(config.$shared[selKey]!.type)}</Text></Text>
              <Text color={P.text}>值：<Text color={P.yellow}>{defSummary(config.$shared[selKey])}</Text></Text>
              <Box marginTop={1}>
                <Text color={P.mute}>导出时作为共享定义（去重投影到 $shared）</Text>
              </Box>
            </Box>
          ) : (
            <Text color={P.mute}>（空）</Text>
          )}
        </Panel>
      </Box>
    </Box>
  );
}

function ComponentsView({ state, hasPages, limit }: { state: TuiSnapshot; hasPages: boolean; limit: number }): React.ReactElement {
  const comps = state.file.components ?? [];
  const sel = state.itemIndex;
  const comp = comps[sel];
  const win = viewWindow(comps.length, sel, limit);
  return (
    <Box flexDirection="row" width="100%">
      <Panel title={`组件（${comps.length}）`} active={false}>
        <Box width={30} flexDirection="column">
          {comps.length === 0 ? (
            <Text color={P.mute}>（无组件）</Text>
          ) : (
            <>
              <MoreHint n={win.moreTop} dir="top" />
              {comps.slice(win.start, win.end).map((c, i) => (
                <Box key={c.componentId} paddingY={0} backgroundColor={win.start + i === sel ? P.hilite : undefined} width="100%">
                  <Text color={win.start + i === sel ? 'white' : P.text}>{win.start + i === sel ? '❯ ' : '  '}{clip(c.componentId, 14)}</Text>
                  <Text color={win.start + i === sel ? 'white' : P.mute}> {clip(c.name, 10)}</Text>
                </Box>
              ))}
              <MoreHint n={win.moreBottom} dir="bottom" />
            </>
          )}
        </Box>
      </Panel>
      <Box flexGrow={1} marginLeft={1}>
        <Panel title={`组件详情${comp ? ` · ${comp.componentId}` : ''}`} active={false}>
          {comp ? (
            <Box flexDirection="column" paddingX={1}>
              <Text color={P.text}>名称：<Text bold>{comp.name}</Text></Text>
              <Text color={P.text}>$defs：<Text color={P.yellow}>{Object.keys(comp.$defs).length} 项</Text> · code：{comp.code ? <Text color={P.green}>有</Text> : <Text color={P.mute}>无</Text>}</Text>
              {Object.keys(comp.$defs).length > 0 ? (
                <Box marginTop={1}>
                  {Object.entries(comp.$defs).slice(0, 6).map(([k, d]) => (
                    <Text key={k} color={P.mute}>  {clip(k, 16)} = {clip(defSummary(d), 30)}</Text>
                  ))}
                </Box>
              ) : null}
              <Box marginTop={1}>
                <Text color={hasPages ? P.green : P.mute}>{hasPages ? 'Enter 复制代码到当前页（断开父子关系）' : '（先打开工程并选择目标页）'}</Text>
              </Box>
            </Box>
          ) : (
            <Text color={P.mute}>（无组件）</Text>
          )}
        </Panel>
      </Box>
    </Box>
  );
}

function AssetsView({ state, issues, ok, limit }: { state: TuiSnapshot; issues: Issue[]; ok: boolean; limit: number }): React.ReactElement {
  const [refs, setRefs] = React.useState<{ src: string; where: string }[]>([]);
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { collectAssetRefs } = await import('@uragan/render');
        if (alive) setRefs(collectAssetRefs(state.file));
      } catch {
        if (alive) setRefs([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [state.file]);
  const win = viewWindow(refs.length, -1, limit);
  return (
    <Box flexDirection="row" width="100%">
      <Panel title={`资产引用（${refs.length}）· T 体检`} active={false}>
        <Box width={30} flexDirection="column">
          {refs.length === 0 ? (
            <Text color={P.mute}>（无资产引用）</Text>
          ) : (
            <>
              <MoreHint n={win.moreTop} dir="top" />
              {refs.slice(win.start, win.end).map((r) => (
                <Text key={r.src} color={P.mute}>  {clip(r.src, 26)}</Text>
              ))}
              <MoreHint n={win.moreBottom} dir="bottom" />
            </>
          )}
        </Box>
      </Panel>
      <Box flexGrow={1} marginLeft={1}>
        <Panel title="资产体检" active={false}>
          {refs.length > 0 ? (
            <Box flexDirection="column" paddingX={1}>
              <Text color={P.mute}>引用明细见左侧；按 T 执行体检（网络/本地可达性）</Text>
            </Box>
          ) : (
            <Text color={P.mute}>（无资产引用，按 T 体检全部资产）</Text>
          )}
          {issues.length > 0 ? (
            <Box marginTop={1} flexDirection="column">
              <Text bold color={ok ? P.green : P.red}>体检结果（{issues.filter((i) => i.severity === 'error').length} 错 / {issues.filter((i) => i.severity === 'warning').length} 警）：</Text>
              {issues.slice(0, 10).map((i, n) => (
                <Text key={n} color={i.severity === 'error' ? P.red : P.amber}>  {i.severity === 'error' ? '✗' : '⚠'} [{i.code}] {clip(i.message, 60)}</Text>
              ))}
              {issues.length > 10 ? <Text color={P.mute}>  …（共 {issues.length} 条）</Text> : null}
            </Box>
          ) : null}
        </Panel>
      </Box>
    </Box>
  );
}

function InfoView({ state, issues, ok, limit }: { state: TuiSnapshot; issues: Issue[]; ok: boolean; limit: number }): React.ReactElement {
  const file = state.file;
  const stats = file.pages.map((p) => ({ p, ...pageStats(p) }));
  const comps = file.components?.length ?? 0;
  const win = viewWindow(stats.length, -1, limit);
  return (
    <Box flexDirection="row" width="100%">
      <Panel title="工程信息" active={false}>
        <Box width={30} flexDirection="column" paddingX={1}>
          <InfoRow k="工程 ID" v={file.project.id} />
          <InfoRow k="名称" v={file.project.name} />
          <InfoRow k="画布" v={`${file.project.canvas.width}×${file.project.canvas.height}@${file.project.canvas.fps}`} />
          <InfoRow k="schema" v={file.schemaVersion} />
          <InfoRow k="默认时长" v={file.project.defaults ? `${String(file.project.defaults.pageDuration)}s` : '2.5s'} />
          <InfoRow k="页面数" v={String(file.pages.length)} />
          <InfoRow k="组件数" v={String(comps)} />
        </Box>
      </Panel>
      <Box flexGrow={1} marginLeft={1}>
        <Panel title={`每页统计 · 校验 ${ok ? '通过' : '有错'}（V 重新校验）`} active={false}>
          <Box flexDirection="column" paddingX={1}>
            <MoreHint n={win.moreTop} dir="top" />
            {stats.slice(win.start, win.end).map(({ p, fields, copy, animations }) => (
              <Box key={p.pageId} width="100%">
                <Box width={16}><Text color={P.text} bold>{clip(p.name, 12)}</Text></Box>
                <Box width={8}><Text color={P.mute}>{p.kind}</Text></Box>
                <Box width={14}><Text color={P.mute}>字段 {fields}</Text></Box>
                <Box width={12}><Text color={P.yellow}>文案 {copy}</Text></Box>
                <Box width={12}><Text color={P.mute}>动画 {animations}</Text></Box>
                <Text color={P.amber}>{p.duration ? `${String(p.duration)}s` : '默认'}</Text>
              </Box>
            ))}
            {stats.length === 0 ? <Text color={P.mute}>（无页面）</Text> : null}
            <MoreHint n={win.moreBottom} dir="bottom" />
            {issues.length > 0 ? (
              <Box marginTop={1} flexDirection="column">
                {issues.slice(0, 10).map((i, n) => (
                  <Text key={n} color={i.severity === 'error' ? P.red : P.amber}>  {i.severity === 'error' ? '✗' : '⚠'} [{i.code}] {clip(i.message, 70)} @{clip(i.path, 20)}</Text>
                ))}
              </Box>
            ) : null}
          </Box>
        </Panel>
      </Box>
    </Box>
  );
}

function InfoRow({ k, v }: { k: string; v: string }): React.ReactElement {
  return (
    <Box width="100%">
      <Box width={10}><Text color={P.mute}>{k}</Text></Box>
      <Text color={P.text}>{clip(v, 24)}</Text>
    </Box>
  );
}

/** 日志视图（6）：操作日志（时间 + 级别配色），↑↓ 浏览历史，超出隐藏 + 上下提示 */
function LogView({ state, limit }: { state: TuiSnapshot; limit: number }): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  const log = state.log;
  const sel = state.itemIndex;
  const win = viewWindow(log.length, sel, limit);
  const levelColor = (l: LogLevel): string => (l === 'ok' ? P.green : l === 'warn' ? P.amber : l === 'err' ? P.red : P.mute);
  return (
    <Box flexDirection="column" width="100%">
      <Panel title={`日志 · 操作记录（${log.length} 条）`} active={false}>
        <Box flexDirection="column">
          {log.length === 0 ? (
            <Text color={P.mute}>（暂无操作日志，打开/保存/校验/渲染等操作会记录在这里）</Text>
          ) : (
            <>
              <MoreHint n={win.moreTop} dir="top" />
              {log.slice(win.start, win.end).map((e, i) => {
                const idx = win.start + i;
                return (
                  <Box key={idx} width="100%" backgroundColor={idx === sel ? P.hilite : undefined} paddingX={1}>
                    <Text color={P.mute}>{e.time} </Text>
                    <Text color={levelColor(e.level)}>{clip(e.msg, Math.max(20, cols - 20))}</Text>
                  </Box>
                );
              })}
              <MoreHint n={win.moreBottom} dir="bottom" />
            </>
          )}
        </Box>
      </Panel>
      <Box marginY={1}>
        <Text color={P.mute}>↑↓ 浏览历史 · 最新日志在底部（进入视图时自动定位）</Text>
      </Box>
    </Box>
  );
}

/** 快捷键项：键帽（深底 + 分类色）+ 完整说明；窄屏随容器换行 */
function Key({ k, t, color = P.yellow }: { k: string; t: string; color?: string }): React.ReactElement {
  return (
    <Box marginRight={2} marginY={0}>
      <Box backgroundColor={P.keyCap} paddingX={1}>
        <Text bold color={color}>{k}</Text>
      </Box>
      <Text color={P.mute}> {t}</Text>
    </Box>
  );
}

function listLength(s: TuiSnapshot): number {
  switch (s.view) {
    case 'shared':
      return Object.keys(Uragan.exportConfig(s.file).config.$shared).length;
    case 'components':
      return s.file.components?.length ?? 0;
    case 'log':
      return s.log.length;
    default:
      return 1; // pages/info/assets 无条目选中
  }
}

/** 导出 JSON + Markdown 文案框架到工程目录 */
function exportSkeletons(file: ProjectFile, dir: string): void {
  const { skeleton } = exportSkeleton(file);
  writeFileSync(join(dir, 'skeleton.json'), JSON.stringify(skeleton, null, 2) + '\n', 'utf8');
  const { text } = exportSkeletonText(file);
  writeFileSync(join(dir, 'skeleton.md'), text, 'utf8');
}

/** 从文案框架 md/json 导入已填内容（能读哪个读哪个；无文件则提示） */
function importSkeletons(
  file: ProjectFile,
  dir: string,
  projectPath: string,
  onResult: (opts: { toast: string; file?: ProjectFile }) => void,
): void {
  const read = async (path: string): Promise<string | undefined> => {
    try {
      const { readFileSync } = await import('node:fs');
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  };
  void (async () => {
    const md = await read(join(dir, 'skeleton.md'));
    const json = await read(join(dir, 'skeleton.json'));
    const fail = (toast: string): void => onResult({ toast });
    let next: ProjectFile | undefined;
    try {
      if (md && parseSkeletonText(md).report.ok) {
        const parsed = parseSkeletonText(md);
        const r = Uragan.applySkeleton(file, parsed.skeleton);
        if (r.report.ok) next = r.file;
        else return fail(`文案框架导入失败：${r.report.errors.map((e) => `[${e.code}] ${e.message}`).join('；')}`);
      } else if (json) {
        const r = Uragan.applySkeleton(file, JSON.parse(json) as never);
        if (r.report.ok) next = r.file;
        else return fail(`文案框架导入失败：${r.report.errors.map((e) => `[${e.code}] ${e.message}`).join('；')}`);
      } else {
        return fail('未找到 skeleton.md / skeleton.json（先按 S 导出文案框架）');
      }
    } catch (e) {
      return fail(`导入失败：${(e as Error).message}`);
    }
    if (next) {
      try {
        writeProjectFile(projectPath, next);
        onResult({ toast: '✓ 已导入文案框架内容', file: next });
      } catch (e) {
        fail(`保存失败：${(e as Error).message}`);
      }
    }
  })();
}
