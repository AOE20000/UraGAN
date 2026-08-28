import React from 'react';
import { Composition, Sequence } from 'remotion';
import type { RenderedProject } from '../types.js';
import { SceneView } from './sceneRenderer.js';

export const COMPOSITION_ID = 'UraGAN';

/** 整片：按 pages 顺序铺排（Sequence from 累加），每页一个视图 */
export const UraGANVideo: React.FC<{ scenes: RenderedProject }> = ({ scenes }) => {
  let at = 0;
  return (
    <>
      {scenes.pages.map((p) => {
        const frames = Math.max(1, Math.round(p.duration * scenes.canvas.fps));
        const { pageId, root, animations, duration } = p;
        void duration;
        const seq = (
          <Sequence key={pageId} from={at} durationInFrames={frames}>
            <SceneView root={root} animations={animations} />
          </Sequence>
        );
        at += frames;
        return seq;
      })}
    </>
  );
};

/** Remotion 根：注册合成。画布/时长由 inputProps（translateProject 输出）经 calculateMetadata 推导。 */
export const Root: React.FC = () => (
  <>
    <Composition
      id={COMPOSITION_ID}
      component={UraGANVideo}
      // 占位参数；真实值由 calculateMetadata 依据 scenes 推导
      durationInFrames={1}
      fps={30}
      width={1280}
      height={720}
      calculateMetadata={({ props }) => {
        const scenes = props.scenes as RenderedProject;
        if (!scenes || !scenes.canvas) {
          throw new Error('缺少 inputProps.scenes（应由 translateProject 生成的 RenderedProject）');
        }
        return {
          fps: scenes.canvas.fps,
          width: scenes.canvas.width,
          height: scenes.canvas.height,
          durationInFrames: Math.max(1, Math.ceil(scenes.totalDuration * scenes.canvas.fps)),
        };
      }}
      defaultProps={{ scenes: undefined as unknown as RenderedProject }}
    />
  </>
);