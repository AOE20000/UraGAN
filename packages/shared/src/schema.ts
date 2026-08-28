import { z } from 'zod';
import { REF_PREFIX, SCHEMA_VERSION, SKELETON_KIND } from './constants.js';

/* ------------------------------------------------------------------ */
/* 基础标量                                                             */
/* ------------------------------------------------------------------ */

export const EaseZ = z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut']);

export const RefZ = z.string().refine((v) => v.startsWith(REF_PREFIX) && v.length > REF_PREFIX.length, {
  message: `ref 必须以 "${REF_PREFIX}" 开头并指向一个定义键`,
});

/* ------------------------------------------------------------------ */
/* 定义（Definition）                                                  */
/* ------------------------------------------------------------------ */

export const AssetDefZ = z.object({
  type: z.literal('asset'),
  kind: z.enum(['image', 'font', 'audio', 'video']),
  /** http(s) URL 或相对工程文件的本地路径（素材/字体不入包，只存引用） */
  src: z.string().min(1),
});
export type AssetDef = z.infer<typeof AssetDefZ>;

export const ColorDefZ = z.object({ type: z.literal('color'), value: z.string().min(1) });
export type ColorDef = z.infer<typeof ColorDefZ>;

export const FontDefZ = z.object({
  type: z.literal('font'),
  family: z.string().min(1),
  weight: z.number().int().min(100).max(900).optional(),
  /** 可省略：无 src 时退化为系统字体兜底 */
  src: z.string().optional(),
});
export type FontDef = z.infer<typeof FontDefZ>;

export const SpacingDefZ = z.object({ type: z.literal('spacing'), value: z.number() });
export type SpacingDef = z.infer<typeof SpacingDefZ>;

export const RadiusDefZ = z.object({ type: z.literal('radius'), value: z.number().min(0) });
export type RadiusDef = z.infer<typeof RadiusDefZ>;

export const AnimationDefZ = z.object({
  type: z.literal('animation'),
  effect: z.string().min(1),
  duration: z.number().gt(0).optional(),
  ease: EaseZ.optional(),
});
export type AnimationDef = z.infer<typeof AnimationDefZ>;

export const TextStyleDefZ = z.object({
  type: z.literal('text_style'),
  font: z.string().optional(),
  size: z.number().gt(0).optional(),
  color: z.string().optional(),
  weight: z.number().int().min(100).max(900).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
});
export type TextStyleDef = z.infer<typeof TextStyleDefZ>;

/** 定义联合：必须带明确的 type 判别字段 */
export const DefZ = z.discriminatedUnion('type', [
  AssetDefZ,
  ColorDefZ,
  FontDefZ,
  SpacingDefZ,
  RadiusDefZ,
  AnimationDefZ,
  TextStyleDefZ,
]);
export type Def = z.infer<typeof DefZ>;

/** 定义集合：key 需为合法标识符（导入/覆盖时校验单页内唯一） */
const DefKeyZ = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, '定义 key 需以字母开头，仅含字母/数字/下划线');
export const DefsZ = z.record(DefKeyZ, DefZ);
export type Defs = z.infer<typeof DefsZ>;

/* ------------------------------------------------------------------ */
/* 内容节点（ContentField）与动画                                        */
/* ------------------------------------------------------------------ */

/**
 * 内容字段。设计/内容解耦的核心：
 * - cid：稳定节点 ID，占位符/动画一律用 cid 寻址（绝不用数组下标）
 * - copy：true 表示该字段是可填充文案（由 schema 声明，直接驱动 copy skeleton）
 * - ref：引用本地定义（ref = "defs/<key>"），内容值可留空交给 AI/用户填充
 */
export const ContentFieldZ = z
  .object({
    cid: z.string().min(1).optional(),
    label: z.string().optional(),
    copy: z.boolean().optional(),
    placeholder: z.string().optional(),
    ref: RefZ.optional(),
    kind: z.enum(['text', 'number', 'color', 'boolean', 'asset']).optional(),
    /** 内容值：文本/数字/布尔由 applySkeleton 精细校验；对象形态（如内联组件代码）放行给 render */
    value: z.unknown().optional(),
  })
  .passthrough(); // 保留 kind 专属数据字段（如 asset 的 src），由 render 翻译器读取

export type ContentField = z.infer<typeof ContentFieldZ>;

export const ContentZ = z.record(z.string(), ContentFieldZ);
export type Content = z.infer<typeof ContentZ>;

export const AnimationZ = z.object({
  /** 动画作用目标：内容节点 cid */
  target: z.string().min(1),
  effect: z.string().min(1),
  delay: z.number().gte(0).optional(),
  duration: z.number().gt(0).optional(),
  ease: EaseZ.optional(),
});
export type Animation = z.infer<typeof AnimationZ>;

