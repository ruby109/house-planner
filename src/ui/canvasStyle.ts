/**
 * M1c 画布视觉常量（结构 / 家具 / 预览共用）。
 *
 * 放在这里是为了让「工具预览」与「正式图层」共享同一套外观，
 * 避免预览和落地图形长得不一样。颜色沿用 index.css 的浅色基调 + 单一强调色。
 *
 * 注意：Konva 节点坐标一律是 mm；这里凡是标注「px」的量，
 * 都必须配合 `strokeScaleEnabled={false}` 使用，才真正是屏幕像素。
 */
import { ACCENT, BEAM_DEFAULT_SIZE, COLUMN_DEFAULT_SIZE } from '../model/defaults';
import type { FloorType, StructureKind } from '../model/types';

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

/** 选中态描边色 */
export const SELECT_COLOR = ACCENT;
/** 碰撞提示色（仅高亮，不阻止放置） */
export const COLLISION_COLOR = '#D9534F';
/** 锁定元素的描边色 */
export const LOCKED_COLOR = '#9AA7B4';

/** 常规描边宽度（px） */
export const STROKE_PX = 1;
/** 选中 / 碰撞描边宽度（px） */
export const STROKE_ACTIVE_PX = 2;

// ---------------------------------------------------------------------------
// 结构（柱 / 梁）
// ---------------------------------------------------------------------------

export const STRUCTURE_DEFAULT_SIZE: Record<StructureKind, { width: number; depth: number }> = {
  column: { width: COLUMN_DEFAULT_SIZE.width, depth: COLUMN_DEFAULT_SIZE.depth },
  beam: { width: BEAM_DEFAULT_SIZE.width, depth: BEAM_DEFAULT_SIZE.depth },
};

/** 柱：深灰实心 */
export const COLUMN_FILL = '#5B6675';
/** 梁：半透明填充 + 虚线描边 */
export const BEAM_FILL = 'rgba(91, 102, 117, 0.16)';
export const STRUCTURE_STROKE = '#465061';
/** 梁的虚线（px，需 strokeScaleEnabled={false}） */
export const BEAM_DASH_PX = [6, 4];

export function structureFill(kind: StructureKind): string {
  return kind === 'column' ? COLUMN_FILL : BEAM_FILL;
}

// ---------------------------------------------------------------------------
// 家具
// ---------------------------------------------------------------------------

export const FURNITURE_STROKE = '#8A97A6';
/** Transformer 缩放后允许的最小边长 mm */
export const MIN_FURNITURE_SIZE = 100;
/** 预览的整体透明度 */
export const PREVIEW_OPACITY = 0.7;

/** 圆角半径 mm：随尺寸缩放并夹在合理区间 */
export function cornerRadiusMm(w: number, d: number): number {
  const r = Math.min(w, d) * 0.08;
  return Math.max(15, Math.min(60, r));
}

/** 家具名称字号 mm：随尺寸缩放并夹在合理区间 */
export function labelFontSizeMm(w: number, d: number): number {
  const f = Math.min(w, d) * 0.3;
  return Math.max(90, Math.min(260, f));
}

/** 文字在屏幕上小于该像素高度时隐藏（scale 单位为 px/mm） */
export const MIN_LABEL_PX = 7;

export function labelVisible(fontSizeMm: number, scale: number): boolean {
  return Number.isFinite(scale) && fontSizeMm * scale >= MIN_LABEL_PX;
}

// ---------------------------------------------------------------------------
// 房间（M1d）
// ---------------------------------------------------------------------------

/** 地面类型 → 填充色（低饱和度，保证上面的墙线与家具仍然清晰） */
export const ROOM_FILL: Record<FloorType, string> = {
  flooring: 'rgba(216, 190, 152, 0.30)',
  tatami: 'rgba(150, 186, 132, 0.30)',
  tile: 'rgba(150, 180, 200, 0.28)',
  other: 'rgba(150, 158, 168, 0.20)',
};

/** 地面类型的中文名（属性面板 + 画布共用） */
export const FLOOR_LABELS: Record<FloorType, string> = {
  flooring: '木地板',
  tatami: '榻榻米',
  tile: '瓷砖',
  other: '其他',
};

export const FLOOR_ORDER: FloorType[] = ['flooring', 'tatami', 'tile', 'other'];

/** 房间标签文字色 */
export const ROOM_LABEL_COLOR = '#5A6472';
/** 选中房间的描边（px，需 strokeScaleEnabled={false}） */
export const ROOM_SELECTED_STROKE_PX = 2;

/**
 * 房间标签字号 mm：按房间包围盒缩放并夹在合理区间。
 * 与家具标签同一套思路，只是房间更大所以上下限更高。
 */
export function roomLabelFontMm(bboxW: number, bboxH: number): number {
  const f = Math.min(bboxW, bboxH) * 0.16;
  return Math.max(140, Math.min(420, f));
}
