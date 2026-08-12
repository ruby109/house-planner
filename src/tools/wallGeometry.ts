/**
 * M1b 工具层的纯几何辅助（画墙 / 门窗放置）。
 *
 * 这里只放**纯函数与常量**，无状态、无 React、无 store 依赖，便于 vitest 单测。
 * 通用几何（投影、正交约束、长度…）复用 `src/utils/geometry.ts`，本文件不重复实现，
 * 只补工具语义层面的规则（默认宽度、洞口 clamp、洞口重叠判定、最近墙查找）。
 */
import { clamp, constrainOrtho, pointSegProjection, wallLen } from '../utils/geometry';
import type { Opening, OpeningSwing, OpeningType, Pt, Wall } from '../model/types';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 各类开口的默认宽度 mm（日本住宅常见规格） */
export const OPENING_DEFAULT_WIDTH: Record<OpeningType, number> = {
  door: 780,
  sliding_door: 1690,
  window: 1690,
  opening: 910,
};

/** 门窗工具的吸附半径：指针离墙超过该距离就不落在墙上 */
export const OPENING_ATTACH_DISTANCE = 500;

/** 开き戸的默认开启方向 */
export const OPENING_DEFAULT_SWING = 'in_left' as const;

// ---------------------------------------------------------------------------
// 画墙
// ---------------------------------------------------------------------------

/**
 * 画墙时的终点约束：默认锁 0/90°（取 dx/dy 偏移较大的轴），`free = true`（Shift）自由角度。
 * 结果取整，保证文档坐标始终是整数 mm。
 */
