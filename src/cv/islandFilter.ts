/**
 * M4.1：**孤岛墙段剔除**（见 docs/CV-PIPELINE.md 第 6 节）。
 *
 * 虚线剔除之后总还有漏网的：地暖框的阶梯段、指北针的圆弧、家具轮廓、
 * 图例里的小方块……它们的共同特征是
 *
 *   「**跟主墙网完全不连通** + **整体落在图纸内部（或某个 CV 房间里）** + **比墙细**」。
 *
 * 真墙不可能同时满足这三条：墙一定连成一张网（外墙 + 内隔墙），
 * 就算被门洞切断，端点也会落在别的墙上；真正孤立的那一小撮基本都是装饰。
 *
 * 纯 TS、不 import opencv，配 vitest。
 */
import type { CvRoom, CvWall, PxPoint } from './types';

export interface IslandFilterOptions {
  /** 两段墙「算接上」的距离容差（px）；一般取 1.5× 墙笔画宽 */
  touchTolPx: number;
  /** 平均厚度低于「厚度中位数 × 此系数」才算细；默认 0.6 */
  thinRatio?: number;
  /** CV 房间多边形：孤岛整体落在某个房间里也算「在图纸内部」 */
  rooms?: readonly CvRoom[];
  /** 主分量包围盒的内缩比例（判「在图纸内部」用）；默认 0.02 */
  interiorMarginFrac?: number;
}

export interface WallIsland {
  /** 该子图包含的墙段下标 */
  indices: number[];
  /** 子图总长度 */
  lengthPx: number;
  /** 长度加权平均厚度 */
  thicknessPx: number;
  box: { x0: number; y0: number; x1: number; y1: number };
}

export interface IslandFilterResult {
  walls: CvWall[];
  /** 被剔除的墙段（debug 用） */
  dropped: CvWall[];
  /** 被剔除的孤岛子图 */
  islands: WallIsland[];
}

const EPS = 1e-9;

function wallLength(w: CvWall): number {
  return Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
}

/** 点到线段的距离 */
function pointSegDist(p: PxPoint, w: CvWall): number {
  const lx = w.x2 - w.x1;
  const ly = w.y2 - w.y1;
  const l2 = lx * lx + ly * ly;
  if (l2 < EPS) return Math.hypot(p.x - w.x1, p.y - w.y1);
  let t = ((p.x - w.x1) * lx + (p.y - w.y1) * ly) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(w.x1 + lx * t - p.x, w.y1 + ly * t - p.y);
}

/** 两条线段之间的最短距离（含相交判定） */
export function segmentDistance(a: CvWall, b: CvWall): number {
  const ax = a.x2 - a.x1;
  const ay = a.y2 - a.y1;
  const bx = b.x2 - b.x1;
  const by = b.y2 - b.y1;
  const denom = ax * by - ay * bx;
  if (Math.abs(denom) > EPS) {
    const rx = b.x1 - a.x1;
    const ry = b.y1 - a.y1;
    const t = (rx * by - ry * bx) / denom;
    const u = (rx * ay - ry * ax) / denom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(
    pointSegDist({ x: a.x1, y: a.y1 }, b),
    pointSegDist({ x: a.x2, y: a.y2 }, b),
    pointSegDist({ x: b.x1, y: b.y1 }, a),
    pointSegDist({ x: b.x2, y: b.y2 }, a),
  );
}

/** 射线法：点在多边形内 */
function pointInPolygon(p: PxPoint, poly: readonly PxPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y) {
      const x = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < x) inside = !inside;
    }
  }
  return inside;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * 把墙段建成连通图，切出所有连通子图（按总长度降序，第 0 个就是主墙网）。
 * 单独导出方便单测。
 */
export function findWallIslands(walls: readonly CvWall[], touchTolPx: number): WallIsland[] {
  const n = walls.length;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) {
      const next = parent[i];
      parent[i] = r;
      i = next;
    }
    return r;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (segmentDistance(walls[i], walls[j]) <= touchTolPx) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[rj] = ri;
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  }

  const islands: WallIsland[] = [];
  for (const indices of groups.values()) {
    let length = 0;
    let weighted = 0;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const i of indices) {
      const w = walls[i];
      const len = wallLength(w);
      length += len;
      weighted += (w.thicknessPx || 0) * len;
      x0 = Math.min(x0, w.x1, w.x2);
      y0 = Math.min(y0, w.y1, w.y2);
      x1 = Math.max(x1, w.x1, w.x2);
      y1 = Math.max(y1, w.y1, w.y2);
    }
    islands.push({
      indices,
      lengthPx: length,
      thicknessPx: length > 0 ? weighted / length : 0,
      box: { x0, y0, x1, y1 },
    });
  }
  islands.sort((a, b) => b.lengthPx - a.lengthPx || a.indices[0] - b.indices[0]);
  return islands;
}

/**
 * 剔除「与主墙网不连通 + 在图纸内部 + 比墙细」的孤岛子图。
 *
 * 「在图纸内部」两种认法（满足其一即可）：
 * - 整体落在某个 CV 房间多边形里（要求的判据；家具、图例走这条）；
 * - 包围盒整体落在**主墙网包围盒内缩一圈**之后的范围里（地暖框走这条：
 *   它自己就是房间的边界，点在多边形内的判定会卡在边上，只能靠外框判）。
 */
export function dropIslandWalls(
  walls: readonly CvWall[],
  opts: IslandFilterOptions,
): IslandFilterResult {
  if (walls.length === 0) return { walls: [], dropped: [], islands: [] };

  const islands = findWallIslands(walls, opts.touchTolPx);
  if (islands.length <= 1) return { walls: [...walls], dropped: [], islands: [] };

  const main = islands[0];
  const thinLimit = median(walls.map((w) => w.thicknessPx || 0)) * (opts.thinRatio ?? 0.6);
  const marginX = (main.box.x1 - main.box.x0) * (opts.interiorMarginFrac ?? 0.02);
  const marginY = (main.box.y1 - main.box.y0) * (opts.interiorMarginFrac ?? 0.02);

  const inside = (box: WallIsland['box']): boolean => {
    if (
      box.x0 >= main.box.x0 + marginX &&
      box.x1 <= main.box.x1 - marginX &&
      box.y0 >= main.box.y0 + marginY &&
      box.y1 <= main.box.y1 - marginY
    ) {
      return true;
    }
    for (const room of opts.rooms ?? []) {
      const corners: PxPoint[] = [
        { x: box.x0, y: box.y0 },
        { x: box.x1, y: box.y0 },
        { x: box.x1, y: box.y1 },
        { x: box.x0, y: box.y1 },
      ];
      if (corners.every((p) => pointInPolygon(p, room.polygon))) return true;
    }
    return false;
  };

  const drop = new Set<number>();
  const droppedIslands: WallIsland[] = [];
  for (let i = 1; i < islands.length; i++) {
    const island = islands[i];
    if (thinLimit > 0 && island.thicknessPx >= thinLimit) continue;
    if (!inside(island.box)) continue;
    droppedIslands.push(island);
    for (const idx of island.indices) drop.add(idx);
  }

  return {
    walls: walls.filter((_, i) => !drop.has(i)),
    dropped: walls.filter((_, i) => drop.has(i)),
    islands: droppedIslands,
  };
}
