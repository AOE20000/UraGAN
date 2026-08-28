import type { Page, ProjectFile } from '@uragan/shared';
import { DEFAULT_PAGE_DURATION } from '@uragan/shared';

/** 页进出场动画默认时长（秒） */
export const INTRO_DURATION = 0.8;
export const OUTRO_DURATION = 0.8;

/**
 * 每页时长（设计文档 §6）＝ in(0.8s) + hold + out(0.8s)。
 * hold 取 页级 duration → project.defaults.pageDuration → 全局默认(2.5s)；
 * 若该页 animations 的 max 边界（delay+duration）超过 hold，则延长 hold 容纳动画。
 */
export function pageDuration(page: Page, project: ProjectFile['project']): number {
  const holdBase = page.duration ?? project.defaults?.pageDuration ?? DEFAULT_PAGE_DURATION;
  const animEnd = page.animations.reduce((m, a) => Math.max(m, (a.delay ?? 0) + (a.duration ?? 0.8)), 0);
  const hold = Math.max(holdBase, animEnd);
  return INTRO_DURATION + hold + OUTRO_DURATION;
}

/** 全片时长 = 各页播放时长之和（pages 数组顺序 = 播放顺序） */
export function totalDuration(file: ProjectFile): number {
  return file.pages.reduce((s, p) => s + pageDuration(p, file.project), 0);
}