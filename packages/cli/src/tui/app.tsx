import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { Issue, Page, ProjectFile } from '@uragan/shared';
import {
  Uragan,
  blankFile,
  exportSkeleton,
  exportSkeletonText,
  isProjectDir,
  parseSkeletonText,
  readProjectFile,
  validateProjectFile,
  withProjectExt,
  writeProjectFile,
} from '@uragan/core';
import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import {
  clip,
  coerceValue,
  defSummary,
  displayValue,
  editInput,
  fieldKind,
  fieldsOfPage,
  isOpenableProject,
  lastFmDir,
  moveDown,
  moveUp,
  pageRows,
  pageStats,
  rememberFmDir,
  selectedField,
  selectedPage,
  snapshot,
  sortFm,
  VIEW_LABEL,
  type FieldView,
  type FmEntry,
  type TuiSnapshot,
  type View,
} from './state.js';

/* ---------------- 主题：背景块 + 文字（黑/白终端背景都清晰，无需边框） ---------------- */
const P = {
  panel: '#1e293b', // 面板底色（深块，白/黑背景上都醒目）
  panelActive: '#3730a3', // 焦点面板底色（深靛蓝）
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

const VIEW_KEYS: Record<string, View> = { '1': 'pages', '2': 'shared', '3': 'components', '4': 'assets', '5': 'info' };

/** 全局快捷键清单（UI 由此渲染，保证功能名完整、可单测） */
export const SHORTCUTS: { k: string; t: string; color?: string }[] = [
  { k: 'S', t: '导出文案框架' },
  { k: 'I', t: '导入文案' },
  { k: 'R', t: '渲染视频' },
  { k: 'E', t: '导出整体配置' },
  { k: 'M', t: '导入配置' },
  { k: 'V', t: '校验', color: '#34d399' },
  { k: 'T', t: '资产体检', color: '#34d399' },
  { k: 'U', t: '导入单页文件', color: '#34d399' },
  { k: 'O', t: '打开工程', color: '#fbbf24' },
  { k: 'N', t: '新建工程', color: '#fbbf24' },
  { k: 'X', t: '关闭工程', color: '#fbbf24' },
  { k: 'Q', t: '退出', color: '#f87171' },
];

let renderSeq = 0;

export function TuiApp({ projectPath }: TuiAppProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<TuiSnapshot>();
  /** 输入态：文本 + 光标位置（T1：IME 整词上屏、方向键移动光标共用同一状态） */
  const [ed, setEd] = useState<{ text: string; cursor: number }>({ text: '', cursor: 0 });
  const draft = ed.text;
  const cursor = ed.cursor;
  const [res, setRes] = useState<Progress>({ progress: 0, message: '' });
  /** 渲染进行中（用于防重入；完成/失败后复位，可再次渲染） */
  const [rendering, setRendering] = useState(false);
  /** 会话子状态：new（新建）/import（导入配置）/pageImport（导入单页）+ fm（文件管理器）；null=正常浏览 */
  const [session, setSession] = useState<'new' | 'import' | 'pageImport' | 'fm' | null>(null);
  /** 文件管理器（T5：打开工程改用内置 FM，O 进入） */
  const [fm, setFm] = useState<{ cwd: string; entries: FmEntry[]; sel: number } | null>(null);
  /** 校验/资产体检结果缓存（信息/资产视图展示） */
  const [report, setReport] = useState<{ issues: Issue[]; ok: boolean }>({ issues: [], ok: true });
  const [assetIssues, setAssetIssues] = useState<Issue[]>([]);
  const [assetOk, setAssetOk] = useState(true);

  useEffect(() => {
    if (state) return;
    openProject(projectPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, projectPath]);

  /** 打开工程（T2：目录工程聚合读；单文件自动展开为同名 <名>.uragan/ 目录后指向新目录） */
  const openProject = (path: string): void => {
    const p = isProjectDir(path) ? path : withProjectExt(path);
    const r = Uragan.openProject(p);
    if (r.report.errors.some((e) => e.severity === 'error') && r.file.pages.length === 0) {
      setState((s) => (s ? { ...s, toast: r.report.errors.map((e) => `[${e.code}] ${e.message}`).join('；') } : s));
      return;
    }
    setReport({ issues: r.report.errors, ok: r.report.ok });
    setState({
      ...snapshot(r.projectPath, r.file),
      toast: r.converted ? `已导入展开 → ${basename(r.projectPath)}（按页拆分落盘）` : `已打开 ${basename(r.projectPath)}`,
    });
  };

  /** 工程文件所在目录（目录工程 = 目录本身；单文件/legacy = 父目录）——相对路径资产/副产品以此为基准 */
  const projectDir = (): string => {
    const p = state?.projectPath ?? '';
    return p && isProjectDir(p) ? p : dirname(p);
  };

  const save = (file: ProjectFile, toast: string): void => {
    const p = state?.projectPath;
    if (!p) return;
    try {
      writeProjectFile(p, file);
    } catch (e) {
      toast = `保存失败：${(e as Error).message}`;
    }
    setState((s) => (s ? { ...s, file, toast } : s));
  };

  /* —— 文件管理器（T5：O 进入；目录/可开工程白名单展示，记忆上次位置）—— */
  const listFm = (dir: string): FmEntry[] | undefined => {
    try {
      const raw = readdirSync(dir, { withFileTypes: true });
      return sortFm(
        raw
          .map((d) => ({ name: d.name, isDir: d.isDirectory(), isProject: isOpenableProject(d.name, d.isDirectory()) }))
          .filter((e) => e.isDir || e.isProject),
      );
    } catch {
      return undefined;
    }
  };

  const enterFmDir = (dir: string, toast = ''): void => {
    const entries = listFm(dir);
    if (!entries) {
      setState((cur) => (cur ? { ...cur, toast: `无法读取目录：${dir}` } : cur));
      return;
    }
    rememberFmDir(dir);
    setFm({ cwd: dir, entries, sel: 0 });
    setSession('fm');
    if (toast) setState((cur) => (cur ? { ...cur, toast } : cur));
  };

  /** 进入文件管理器：起始目录 = 上次位置，否则当前工程所在目录（记忆上次位置） */
  const enterFm = (): void => {
    const base = state?.projectPath ? dirname(state.projectPath) : process.cwd();
    enterFmDir(lastFmDir(base));
  };

  /** 上级目录（已到根则退出） */
  const goUpFm = (): void => {
    if (!fm) return;
    const parent = dirname(fm.cwd);
    if (parent === fm.cwd) {
      setSession(null);
      return;
    }
    enterFmDir(parent);
  };

  /** 导入单页文件（T4：对应导出单页 G；按 pageId 替换或追加） */
  const importPageFile = (path: string): void => {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (e) {
      setState((s) => (s ? { ...s, toast: `读取失败：${(e as Error).message}` } : s));
      return;
    }
    let pageInput: unknown;
    try {
      pageInput = JSON.parse(text);
    } catch {
      setState((s) => (s ? { ...s, toast: `解析失败：${path} 不是合法 JSON 单页文件` } : s));
      return;
    }
    const s = state;
    if (!s) return;
    const r = Uragan.overwritePage(s.file, pageInput);
    if (!r.report.ok) {
      setState({ ...s, toast: `导入单页失败：${r.report.errors.map((e) => `[${e.code}] ${e.message}`).join('；')}` });
      return;
    }
    const pageId = (pageInput as { pageId?: string } | undefined)?.pageId ?? '?';
    save(r.file, `已导入单页 ${pageId}（来自 ${basename(path)}）`);
  };

  const createProject = (path: string): void => {
    const p = withProjectExt(path);
    if (existsSync(p)) {
      setState((s) => (s ? { ...s, toast: `已存在：${p}` } : s));
      return;
    }
    const file = blankFile();
    file.project.name = basename(p).replace(/\.[^.]+$/, '') || '未命名';
    try {
      writeProjectFile(p, file);
      setState({ ...snapshot(p, file), toast: `已新建 ${basename(p)}` });
    } catch (e) {
      setState((s) => (s ? { ...s, toast: `新建失败：${(e as Error).message}` } : s));
    }
  };

  /** 导入整体配置（交换配置或工程文件 JSONC）覆盖当前工程 */
  const importConfig = (path: string): void => {
    void (async () => {
      try {
        const { readFileSync } = await import('node:fs');
        const text = readFileSync(path, 'utf8');
        const { file, report } = Uragan.importFromText(text);
        if (!report.ok) {
          setState((s) => (s ? { ...s, toast: `导入失败：${report.errors.map((e) => `[${e.code}] ${e.message}`).join('；')}` } : s));
          return;
        }
        // 写入当前工程（若已打开）否则落到配置同名 .uragan
        const out = existsSync(state?.projectPath ?? '') ? state!.projectPath : withProjectExt(path.replace(/\.(json|jsonc)$/i, ''));
        try {
          writeProjectFile(out, file);
        } catch {
          /* 写入失败仍进入内存态 */
        }
        setState({ ...snapshot(out, file), toast: `已导入 ${file.pages.length} 页` });
        const rep = validateProjectFile(file);
        setReport({ issues: rep.errors, ok: rep.ok });
      } catch (e) {
        setState((s) => (s ? { ...s, toast: `导入失败：${(e as Error).message}` } : s));
      }
    })();
  };

  /** 导出整体交换配置（dedup 重投影 $shared） */
  const exportConfig = (): void => {
    const s = state;
    if (!s) return;
    const { config, report } = Uragan.exportConfig(s.file);
    if (!report.ok) {
      setState({ ...s, toast: `导出失败：${report.errors.map((e) => `[${e.code}] ${e.message}`).join('；')}` });
      return;
    }
    const out = join(projectDir(), 'config.json');
    try {
      writeFileSync(out, JSON.stringify(config, null, 2) + '\n', 'utf8');
      setState({ ...s, toast: `已导出整体交换配置（$shared ${Object.keys(config.$shared).length} 项）→ ${out}` });
    } catch (e) {
      setState({ ...s, toast: `导出失败：${(e as Error).message}` });
    }
  };

  /** 导出当前单页为独立文件（含头部 $defs） */
  const exportPage = (): void => {
    const s = state;
    if (!s || s.file.pages.length === 0) return;
    const page = selectedPage(s);
    if (!page) return;
    const out = join(projectDir(), `page-${page.pageId}.json`);
    try {
      writeFileSync(out, JSON.stringify(page, null, 2) + '\n', 'utf8');
      setState({ ...s, toast: `已导出单页 ${page.pageId} → ${out}` });
    } catch (e) {
      setState({ ...s, toast: `导出失败：${(e as Error).message}` });
    }
  };

  /** 校验工程 */
  const runValidate = (file?: ProjectFile): void => {
    const f = file ?? state?.file;
    if (!f) return;
    const rep = validateProjectFile(f);
    setReport({ issues: rep.errors, ok: rep.ok });
    setState((s) => (s ? { ...s, toast: rep.ok ? '✓ 校验通过' : `校验发现 ${rep.errors.filter((e) => e.severity === 'error').length} 个错误` } : s));
  };

  /** 资产体检（render 层） */
  const runAssetsCheck = (): void => {
    const s = state;
    if (!s) return;
    setState({ ...s, toast: '资产体检中…' });
    void (async () => {
      try {
        const { checkAssets, collectAssetRefs } = await import('@uragan/render');
        collectAssetRefs; // 仅用于展示引用
        const r = await checkAssets(s.file, projectDir(), 'assets');
        setAssetIssues(r.issues);
        setAssetOk(r.ok);
        setState((cur) => (cur ? { ...cur, toast: r.issues.length === 0 ? '✓ 资产全部有效' : `发现 ${r.issues.filter((i) => i.severity === 'error').length} 个失效` } : cur));
      } catch (e) {
        setState((cur) => (cur ? { ...cur, toast: `资产体检失败：${(e as Error).message}` } : cur));
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
      setState({ ...s, toast: `内联失败：${report.errors.map((e) => `[${e.code}] ${e.message}`).join('；')}` });
      return;
    }
    save(file, `已内联 ${componentId} → ${pageId}`);
  };

  /** 关闭当前工程（回到空载态） */
  const closeProject = (): void => {
    const s = state;
    if (!s) return;
    const empty: ProjectFile = {
      schemaVersion: '1',
      project: { id: 'none', name: '（未打开工程）', canvas: { width: 0, height: 0, fps: 0 } },
      pages: [],
    };
    setState({ ...snapshot(s.projectPath, empty), toast: '已关闭工程（O 重新打开）' });
    setReport({ issues: [], ok: true });
    setAssetIssues([]);
  };

  useInput((input, key) => {
    const s = state;
    if (!s) return;

    /* —— 文件管理器（T5：O 打开工程；↑↓ 选择、Enter 进入/打开、Backspace 上级、Esc 关闭）—— */
    if (session === 'fm' && fm) {
      if (key.escape || (key.backspace && dirname(fm.cwd) === fm.cwd)) { setSession(null); setState({ ...s, toast: '已关闭文件管理器' }); return; }
      if (key.upArrow || input === 'k') { setFm({ ...fm, sel: Math.max(0, fm.sel - 1) }); return; }
      if (key.downArrow || input === 'j') { setFm({ ...fm, sel: Math.min(Math.max(0, fm.entries.length - 1), fm.sel + 1) }); return; }
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

    /* —— 会话输入态（N/M/U 触发；T1：IME 整词上屏 + 左右方向键移动光标）—— */
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
        } else if (cur === 'pageImport') {
          importPageFile(p);
        } else {
          importConfig(p);
        }
      } else {
        const e = editInput(draft, cursor, input, key);
        if (e.text !== draft || e.cursor !== cursor) setEd(e);
      }
      return;
    }

    /* —— 全局动作键（任意视图）—— */
    if (input === 'q') { exit(); return; }
    if (input === 'o' || input === 'O') { enterFm(); return; }
    if (input === 'n' || input === 'N') { setEd({ text: 'project.uragan', cursor: 'project.uragan'.length }); setSession('new'); return; }
    if (input === 'm' || input === 'M') { setEd({ text: 'config.json', cursor: 'config.json'.length }); setSession('import'); return; }
    if (input === 'u' || input === 'U') { setEd({ text: 'page.json', cursor: 'page.json'.length }); setSession('pageImport'); return; }
    if (input === 'x' || input === 'X') { closeProject(); return; }
    if (input === 'e' || input === 'E') { exportConfig(); return; }
    if (input === 'v' || input === 'V') { runValidate(); return; }
    if (input === 't' || input === 'T') { runAssetsCheck(); return; }
    if (input === 's' || input === 'S') { exportSkeletons(s.file, projectDir()); setState({ ...s, toast: '已导出文案框架：skeleton.json / skeleton.md' }); return; }
    if (input === 'i' || input === 'I') {
      importSkeletons(s.file, projectDir(), s.projectPath, ({ toast, file }) => setState({ ...s, ...(file ? { file } : {}), toast }));
      return;
    }
    if (input === 'r' || input === 'R') {
      if (rendering) return; // 渲染中防重入；完成后 rendering 复位，可再次渲染
      setRendering(true);
      setRes({ progress: 0, message: '渲染启动…' });
      const mark = ++renderSeq;
      const pdir = projectDir();
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
            setState((cur) => (cur ? { ...cur, toast: `渲染完成，${r.durationSeconds.toFixed(1)}s` } : cur));
          }
        } catch (e) {
          if (mark === renderSeq) {
            setRes({ progress: 0, message: '' });
            setState((cur) => (cur ? { ...cur, toast: `渲染失败：${(e as Error).message}` } : cur));
          }
        } finally {
          if (mark === renderSeq) setRendering(false);
        }
      })();
      return;
    }

    /* —— 字段编辑态（T1：IME 整词 + 方向键光标；数字 1-5 作为内容输入，不切视图）—— */
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

    /* —— 视图切换 —— */
    const v = VIEW_KEYS[input];
    if (v) { setState({ ...s, view: v, sub: 'pages', itemIndex: 0 }); return; }

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
      if (key.leftArrow || input === 'h') { const f2 = moveUp(s.file, s.pageIndex); if (f2 !== s.file) save(f2, `上移：${f2.pages[s.pageIndex]?.name ?? ''}`); return; }
      if (key.rightArrow || input === 'l') { const f3 = moveDown(s.file, s.pageIndex); if (f3 !== s.file) save(f3, `下移：${f3.pages[s.pageIndex]?.name ?? ''}`); return; }
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

  return (
    <Box flexDirection="column" width="100%">
      {/* 头部：品牌 + 工程 + 校验徽章（背景块） */}
      <Box backgroundColor={P.panel} paddingX={2} paddingY={0}>
        <Text bold color={P.cyan}>◆ UraGAN</Text>
        <Text color={P.mute}>  </Text>
        <Text bold color={P.text}>{file.project.name}</Text>
        <Text color={P.mute}>  {file.project.canvas.width}×{file.project.canvas.height}@{file.project.canvas.fps}</Text>
        <Box marginLeft={3}>
          <Text color={P.mute}>页 </Text>
          <Text color={P.yellow} bold>{file.pages.length}</Text>
          <Text color={P.mute}> · 全片 </Text>
          <Text color={P.green} bold>{total.toFixed(1)}s</Text>
          {report.issues.length > 0 ? (
            <Text color={report.ok ? P.green : P.red} bold> · {report.ok ? '✓ 校验通过' : `✗ ${report.issues.filter((i) => i.severity === 'error').length} 错`}</Text>
          ) : null}
        </Box>
      </Box>

      {/* 视图页签（flexWrap：窄屏自动折行） */}
      <Box marginTop={1} flexDirection="row" flexWrap="wrap">
        {(Object.keys(VIEW_LABEL) as View[]).map((v) => {
          const active = state.view === v;
          return (
            <Box key={v} marginRight={1} marginY={0} paddingX={1} backgroundColor={active ? P.panelActive : P.panel}>
              <Text color={active ? '#ffffff' : P.mute} bold={active}>{VIEW_LABEL[v]}</Text>
              <Text color={active ? '#ffffff' : P.mute}>[{v === 'pages' ? '1' : v === 'shared' ? '2' : v === 'components' ? '3' : v === 'assets' ? '4' : '5'}]</Text>
            </Box>
          );
        })}
      </Box>

      {/* 主体 */}
      <Box marginTop={1} flexGrow={1}>
        {session === 'fm' && fm ? (
          <FmView cwd={fm.cwd} entries={fm.entries} sel={fm.sel} />
        ) : state.view === 'pages' ? (
          <PageView state={state} setState={setState} page={page} pages={pages} draft={draft} cursor={cursor} />
        ) : state.view === 'shared' ? (
          <SharedView state={state} />
        ) : state.view === 'components' ? (
          <ComponentsView state={state} hasPages={hasPages} />
        ) : state.view === 'assets' ? (
          <AssetsView state={state} issues={assetIssues} ok={assetOk} />
        ) : (
          <InfoView state={state} issues={report.issues} ok={report.ok} />
        )}
      </Box>

      {/* 进度 + 状态 */}
      <Box marginTop={1} flexDirection="column">
        {res.message ? (
          <Text color={P.green}>
            {'█'.repeat(Math.round(res.progress * 22))}
            {'░'.repeat(22 - Math.round(res.progress * 22))}
            <Text> </Text>
            <Text color={P.yellow}>{String(Math.round(res.progress * 100)).padStart(3)}%</Text>
            <Text color={P.mute}>  {res.message}</Text>
          </Text>
        ) : null}
        {session && session !== 'fm' ? (
          <Box flexDirection="row" flexWrap="wrap">
            <Text color={P.amber} bold>{session === 'new' ? '新建工程' : session === 'pageImport' ? '导入单页文件' : '导入配置'}：</Text>
            <Text color={P.text}>{draft.slice(0, cursor)}<Text color={P.green} bold>▏</Text>{draft.slice(cursor)}</Text>
            <Text color={P.mute}>  Enter 确认 · Esc 取消 · ←→ 移光标 · Backspace 删除</Text>
          </Box>
        ) : null}
        <Box flexDirection="row" flexWrap="wrap">
          {state.toast ? (
            <Text color={P.amber}>◇ {state.toast}</Text>
          ) : (
            <>
              <Text color={P.mute}>按键 1-5 切换视图；</Text>
              <Text color={P.mute}>S 导出文案框架 · </Text>
              <Text color={P.mute}>I 导入文案 · </Text>
              <Text color={P.mute}>R 渲染视频 · </Text>
              <Text color={P.mute}>E 导出整体配置 · </Text>
              <Text color={P.mute}>M 导入配置 · </Text>
              <Text color={P.mute}>V 校验 · </Text>
              <Text color={P.mute}>T 资产体检</Text>
            </>
          )}
        </Box>
      </Box>

      {/* 快捷键栏（背景块；flexWrap 保证窄屏自动折行，键位不丢） */}
      <Box marginTop={1} backgroundColor={P.panel} paddingX={2} flexDirection="row" flexWrap="wrap">
        {state.view === 'pages' ? (
          <>
            <Key k="↑↓" t="选择页面" color={P.text} />
            <Key k="←→" t="移动顺序" color={P.text} />
            <Key k="Enter" t="进入字段" color={P.text} />
            <Key k="G" t="导出单页文件" color={P.green} />
            <Key k="U" t="导入单页文件" color={P.green} />
          </>
        ) : state.view === 'components' ? (
          <>
            <Key k="↑↓" t="选择组件" color={P.text} />
            <Key k="Enter" t="内联到当前页" color={P.text} />
          </>
        ) : state.view === 'shared' ? (
          <Key k="↑↓" t="浏览共享定义" color={P.text} />
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

/* ---------------- 视图子组件 ---------------- */

function Panel({ title, children, active }: { title: string; children: React.ReactNode; active: boolean }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={0} backgroundColor={active ? P.panelActive : P.panel} flexShrink={0}>
      <Text bold color={active ? '#ffffff' : P.text}>{clip(title, 44)}</Text>
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
}): React.ReactElement {
  const { state, setState, page, pages, draft, cursor } = props;
  const onPages = state.sub === 'pages';
  const onFields = state.sub === 'fields' || state.sub === 'edit';
  const fields = fieldsOfPage(page);

  return (
    <Box flexDirection="row" width="100%">
      <Panel title={`页面 · 播放顺序  ${onPages ? '●' : ''}`} active={onPages}>
        <Box width={30} flexDirection="column">
          {pages.length === 0 ? (
            <Text color={P.mute}>（无页面，O 打开 / N 新建）</Text>
          ) : (
            pages.map(({ index, page: p, duration }) => {
              const active = index === state.pageIndex && onPages;
              const kindColor = KIND_COLOR[p.kind] ?? P.mute;
              return (
                <Box key={p.pageId} paddingY={0} backgroundColor={active ? P.panelActive : undefined} width="100%">
                  <Text color={active ? 'white' : P.mute}>{active ? '▶ ' : '  '}{String(index + 1).padStart(2, '0')} </Text>
                  <Text color={active ? 'white' : P.text} bold>{clip(p.name, 9)}</Text>
                  <Text color={kindColor} bold> {KIND_TAG[p.kind] ?? p.kind}</Text>
                  <Box justifyContent="flex-end" flexGrow={1}>
                    <Text color={active ? 'white' : P.mute}>{duration.toFixed(1)}s</Text>
                  </Box>
                </Box>
              );
            })
          )}
        </Box>
      </Panel>

      <Box flexGrow={1} marginLeft={1}>
        <Panel title={`详情：${page?.name ?? '—'}${page ? ` · ${KIND_TAG[page.kind] ?? page.kind}` : ''}  ${onFields ? '●' : ''}`} active={onFields}>
          {page ? (
            <Box flexDirection="column">
              {fields.map((f, i) => {
                const focus = onFields && i === state.fieldIndex;
                const editing = state.sub === 'edit' && i === state.fieldIndex;
                const kind = fieldKind(f.field);
                const kindColor = kind === 'number' ? P.yellow : kind === 'boolean' ? P.cyan : kind === 'asset' ? P.pink : P.mute;
                return (
                  <Box key={f.name} width="100%">
                    <Box width={17} paddingX={1} backgroundColor={focus ? P.panelActive : undefined}>
                      <Text color={focus ? 'white' : P.mute}>{focus ? (editing ? '✎ ' : '❯ ') : '  '}{clip(f.name, 12)}</Text>
                    </Box>
                    <Box width={7} backgroundColor={focus ? P.panelActive : undefined}>
                      <Text color={kindColor} bold>{kind}</Text>
                    </Box>
                    <Box flexGrow={1} backgroundColor={focus ? P.panelActive : undefined} paddingRight={1}>
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
              <Box marginTop={1}>
                <Text color={P.mute}>⚡ 动画：</Text>
                <Text color={P.amber}>
                  {page.animations.length > 0
                    ? page.animations.map((a) => `${a.effect}@${(a.delay ?? 0).toFixed(1)}s+${(a.duration ?? 0.8).toFixed(1)}s`).join(' · ')
                    : '（无）'}
                </Text>
              </Box>
            </Box>
          ) : (
            <Text color={P.mute}>（未打开工程）</Text>
          )}
        </Panel>
      </Box>
    </Box>
  );
}

/** 文件管理器视图（T5：浏览目录 + 打开工程；仅展示目录与可开工程条目） */
function FmView({ cwd, entries, sel }: { cwd: string; entries: FmEntry[]; sel: number }): React.ReactElement {
  return (
    <Box flexDirection="column" width="100%">
      <Panel title={`文件管理器 · 打开工程（${cwd}）`} active>
        <Box flexDirection="column">
          {entries.length === 0 ? <Text color={P.mute}>（空目录）</Text> : null}
          {entries.map((e, i) => {
            const active = i === sel;
            return (
              <Box key={e.name} paddingY={0} backgroundColor={active ? P.panelActive : undefined} width="100%">
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
        </Box>
      </Panel>
      <Box marginY={1}>
        <Text color={P.mute}>↑↓ 选择 · Enter 进入/打开 · Backspace 上级 · Esc 关闭（位置已记忆，下次从这开始）</Text>
      </Box>
    </Box>
  );
}

function SharedView({ state }: { state: TuiSnapshot }): React.ReactElement {
  const { config } = Uragan.exportConfig(state.file);
  const keys = Object.keys(config.$shared);
  const sel = state.itemIndex;
  const selKey = keys[sel];
  return (
    <Box flexDirection="row" width="100%">
      <Panel title={`共享池 $shared（${keys.length} 项）`} active>
        <Box width={30} flexDirection="column">
          {keys.length === 0 ? (
            <Text color={P.mute}>（空，导出时自动去重生成）</Text>
          ) : (
            keys.map((k, i) => (
              <Box key={k} paddingY={0} backgroundColor={i === sel ? P.panelActive : undefined} width="100%">
                <Text color={i === sel ? 'white' : P.text}>{i === sel ? '❯ ' : '  '}{clip(k, 24)}</Text>
              </Box>
            ))
          )}
        </Box>
      </Panel>
      <Box flexGrow={1} marginLeft={1}>
        <Panel title={`定义详情${selKey ? ` · ${selKey}` : ''}`} active>
          {selKey ? (
            <Box flexDirection="column" paddingX={1}>
              <Text color={P.text}>类型：<Text bold color={P.cyan}>{String(config.$shared[selKey]!.type)}</Text></Text>
              <Text color={P.text}>值：<Text color={P.yellow}>{defSummary(config.$shared[selKey])}</Text></Text>
              <Box marginTop={1}>
                <Text color={P.mute}>被 {keys.filter((k) => k === selKey).length} 个定义共享（去重后）</Text>
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

function ComponentsView({ state, hasPages }: { state: TuiSnapshot; hasPages: boolean }): React.ReactElement {
  const comps = state.file.components ?? [];
  const sel = state.itemIndex;
  const comp = comps[sel];
  return (
    <Box flexDirection="row" width="100%">
      <Panel title={`组件（${comps.length}）`} active>
        <Box width={30} flexDirection="column">
          {comps.length === 0 ? (
            <Text color={P.mute}>（无组件）</Text>
          ) : (
            comps.map((c, i) => (
              <Box key={c.componentId} paddingY={0} backgroundColor={i === sel ? P.panelActive : undefined} width="100%">
                <Text color={i === sel ? 'white' : P.text}>{i === sel ? '❯ ' : '  '}{clip(c.componentId, 14)}</Text>
                <Text color={i === sel ? 'white' : P.mute}> {clip(c.name, 10)}</Text>
              </Box>
            ))
          )}
        </Box>
      </Panel>
      <Box flexGrow={1} marginLeft={1}>
        <Panel title={`组件详情${comp ? ` · ${comp.componentId}` : ''}`} active>
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

function AssetsView({ state, issues, ok }: { state: TuiSnapshot; issues: Issue[]; ok: boolean }): React.ReactElement {
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
  return (
    <Box flexDirection="row" width="100%">
      <Panel title={`资产引用（${refs.length}）· T 体检`} active>
        <Box width={30} flexDirection="column">
          {refs.length === 0 ? (
            <Text color={P.mute}>（无资产引用）</Text>
          ) : (
            refs.slice(0, 14).map((r, i) => (
              <Text key={i} color={P.mute}>  {clip(r.src, 26)}</Text>
            ))
          )}
          {refs.length > 14 ? <Text color={P.mute}>  …（共 {refs.length} 条）</Text> : null}
        </Box>
      </Panel>
      <Box flexGrow={1} marginLeft={1}>
        <Panel title="资产体检" active>
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

function InfoView({ state, issues, ok }: { state: TuiSnapshot; issues: Issue[]; ok: boolean }): React.ReactElement {
  const file = state.file;
  const stats = file.pages.map((p) => ({ p, ...pageStats(p) }));
  const comps = file.components?.length ?? 0;
  return (
    <Box flexDirection="row" width="100%">
      <Panel title="工程信息" active>
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
        <Panel title={`每页统计 · 校验 ${ok ? '通过' : '有错'}（V 重新校验）`} active>
          <Box flexDirection="column" paddingX={1}>
            {stats.map(({ p, fields, copy, animations }) => (
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

/** 快捷键项：键帽（深底 + 分类色）+ 完整说明；窄屏随容器换行 */
function Key({ k, t, color = P.yellow }: { k: string; t: string; color?: string }): React.ReactElement {
  return (
    <Box marginRight={1} marginY={0}>
      <Box backgroundColor="#0b1220" paddingX={1}>
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