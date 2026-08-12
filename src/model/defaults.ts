/**
 * 全局常量与空文档工厂。
 * 见 docs/ARCHITECTURE.md 第 1 节（坐标系与单位）。
 */
import { nanoid } from 'nanoid';
import type { PlanDoc, Pt } from './types';

// ---------------------------------------------------------------------------
// 模数与尺寸常量（单位 mm）
// ---------------------------------------------------------------------------

/** 1 间 = 910mm，主网格 */
export const GRID = 910;
/** 半间 = 455mm，次网格 / 默认吸附步长 */
export const HALF_GRID = 455;
/** v1 墙没有厚度概念，渲染时固定视觉宽度 */
export const WALL_VISUAL_WIDTH = 100;

/** 允许的吸附步长（mm），1 = 自由 */
export const SNAP_STEPS = [GRID, HALF_GRID, 100, 1] as const;
export type SnapStep = (typeof SNAP_STEPS)[number];
export const DEFAULT_SNAP_STEP: SnapStep = HALF_GRID;

/** 柱默认尺寸 105×105 */
export const COLUMN_DEFAULT_SIZE = { width: 105, depth: 105 } as const;
/** 梁默认尺寸 910×300 */
export const BEAM_DEFAULT_SIZE = { width: 910, depth: 300 } as const;

/** 家具默认填充色 */
export const DEFAULT_FURNITURE_COLOR = '#C9D6E8';

// ---------------------------------------------------------------------------
// 视图（Stage scale = px/mm）
// ---------------------------------------------------------------------------

/** 缩放百分比的基准：0.05 px/mm ⇒ 1px = 20mm，此时 StatusBar 显示 100% */
export const BASE_SCALE = 0.05;
/** 最小 / 最大 Stage scale（px/mm） */
export const MIN_SCALE = BASE_SCALE / 25; // 4%
export const MAX_SCALE = BASE_SCALE * 25; // 2500%
/** 滚轮每格缩放系数 */
export const ZOOM_FACTOR = 1.1;
/** fit 时四周留白 mm */
export const FIT_PADDING_MM = GRID;

// ---------------------------------------------------------------------------
// 配色（见 docs/ARCHITECTURE.md 第 7 节）
// ---------------------------------------------------------------------------

export const ACCENT = '#4A6FA5';
export const GRID_MAJOR_COLOR = '#D3DCE8';
export const GRID_MINOR_COLOR = '#EBF0F6';
export const GRID_AXIS_COLOR = '#B4C2D4';
export const CANVAS_BG = '#FBFCFD';

// ---------------------------------------------------------------------------
// id
// ---------------------------------------------------------------------------

export type IdPrefix = 'w' | 'o' | 's' | 'r' | 'f' | 'a';

/**
 * 底图在画布上的 Konva id（M2）。
 * 底图是文档里唯一的单例元素，没有生成 id 的必要，用固定值即可被 select 工具命中。
 */
export const UNDERLAY_ID = 'underlay';

/** 生成带类型前缀的 id，例如 `w_V1StGXR8` */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${nanoid(8)}`;
}

/** 取 id 的类型前缀；无法识别时返回 null */
export function idPrefix(id: string): IdPrefix | null {
  const p = id.slice(0, id.indexOf('_'));
  return p === 'w' || p === 'o' || p === 's' || p === 'r' || p === 'f' || p === 'a' ? p : null;
}

// ---------------------------------------------------------------------------
// 文档工厂
// ---------------------------------------------------------------------------

export const DEFAULT_DOC_NAME = '未命名户型';

/** 生成一份空的 PlanDoc */
export function createEmptyDoc(name: string = DEFAULT_DOC_NAME): PlanDoc {
  const now = new Date().toISOString();
  return {
    version: 1,
    meta: { name, gridSize: GRID, createdAt: now, updatedAt: now },
    underlay: null,
    walls: [],
    openings: [],
    structures: [],
    rooms: [],
    furniture: [],
    annotations: [],
  };
}

/** 坐标取整（文档坐标必须是整数 mm） */
export function roundPt(p: Pt): Pt {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}