/* ------------------------------------------------------------------ */
/* 工程 / 页面 / 组件                                                   */
/* ------------------------------------------------------------------ */

export const CanvasZ = z.object({
  width: z.number().int().gt(0),
  height: z.number().int().gt(0),
  fps: z.number().int().gt(0),
});
export type Canvas = z.infer<typeof CanvasZ>;

export const ProjectMetaZ = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  canvas: CanvasZ,
  defaults: z.object({ pageDuration: z.number().gt(0) }).optional(),
});
export type ProjectMeta = z.infer<typeof ProjectMetaZ>;

export const PageIdZ = z.string().regex(/^[a-zA-Z][\w-]*$/, 'pageId 需以字母开头，仅含字母/数字/下划线/连字符');

/** 页面（展开形：工程文件内每页自带 $defs，引用一律指向本地） */
export const PageZ = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).optional(),
  pageId: PageIdZ,
  name: z.string().min(1),
  /** 渲染 kind，映射到 render/translators/<kind>.tsx */
  kind: z.enum(['hero', 'section', 'grid', 'chart']),
  /** 导入展开时从 $shared 完整深拷贝全部定义，此后本页自治 */
  $defs: DefsZ,
  content: ContentZ,
  animations: z.array(AnimationZ).default([]),
  /** 页级时长覆盖（秒）；缺省由 project.defaults / 默认值推导 */
  duration: z.number().gt(0).optional(),
});
export type Page = z.infer<typeof PageZ>;

/** 交换配置中的页面：不含 $defs，ref 解析 $shared */
export const PageInputZ = PageZ.omit({ $defs: true });
export type PageInput = z.infer<typeof PageInputZ>;

export const ComponentZ = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).optional(),
  componentId: PageIdZ,
  name: z.string().min(1),
  $defs: DefsZ,
  /** 组件代码（结构化布局片段，可含 {slot.xxx} 插槽）；深度校验放校验器 */
  code: z.unknown(),
  /** 组件内可填充文案路径 */
  copy: z.array(z.string()).optional(),
});
export type Component = z.infer<typeof ComponentZ>;

/* ------------------------------------------------------------------ */
/* 两种视图：整体交换配置 / 工程文件                                     */
/* ------------------------------------------------------------------ */

/** 整体交换配置：AI 生成/接收的形态。$shared + pages 并列，页面 ref 指向 $shared。 */
export const ExchangeConfigZ = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  project: ProjectMetaZ,
  $shared: DefsZ,
  pages: z.array(PageInputZ),
});
export type ExchangeConfig = z.infer<typeof ExchangeConfigZ>;

/** 工程文件：交换配置的展开形。每页完整拷贝 $shared 定义，不再保留 $shared。 */
export const ProjectFileZ = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  project: ProjectMetaZ,
  pages: z.array(PageZ),
  components: z.array(ComponentZ).optional(),
});
export type ProjectFile = z.infer<typeof ProjectFileZ>;

/* ------------------------------------------------------------------ */
/* 文案框架（copy skeleton）                                            */
/* ------------------------------------------------------------------ */

export const CopyItemZ = z.object({
  pageId: z.string(),
  cid: z.string(),
  /** 命中的内容字段（如 "value"）；数组路径用 "a.b.c" 形式 */
  field: z.string(),
  kind: z.enum(['text', 'number', 'boolean']),
  label: z.string().optional(),
  sample: z.string().optional(),
  placeholder: z.string().optional(),
  /** AI 填回的实际值 */
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type CopyItem = z.infer<typeof CopyItemZ>;

export const CopySkeletonZ = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  kind: z.literal(SKELETON_KIND),
  pages: z.array(
    z.object({
      pageId: z.string(),
      name: z.string().optional(),
      items: z.array(CopyItemZ),
    }),
  ),
});
export type CopySkeleton = z.infer<typeof CopySkeletonZ>;

/* ------------------------------------------------------------------ */
/* 校验报告（双格式：JSON 给 MCP / 文本给 CLI）                          */
/* ------------------------------------------------------------------ */

export const IssueSeverityZ = z.enum(['error', 'warning']);
export type IssueSeverity = z.infer<typeof IssueSeverityZ>;

export const IssueZ = z.object({
  /** 错误码：U-1xxx 结构 / U-2xxx 引用 / U-3xxx 语义 / U-9xxx 文件IO */
  code: z.string(),
  severity: IssueSeverityZ,
  /** JSON Pointer 风格路径，便于定位 */
  path: z.string(),
  message: z.string(),
  hint: z.string().optional(),
});
export type Issue = z.infer<typeof IssueZ>;

export const ValidationReportZ = z.object({
  ok: z.boolean(),
  level: IssueSeverityZ,
  errors: z.array(IssueZ),
});
export type ValidationReport = z.infer<typeof ValidationReportZ>;