export function constrainWallEnd(from: Pt, to: Pt, free = false): Pt {
  const p = constrainOrtho(from, to, free);
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/** 长度为 0 的段不允许提交 */
export function isZeroLengthSegment(a: Pt, b: Pt): boolean {
  return a.x === b.x && a.y === b.y;
}

// ---------------------------------------------------------------------------
// 开口（沿墙定位）
// ---------------------------------------------------------------------------

/** 墙段是否放得下该宽度的开口 */
export function openingFits(width: number, wallLength: number): boolean {
  return wallLength >= width;
}

/**
 * 把开口中心沿墙的距离 clamp 到「洞口完全落在墙段内」的合法区间 [w/2, L-w/2]。
 * 墙比洞口还短时无解，返回墙中点（调用方应先用 openingFits 判定为非法）。
 * 返回整数 mm。
 */
export function clampOpeningOffset(offset: number, width: number, wallLength: number): number {
  const half = width / 2;
  if (!openingFits(width, wallLength)) return Math.round(wallLength / 2);
  return Math.round(clamp(offset, half, wallLength - half));
}

/** 开口沿墙占据的区间 [from, to] */
export function openingSpan(offset: number, width: number): { from: number; to: number } {
  const half = width / 2;
  return { from: offset - half, to: offset + half };
}

/** 两个同墙开口是否重叠；恰好首尾相接**不算**重叠 */
export function openingsOverlap(
  aOffset: number,
  aWidth: number,
  bOffset: number,
  bWidth: number,
): boolean {
  return Math.abs(aOffset - bOffset) < (aWidth + bWidth) / 2;
}

/**
 * 目标墙上是否已有开口与 (offset,width) 冲突。
 * `excludeId` 用于「拖动已存在的开口」时忽略它自身。
 */
export function hasOpeningConflict(
  openings: readonly Opening[],
  wallId: string,
  offset: number,
  width: number,
  excludeId?: string,
): boolean {
  for (const o of openings) {
    if (o.wallId !== wallId) continue;
    if (excludeId !== undefined && o.id === excludeId) continue;
    if (openingsOverlap(offset, width, o.offset, o.width)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 墙查找与坐标换算
// ---------------------------------------------------------------------------

export interface WallHit {
  wall: Wall;
  /** 沿墙从 start 起算的距离 mm */
  along: number;
  /** 墙上的投影点 */
  point: Pt;
  /** 指针到墙中心线的距离 mm */
  distance: number;
}

/**
 * 找离点 p 最近的墙；超过 `maxDistance` 视为未命中（返回 null）。
 * 零长度墙被忽略。
 */
export function nearestWall(
  walls: readonly Wall[],
  p: Pt,
  maxDistance = OPENING_ATTACH_DISTANCE,
): WallHit | null {
  let best: WallHit | null = null;
  for (const wall of walls) {
    if (isZeroLengthSegment(wall.start, wall.end)) continue;
    const proj = pointSegProjection(p, wall.start, wall.end);
    if (proj.distance > maxDistance) continue;
    if (best === null || proj.distance < best.distance) {
      best = { wall, along: proj.along, point: proj.point, distance: proj.distance };
    }
  }
  return best;
}

/** 沿墙距离 → 世界坐标点 */
export function pointAlongWall(wall: { start: Pt; end: Pt }, along: number): Pt {
  const len = wallLen(wall);
  if (len <= 0) return { x: wall.start.x, y: wall.start.y };
  const t = along / len;
  return {
    x: wall.start.x + (wall.end.x - wall.start.x) * t,
    y: wall.start.y + (wall.end.y - wall.start.y) * t,
  };
}

/** 墙方向角（度，顺时针为正，与屏幕 y 向下一致） */
export function wallAngleDeg(wall: { start: Pt; end: Pt }): number {
  return (Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x) * 180) / Math.PI;
}

/** 把角度归一化到 (-90, 90]，用于让标注文字永远正着读 */
export function readableAngleDeg(deg: number): number {
  let a = ((deg % 360) + 360) % 360; // [0, 360)
  if (a > 180) a -= 360; // (-180, 180]
  if (a > 90) a -= 180;
  else if (a <= -90) a += 180;
  return a;
}

// ---------------------------------------------------------------------------
// 开き戸符号的局部几何
//
// 符号统一画在「洞口局部坐标系」里（见 components/canvas/OpeningSymbol.tsx）：
//   局部 +x = 墙 start→end 方向；局部 +y = 墙左法线方向，约定为室内侧（in）。
// 于是四种 swing 只是 (铰链在 ±x) × (开启侧在 ±y) 的组合。
// ---------------------------------------------------------------------------

export interface DoorSwingGeometry {
  /** 铰链在局部 x 上的位置：-width/2（left）或 +width/2（right） */
  hingeX: number;
  /** 开启侧：+1 = 局部 +y（in），-1 = 局部 -y（out） */
  side: 1 | -1;
  /** 门板张开 90° 后的端点（局部坐标） */
  leafTip: Pt;
  /** 开启弧的起止角（度，atan2 语义：屏幕 y 向下，角度顺时针递增） */
  arcFrom: number;
  arcTo: number;
}

export function doorSwingGeometry(width: number, swing?: OpeningSwing): DoorSwingGeometry {
  const s: OpeningSwing = swing ?? OPENING_DEFAULT_SWING;
  const side: 1 | -1 = s === 'out_left' || s === 'out_right' ? -1 : 1;
  const hingeLeft = s === 'in_left' || s === 'out_left';
  const half = width / 2;
  const hingeX = hingeLeft ? -half : half;
  // 从铰链指向另一侧门框的方向（局部 x 上的符号）
  const toOther = hingeLeft ? 1 : -1;
  const angleOther = toOther > 0 ? 0 : 180;
  const angleTip = side > 0 ? 90 : -90;
  // cross > 0 ⇒ 从「另一侧门框」转到「门板端点」是角度递增方向，弧就从 other 起画
  const arcFrom = toOther * side > 0 ? angleOther : angleTip;
  return { hingeX, side, leafTip: { x: hingeX, y: side * width }, arcFrom, arcTo: arcFrom + 90 };
}

/** 圆弧折线化：返回 Konva Line 用的 [x0,y0,x1,y1,…] */
export function arcPoints(
  cx: number,
  cy: number,
  radius: number,
  startDeg: number,
  endDeg: number,
  steps = 24,
): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const rad = ((startDeg + ((endDeg - startDeg) * i) / steps) * Math.PI) / 180;
    pts.push(cx + radius * Math.cos(rad), cy + radius * Math.sin(rad));
  }
  return pts;
}

// ---------------------------------------------------------------------------
// 门窗放置候选（工具与预览共用同一套判定）
// ---------------------------------------------------------------------------

export interface OpeningCandidate {
  wallId: string;
  /** 墙段（渲染预览用，避免预览组件再查一次 store） */
  start: Pt;
  end: Pt;
  /** clamp 后的中心沿墙距离 */
  offset: number;
  width: number;
  /** 可提交 */
  valid: boolean;
}

/**
 * 计算一次门窗放置候选。
 * - 找不到 `maxDistance` 内的墙 → 返回 null（调用方改为跟随指针的置灰预览）；
 * - 墙太短或与已有开口重叠 → 返回 `valid: false` 的候选（预览置灰、点击不提交）。
 */
export function computeOpeningCandidate(
  walls: readonly Wall[],
  openings: readonly Opening[],
  p: Pt,
  width: number,
  maxDistance = OPENING_ATTACH_DISTANCE,
): OpeningCandidate | null {
  const hit = nearestWall(walls, p, maxDistance);
  if (!hit) return null;
  const len = wallLen(hit.wall);
  const offset = clampOpeningOffset(hit.along, width, len);
  const valid =
    openingFits(width, len) && !hasOpeningConflict(openings, hit.wall.id, offset, width);
  return {
    wallId: hit.wall.id,
    start: hit.wall.start,
    end: hit.wall.end,
    offset,
    width,
    valid,
  };
}
