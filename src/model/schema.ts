/**
 * house-planner 单一数据模型的 zod schema。
 *
 * 约定（见 docs/ARCHITECTURE.md 第 1、2 节）：
 * - 所有长度、坐标单位一律为 **mm，整数**；x 向右、y 向下。
 * - 角度单位为 **度**，允许小数。
 * - 本文件是类型的唯一来源，`src/model/types.ts` 只做 `z.infer` 的 re-export。
 */
import { z } from 'zod';

/** mm 标量：有限整数 */
const Mm = z.number().finite().int();
/** 正的 mm 标量（宽/深/长等） */
const MmPositive = z.number().finite().int().positive();
/** 角度（度），允许小数 */
const Deg = z.number().finite();

// ---------------------------------------------------------------------------
// 基础
// ---------------------------------------------------------------------------

export const PtSchema = z.object({
  x: Mm,
  y: Mm,
});

// ---------------------------------------------------------------------------
// 底图（Milestone 2 实现，schema 先定义）
// ---------------------------------------------------------------------------

export const UnderlaySchema = z.object({
  imageDataUrl: z.string(),
  /** 0..1 */
  opacity: z.number().min(0).max(1),
  /** 比例标定结果：底图 1px 对应多少 mm */
  mmPerPixel: z.number().finite().positive(),
  offset: PtSchema,
  rotation: Deg,
  locked: z.boolean(),
});

// ---------------------------------------------------------------------------
// 墙
// ---------------------------------------------------------------------------

/** v1 无厚度概念：渲染固定视觉宽度 WALL_VISUAL_WIDTH = 100mm */
export const WallSchema = z.object({
  id: z.string(),
  /** 中心线起点 */
  start: PtSchema,
  /** 中心线终点 */
  end: PtSchema,
});

// ---------------------------------------------------------------------------
// 开口（门 / 引き戸 / 窗 / 无门垂壁开口）
// ---------------------------------------------------------------------------

export const OpeningTypeSchema = z.enum(['door', 'sliding_door', 'window', 'opening']);

export const OpeningSwingSchema = z.enum(['in_left', 'in_right', 'out_left', 'out_right']);

export const OpeningSchema = z.object({
  id: z.string(),
  wallId: z.string(),
  type: OpeningTypeSchema,
  /** 沿墙从 start 起算，到洞口中心的距离 mm */
  offset: Mm,
  width: MmPositive,
  /** 仅 type === 'door' 有意义 */
  swing: OpeningSwingSchema.optional(),
});

// ---------------------------------------------------------------------------
// 结构（柱 + 梁）
// ---------------------------------------------------------------------------

export const StructureKindSchema = z.enum(['column', 'beam']);

export const StructureSchema = z.object({
  id: z.string(),
  kind: StructureKindSchema,
  /** 矩形中心 */
  position: PtSchema,
  width: MmPositive,
  depth: MmPositive,
  rotation: Deg,
});

// ---------------------------------------------------------------------------
// 房间
// ---------------------------------------------------------------------------

export const FloorTypeSchema = z.enum(['flooring', 'tatami', 'tile', 'other']);

export const RoomSchema = z.object({
  id: z.string(),
  /** LDK / 洋室 / 和室 … */
  name: z.string(),
  polygon: z.array(PtSchema),
  floor: FloorTypeSchema,
});

// ---------------------------------------------------------------------------
// 家具
// ---------------------------------------------------------------------------

export const FurnitureCategorySchema = z.enum([
  'bed',
  'table',
  'seating',
  'storage',
  'appliance',
  'other',
]);

export const FurnitureSchema = z.object({
  id: z.string(),
  /** null = 自定义尺寸，不来自家具库 */
  catalogId: z.string().nullable(),
  name: z.string(),
  /** 俯视 w×d，mm */
  size: z.object({ w: MmPositive, d: MmPositive }),
  /** 中心 */
  position: PtSchema,
  rotation: Deg,
  /** CSS 颜色字符串 */
  color: z.string(),
  locked: z.boolean(),
});

// ---------------------------------------------------------------------------
// 标注
// ---------------------------------------------------------------------------

export const DimensionAnnotationSchema = z.object({
  id: z.string(),
  type: z.literal('dimension'),
  from: PtSchema,
  to: PtSchema,
  /** 尺寸线相对被标注线段的法向偏移 mm，可为负 */
  offsetDistance: Mm,
});

export const TextAnnotationSchema = z.object({
  id: z.string(),
  type: z.literal('text'),
  position: PtSchema,
  text: z.string(),
});

export const AnnotationSchema = z.discriminatedUnion('type', [
  DimensionAnnotationSchema,
  TextAnnotationSchema,
]);

// ---------------------------------------------------------------------------
// 文档
// ---------------------------------------------------------------------------

export const PlanMetaSchema = z.object({
  name: z.string(),
  /** 模数网格边长 mm，默认 910 */
  gridSize: MmPositive,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const PlanDocSchema = z.object({
  version: z.literal(1),
  meta: PlanMetaSchema,
  underlay: UnderlaySchema.nullable(),
  walls: z.array(WallSchema),
  openings: z.array(OpeningSchema),
  structures: z.array(StructureSchema),
  rooms: z.array(RoomSchema),
  furniture: z.array(FurnitureSchema),
  annotations: z.array(AnnotationSchema),
});

/**
 * AI 识别输出 = Pick<PlanDoc, 'walls'|'openings'|'structures'|'rooms'>
 * （Milestone 3；且 structures 只出 column）
 */
export const RecognitionResultSchema = PlanDocSchema.pick({
  walls: true,
  openings: true,
  structures: true,
  rooms: true,
});

// ---------------------------------------------------------------------------
// 推导类型
// ---------------------------------------------------------------------------

export type Pt = z.infer<typeof PtSchema>;
export type Underlay = z.infer<typeof UnderlaySchema>;
export type Wall = z.infer<typeof WallSchema>;
export type OpeningType = z.infer<typeof OpeningTypeSchema>;
export type OpeningSwing = z.infer<typeof OpeningSwingSchema>;
export type Opening = z.infer<typeof OpeningSchema>;
export type StructureKind = z.infer<typeof StructureKindSchema>;
export type Structure = z.infer<typeof StructureSchema>;
export type FloorType = z.infer<typeof FloorTypeSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type FurnitureCategory = z.infer<typeof FurnitureCategorySchema>;
export type Furniture = z.infer<typeof FurnitureSchema>;
export type DimensionAnnotation = z.infer<typeof DimensionAnnotationSchema>;
export type TextAnnotation = z.infer<typeof TextAnnotationSchema>;
export type Annotation = z.infer<typeof AnnotationSchema>;
export type PlanMeta = z.infer<typeof PlanMetaSchema>;
export type PlanDoc = z.infer<typeof PlanDocSchema>;
export type RecognitionResult = z.infer<typeof RecognitionResultSchema>;
