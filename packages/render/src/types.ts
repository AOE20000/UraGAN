/** 场景图类型：翻译层输出（纯 TS，无 React/Remotion 依赖，可单测） */

export interface SceneStyle {
  color?: string;
  backgroundColor?: string;
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
  textAlign?: 'left' | 'center' | 'right';
  padding?: number;
  borderRadius?: number;
  gap?: number;
  /** 'auto' | 绝对像素 | 百分比字符串 */
  width?: 'auto' | number | string;
  maxWidth?: number;
  opacity?: number;
}

export type SceneNode =
  | { type: 'box'; id?: string; style: SceneStyle; children: SceneNode[] }
  | { type: 'text'; id?: string; text: string; style: SceneStyle }
  | { type: 'image'; id?: string; src: string; style: SceneStyle };

export interface SceneAnimation {
  /** 动画目标：内容节点 cid */
  target: string;
  effect: string;
  delay: number;
  duration: number;
  ease: string;
}

export interface PageScene {
  pageId: string;
  name: string;
  kind: string;
  /** 时长（秒）：in + hold + out */
  duration: number;
  root: SceneNode;
  animations: SceneAnimation[];
}

export interface RenderedProject {
  schemaVersion: string;
  projectId: string;
  projectName: string;
  canvas: { width: number; height: number; fps: number };
  /** 全片时长（秒）＝ 各页顺序之和 */
  totalDuration: number;
  pages: PageScene[];
}

export interface TranslateOptions {
  /** 工程文件所在目录：相对路径资产以此解析（缺省用 cwd） */
  projectDir?: string;
  /** 资产引用映射钩子：http(s) 留原样 / 相对路径解析为绝对路径；默认恒等 */
  assetMapper?: (src: string) => string;
}