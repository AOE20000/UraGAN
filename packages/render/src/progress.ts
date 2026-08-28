/** 渲染进度纯函数：由帧计数映射 0-1 进度（供 TUI/CLI 进度条复用，可单测） */
export function progressFromFrames(p: {
  renderedFrames?: number;
  encodedFrames?: number;
  totalFrames?: number;
}): number {
  const total = p.totalFrames ?? 0;
  if (total <= 0) return 0;
  const done = Math.max(p.renderedFrames ?? 0, p.encodedFrames ?? 0);
  return Math.min(1, done / total);
}