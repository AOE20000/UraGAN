import React from 'react';
import { AbsoluteFill, Easing, useCurrentFrame, useVideoConfig } from 'remotion';
import type { SceneAnimation, SceneNode, SceneStyle } from '../types.js';

const styleToCss = (s: SceneStyle): React.CSSProperties => ({
  color: s.color,
  backgroundColor: s.backgroundColor,
  fontSize: s.fontSize,
  fontWeight: s.fontWeight,
  fontFamily: s.fontFamily,
  textAlign: s.textAlign,
  padding: s.padding,
  borderRadius: s.borderRadius,
  gap: s.gap,
  width: s.width === 'auto' ? undefined : s.width,
  maxWidth: s.maxWidth,
  opacity: s.opacity,
});

/** ease 枚举 → Remotion Easing（设计文档 §6） */
const easeToFn: Record<string, (p: number) => number> = {
  linear: Easing.linear,
  easeIn: Easing.in(Easing.cubic),
  easeOut: Easing.out(Easing.cubic),
  easeInOut: Easing.inOut(Easing.cubic),
};

function clamp(p: number): number {
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

interface Motion {
  opacity: number;
  y: number;
  x: number;
  scale: number;
}

const NO_MOTION: Motion = { opacity: 1, y: 0, x: 0, scale: 1 };

/**
 * 节点动画结算：给定 clip 与「本地帧」（已减去页面起点），返回该帧的视觉状态。
 * effect 词汇：fadeIn / fadeUp / fadeDown / fadeLeft / fadeRight / scaleIn / float。
 */
export function motionAt(clip: SceneAnimation | undefined, localFrame: number, fps: number): Motion {
  if (!clip) return NO_MOTION;
  const delayF = Math.round(clip.delay * fps);
  const durF = Math.max(1, Math.round(clip.duration * fps));
  const p = clamp((localFrame - delayF) / durF);
  if (clip.effect === 'float') {
    const wave = Math.sin(((localFrame - delayF) / fps) * Math.PI * 2) * 0.5 + 0.5;
    return { opacity: wave > 0.2 ? 1 : wave * 5, y: (wave - 0.5) * 28, x: 0, scale: 1 };
  }
  if (p <= 0) return { opacity: 0, y: 24, x: 0, scale: 0.9 };
  if (p >= 1) return NO_MOTION;
  const easing = easeToFn[clip.ease] ?? easeToFn.easeOut!;
  const q = easing(p);
  switch (clip.effect) {
    case 'fadeIn':
      return { opacity: q, y: 0, x: 0, scale: 1 };
    case 'fadeDown':
      return { opacity: q, y: (1 - q) * -32, x: 0, scale: 1 };
    case 'fadeLeft':
      return { opacity: q, y: 0, x: (1 - q) * 48, scale: 1 };
    case 'fadeRight':
      return { opacity: q, y: 0, x: (1 - q) * -48, scale: 1 };
    case 'scaleIn':
      return { opacity: q, y: 0, x: 0, scale: 0.8 + 0.2 * q };
    default:
      return { opacity: q, y: (1 - q) * 32, x: 0, scale: 1 };
  }
}

function Node({ node, animations }: { node: SceneNode; animations: SceneAnimation[] }): React.ReactElement {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const clip = node.id ? animations.find((a) => a.target === node.id) : undefined;
  const motion = clip ? motionAt(clip, frame, fps) : NO_MOTION;

  const base: React.CSSProperties = styleToCss(node.style);

  switch (node.type) {
    case 'text':
    case 'image':
      return (
        <div
          style={{
            ...base,
            opacity: (node.style.opacity ?? 1) * motion.opacity,
            transform: `translate3d(${motion.x}px, ${motion.y}px, 0) scale(${motion.scale})`,
            lineHeight: 1.2,
          }}
        >
          {node.type === 'text' ? node.text : <img src={node.src} alt="" style={{ display: 'block', width: '100%', height: 'auto', borderRadius: base.borderRadius }} />}
        </div>
      );
    case 'box':
      return (
        <div
          style={{
            ...base,
            opacity: (node.style.opacity ?? 1) * motion.opacity,
            transform: `translate3d(${motion.x}px, ${motion.y}px, 0) scale(${motion.scale})`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            width: base.width ?? 'auto',
            maxWidth: base.maxWidth,
          }}
        >
          {node.children.map((c, i) => (
            <Node key={c.id ?? i} node={c} animations={animations} />
          ))}
        </div>
      );
  }
}

/** 单页场景 → 全屏视图（页面动画含 spring 示例：根节点 fadeUp） */
export function SceneView({ root, animations }: { root: SceneNode; animations: SceneAnimation[] }): React.ReactElement {
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', fontFamily: 'system-ui, sans-serif', backgroundColor: '#0f172a' }}>
      <Node node={root} animations={animations} />
    </AbsoluteFill>
  );
}