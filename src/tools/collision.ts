/**
 * 碰撞检测辅助（M1c）。
 *
 * 见 docs/ARCHITECTURE.md 第 5 节：家具碰撞用 `rotatedRectCorners` + `polysIntersectSAT`，
 * 碰撞**只做红色高亮提示，不阻止放置**。
 *
 * 约定：
 * - 家具 / 结构 / 放置预览统一抽象成 `RectBody`（中心 + 宽深 + 旋转度）。
 * - 墙没有厚度概念，碰撞时按中心线扩成 `WALL_VISUAL_WIDTH`(100mm) 宽的矩形。
 * - 本文件是纯函数模块（不依赖 React / store），便于 vitest 单测。
 */
import { WALL_VISUAL_WIDTH } from '../model/defaults';
import type { Furniture, Pt, Wall } from '../model/types';
import { polysIntersectSAT, rotatedRectCorners, segmentPolygon } from '../utils/geometry';

/** 参与碰撞的矩形刚体 */
export interface RectBody {
  /** 矩形中心 mm */
  position: Pt;
  /** 宽 mm（局部 x 方向） */
  w: number;
  /** 深 mm（局部 y 方向） */
  d: number;
  /** 旋转度，顺时针为正 */
  rotation: number;
}

/** 矩形刚体的四角多边形 */
export function rectPolygon(r: RectBody): Pt[] {
  return rotatedRectCorners(r.position, r.w, r.d, r.rotation);
}

/** 家具 → 矩形刚体 */
export function furnitureBody(f: Furniture): RectBody {
  return { position: f.position, w: f.size.w, d: f.size.d, rotation: f.rotation };
}

/** 墙 → 沿中心线的矩形多边形（默认 100mm 宽） */
export function wallPolygon(wall: Wall, width: number = WALL_VISUAL_WIDTH): Pt[] {
  return segmentPolygon(wall.start, wall.end, width);
}

/** 矩形与任一面墙相交？ */
export function rectHitsWalls(
  rect: RectBody,
  walls: Wall[],
  wallWidth: number = WALL_VISUAL_WIDTH,
): boolean {
  if (walls.length === 0) return false;
  const poly = rectPolygon(rect);
  return walls.some((w) => polysIntersectSAT(poly, wallPolygon(w, wallWidth)));
}

/**
 * 矩形与任一家具相交？
 * @param excludeId 自身 id（移动 / 变形已有家具时排除自己）
 */
export function rectHitsFurniture(
  rect: RectBody,
  furniture: Furniture[],
  excludeId: string | null = null,
): boolean {
  if (furniture.length === 0) return false;
  const poly = rectPolygon(rect);
  return furniture.some(
    (f) => f.id !== excludeId && polysIntersectSAT(poly, rectPolygon(furnitureBody(f))),
  );
}

/** 矩形是否与墙或家具发生碰撞（放置预览用） */
export function rectCollides(
  rect: RectBody,
  walls: Wall[],
  furniture: Furniture[],
  excludeId: string | null = null,
): boolean {
  return rectHitsFurniture(rect, furniture, excludeId) || rectHitsWalls(rect, walls);
}

/**
 * 全量计算处于碰撞状态的家具 id（家具 vs 家具 + 家具 vs 墙）。
 * O(n² + n·m)，家具 ≤ 100 件时直接算即可（见 M1c 需求）。
 */
export function collidingFurnitureIds(furniture: Furniture[], walls: Wall[]): Set<string> {
  const hit = new Set<string>();
  if (furniture.length === 0) return hit;

  const polys = furniture.map((f) => rectPolygon(furnitureBody(f)));

  for (let i = 0; i < furniture.length; i++) {
    for (let j = i + 1; j < furniture.length; j++) {
      if (polysIntersectSAT(polys[i], polys[j])) {
        hit.add(furniture[i].id);
        hit.add(furniture[j].id);
      }
    }
  }

  if (walls.length > 0) {
    const wallPolys = walls.map((w) => wallPolygon(w));
    for (let i = 0; i < furniture.length; i++) {
      if (hit.has(furniture[i].id)) continue;
      if (wallPolys.some((wp) => polysIntersectSAT(polys[i], wp))) hit.add(furniture[i].id);
    }
  }

  return hit;
}
