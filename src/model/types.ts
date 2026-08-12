/**
 * 数据模型类型的统一入口。
 *
 * 类型全部由 `schema.ts` 通过 `z.infer` 推导，本文件只做 re-export，避免双维护。
 * 需要 zod schema 本身（校验、解析）时请直接从 `./schema` 导入。
 */
export type {
  Pt,
  Underlay,
  Wall,
  OpeningType,
  OpeningSwing,
  Opening,
  StructureKind,
  Structure,
  FloorType,
  Room,
  FurnitureCategory,
  Furniture,
  DimensionAnnotation,
  TextAnnotation,
  Annotation,
  PlanMeta,
  PlanDoc,
  RecognitionResult,
} from './schema';
