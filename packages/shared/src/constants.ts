/** 当前配置格式版本。schema 演进时必须实现迁移器（见设计文档 §10 M6）。 */
export const SCHEMA_VERSION = '1' as const;

/** 工程文件扩展名（单个直接可读的 JSON） */
export const PROJECT_EXT = '.uragan';

/** 定义引用前缀。ref = "defs/<key>"：交换配置解析 $shared，展开后解析本页 $defs。 */
export const REF_PREFIX = 'defs/';

/** 页面渲染 kind（对应 render/translators 下的翻译组件） */
export const PAGE_KINDS = ['hero', 'section', 'grid', 'chart'] as const;

/** copy skeleton 的文档 kind 标记 */
export const SKELETON_KIND = 'copy-skeleton' as const;

/** 每页时长默认值（秒）：in + hold + out */
export const DEFAULT_PAGE_DURATION = 2.5;

/** 定义类型枚举（v1 清单，可扩展） */
export const DEF_TYPES = [
  'color',
  'font',
  'spacing',
  'radius',
  'animation',
  'asset',
  'text_style',
] as const;