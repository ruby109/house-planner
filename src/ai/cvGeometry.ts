/**
 * CV 几何 → 文档 mm 的**公共**处理（M4 的 `fuse.ts` 与 M5 的 `labelFuse.ts` 共用）。
 *
 * 这一层只做「像素几何怎么变成规整的 mm 几何」，不碰任何语义：
 *
 *   1. `dropBorderWalls`  图片外框线过滤（版面装饰边框会被 CV 老老实实当墙提出来）
 *   2. `toMmSegments`     px → mm，近轴段拉成严格轴向，斜段如实保留角度
 *   3. `snapGeometry`     房间多边形 + 墙段一起做轴聚类 → 吸附 → 平移到 (0,0)
 *   4. `segmentsToWalls`  吸附后的线段 → Wall[]（共线重叠合并成一段）
 *
 * **纯函数**：不 import opencv（只用 `src/cv/types.ts` 的类型），vitest 里直接跑。
 *
 * M5 抽出来的动机很实际：labelFuse 需要一模一样的墙处理，复制一份必然漂移。
 * `fuse.ts` 原样 re-export 这里的东西，老的 import 路径不受影响。
 */
import type { CvWall } from '../cv/types';
import type { PxSegment } from '../cv/geometry';
import { roundPt } from '../model/defaults';
import type { Pt, Wall } from '../model/types';
import {
  SOLVE_SNAP_STEP,
  type AxisMap,
  type AxisSegment,
  type DiagonalSegment,
  buildAxisMap,
  dropCollinear,
  edgeOrient,
  mergeAxisSegments,
  mergeDiagonalSegments,
  polygonAxisFlags,
  snapAxis,
  snapDiagonalAxis,
} from './solve';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * CV 坐标的跨墙聚类容差 mm。比纯 VLM 路径的 300mm 小——CV 给的坐标本来就准，
 * 只需要把「同一道墙上的抖动」并掉，剩下的交给 455 网格吸附去合并。
 */
export const CV_EDGE_CLUSTER_TOLERANCE_MM = 200;
/**
 * `distanceTransform` 量出来的厚度**系统性偏大**（阶段 A 验收结论：骨架两侧的
 * 反锯齿灰边也被算进去了）。所有由厚度推导的容差都先乘这个经验系数。
 */
export const CV_THICKNESS_CORRECTION = 0.8;
/** 短于此长度的斜段判为噪声（阶段 A 遗留项：房间填色的锯齿边会漏出一堆小斜段） */
export const MIN_DIAGONAL_WALL_MM = 600;
/** 吸附后短于此长度的墙段直接丢弃 */
export const MIN_WALL_MM = 150;
/** 边界墙过滤：离图边多近才算「贴着图边」（取图片短边的比例与笔画宽的较大者） */
export const BORDER_MARGIN_FRAC = 0.035;
/** 边界墙过滤：贴边线段沿该边的**并集**跨度超过这个比例才判为图片外框 */
export const BORDER_SPAN_FRAC = 0.8;
/** mm/px 的合理区间；超出就认为比例估计失败 */
export const MIN_MM_PER_PX = 0.2;
export const MAX_MM_PER_PX = 200;
/** T 型接点闭合半径的下限 mm */
export const T_JOIN_MIN_MM = 120;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

export function wallToSegment(w: CvWall): PxSegment {
  return { x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 };
}

export function segLen(s: PxSegment): number {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
}

/** 中位数（空数组返回 0） */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** 多边形面积重心（退化时返回顶点均值） */
export function polygonCentroid(poly: readonly Pt[]): Pt {
  let area2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const cross = a.x * b.y - b.x * a.y;
    area2 += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(area2) < 1e-9) {
    const n = Math.max(1, poly.length);
    return {
      x: poly.reduce((s, p) => s + p.x, 0) / n,
      y: poly.reduce((s, p) => s + p.y, 0) / n,
    };
  }
  return { x: cx / (3 * area2), y: cy / (3 * area2) };
}

/** 射线法：点是否在多边形内（边界上算在内） */
export function pointInPolygon(p: Pt, poly: readonly Pt[]): boolean {
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

// ---------------------------------------------------------------------------
// 1. 墙段清洗
// ---------------------------------------------------------------------------

export interface CleanWallsResult {
  walls: CvWall[];
  /** 被判为图片外框而丢弃的条数 */
  borderDropped: number;
}

/**
 * 图片外框线过滤（阶段 A 遗留项）。
 *
 * 网上抓的間取り图常常带一圈版面装饰边框（test2 就有），CV 会老老实实把它当墙。
 * 判据：**贴着某条图边**（距离 < margin）、与该边平行、并且同一条边上所有贴边线段的
 * **并集跨度 ≥ 80% 的边长**——单条线段可能被内容打断成两三截，所以必须看并集。
 *
 * 之所以不敢只看「贴边」：紧贴裁剪的图纸，外墙本来就在图边上。加上「几乎横贯整条边」
 * 这一条之后，只有真正的版面外框才会中招（test4 这种四周留白的图完全不受影响）。
 */
export function dropBorderWalls(
  walls: readonly CvWall[],
  imageWidthPx: number,
  imageHeightPx: number,
  strokePx: number,
): CleanWallsResult {
  const margin = Math.max(strokePx * 1.5, Math.min(imageWidthPx, imageHeightPx) * BORDER_MARGIN_FRAC);
  const drop = new Set<number>();

  const edges: Array<{ axis: 'h' | 'v'; at: number; length: number }> = [
    { axis: 'h', at: 0, length: imageWidthPx },
    { axis: 'h', at: imageHeightPx, length: imageWidthPx },
    { axis: 'v', at: 0, length: imageHeightPx },
    { axis: 'v', at: imageWidthPx, length: imageHeightPx },
  ];

  for (const edge of edges) {
    const hits: Array<{ index: number; from: number; to: number }> = [];
    for (let i = 0; i < walls.length; i++) {
      const w = walls[i];
      const dx = Math.abs(w.x2 - w.x1);
      const dy = Math.abs(w.y2 - w.y1);
      if (edge.axis === 'h') {
        if (dy > dx * 0.1) continue; // 不是近水平段
        if (Math.abs(w.y1 - edge.at) > margin || Math.abs(w.y2 - edge.at) > margin) continue;
        hits.push({ index: i, from: Math.min(w.x1, w.x2), to: Math.max(w.x1, w.x2) });
      } else {
        if (dx > dy * 0.1) continue;
        if (Math.abs(w.x1 - edge.at) > margin || Math.abs(w.x2 - edge.at) > margin) continue;
        hits.push({ index: i, from: Math.min(w.y1, w.y2), to: Math.max(w.y1, w.y2) });
      }
    }
    if (hits.length === 0) continue;

    // 并集跨度
    const spans = hits.slice().sort((a, b) => a.from - b.from);
    let covered = 0;
    let cur = { from: spans[0].from, to: spans[0].to };
    for (let i = 1; i < spans.length; i++) {
      if (spans[i].from <= cur.to) cur.to = Math.max(cur.to, spans[i].to);
      else {
        covered += cur.to - cur.from;
        cur = { from: spans[i].from, to: spans[i].to };
      }
    }
    covered += cur.to - cur.from;

    if (covered >= edge.length * BORDER_SPAN_FRAC) {
      for (const h of hits) drop.add(h.index);
    }
  }

  return {
    walls: walls.filter((_, i) => !drop.has(i)),
    borderDropped: drop.size,
  };
}

// ---------------------------------------------------------------------------
// 2. 墙段 → mm → 吸附
// ---------------------------------------------------------------------------

/** mm 空间里的一条墙段（`orient` 是按 `edgeOrient` 判出来的走向） */
export interface MmSegment extends PxSegment {
  orient: 'h' | 'v' | 'd';
}

/** px 线段 → mm，并把近轴段拉成严格轴向（斜段原样保留角度） */
export function toMmSegments(walls: readonly CvWall[], mmPerPx: number): MmSegment[] {
  const out: MmSegment[] = [];
  for (const w of walls) {
    const s = wallToSegment(w);
    const seg: PxSegment = {
      x1: s.x1 * mmPerPx,
      y1: s.y1 * mmPerPx,
      x2: s.x2 * mmPerPx,
      y2: s.y2 * mmPerPx,
    };
    const orient = edgeOrient(seg.x2 - seg.x1, seg.y2 - seg.y1);
    if (orient === 'h') {
      const y = (seg.y1 + seg.y2) / 2;
      out.push({ x1: seg.x1, y1: y, x2: seg.x2, y2: y, orient });
    } else if (orient === 'v') {
      const x = (seg.x1 + seg.x2) / 2;
      out.push({ x1: x, y1: seg.y1, x2: x, y2: seg.y2, orient });
    } else {
      out.push({ ...seg, orient });
    }
  }
  return out;
}

export interface SnapGeometryResult {
  polygons: Pt[][];
  segments: MmSegment[];
  xMap: AxisMap;
  yMap: AxisMap;
  translation: Pt;
}

/**
 * 房间多边形 + 墙段一起做轴聚类 → 吸附 → 平移到 (0,0)。
 *
 * 与 `solve.ts` 的 `snapSharedEdges` 同一套机制（`buildAxisMap` / `snapAxis` /
 * `snapDiagonalAxis`），区别是**墙段也要参与建图**：CV 的墙段不都在房间边界上
 * （外墙、隔墙的悬臂段），只用房间坐标建的映射会把它们插值到别处去。
 *
 * 顺带一提：轴聚类本身就是 T 型接点闭合——横墙端点的 x 会被吸到竖墙的 x 上。
 */
export function snapGeometry(
  polygons: readonly Pt[][],
  segments: readonly MmSegment[],
  tolerance: number,
): SnapGeometryResult {
  const flags = polygons.map((poly) => polygonAxisFlags(poly));

  const xs: number[] = [];
  const ys: number[] = [];
  for (let pi = 0; pi < polygons.length; pi++) {
    const poly = polygons[pi];
    for (let i = 0; i < poly.length; i++) {
      if (flags[pi].axisX[i]) xs.push(poly[i].x);
      if (flags[pi].axisY[i]) ys.push(poly[i].y);
    }
  }
  for (const s of segments) {
    if (s.orient === 'h') {
      ys.push(s.y1);
      xs.push(s.x1, s.x2);
    } else if (s.orient === 'v') {
      xs.push(s.x1);
      ys.push(s.y1, s.y2);
    }
  }

  // onCollision: 'merge' 是这里的关键：CV 会吐出几十条精确坐标，用纯 VLM 路径的
  // 「撞格就错开一格」会把整张图纸一格一格地撑大（实测面积虚增近 30%）。
  const axisOpts = { onCollision: 'merge' } as const;
  const xMap = buildAxisMap(xs, tolerance, SOLVE_SNAP_STEP, axisOpts);
  const yMap = buildAxisMap(ys, tolerance, SOLVE_SNAP_STEP, axisOpts);

  const snappedPolys = polygons.map((poly, pi) =>
    dropCollinear(
      poly.map((p, i) => ({
        x: flags[pi].axisX[i] ? snapAxis(xMap, p.x) : snapDiagonalAxis(xMap, p.x),
        y: flags[pi].axisY[i] ? snapAxis(yMap, p.y) : snapDiagonalAxis(yMap, p.y),
      })),
    ),
  );

  const snappedSegs = segments.map((s): MmSegment => {
    if (s.orient === 'h') {
      const y = snapAxis(yMap, s.y1);
      return { x1: snapAxis(xMap, s.x1), y1: y, x2: snapAxis(xMap, s.x2), y2: y, orient: 'h' };
    }
    if (s.orient === 'v') {
      const x = snapAxis(xMap, s.x1);
      return { x1: x, y1: snapAxis(yMap, s.y1), x2: x, y2: snapAxis(yMap, s.y2), orient: 'v' };
    }
    return {
      x1: snapDiagonalAxis(xMap, s.x1),
      y1: snapDiagonalAxis(yMap, s.y1),
      x2: snapDiagonalAxis(xMap, s.x2),
      y2: snapDiagonalAxis(yMap, s.y2),
      orient: 'd',
    };
  });

  let minX = Infinity;
  let minY = Infinity;
  const track = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
  };
  for (const poly of snappedPolys) for (const p of poly) track(p.x, p.y);
  for (const s of snappedSegs) {
    track(s.x1, s.y1);
    track(s.x2, s.y2);
  }
  if (!Number.isFinite(minX)) minX = 0;
  if (!Number.isFinite(minY)) minY = 0;
  const translation = { x: -minX, y: -minY };

  return {
    polygons: snappedPolys.map((poly) =>
      poly.map((p) => roundPt({ x: p.x + translation.x, y: p.y + translation.y })),
    ),
    segments: snappedSegs.map((s) => ({
      x1: s.x1 + translation.x,
      y1: s.y1 + translation.y,
      x2: s.x2 + translation.x,
      y2: s.y2 + translation.y,
      orient: s.orient,
    })),
    xMap,
    yMap,
    translation,
  };
}

/** 吸附后的墙段 → Wall[]（共线重叠的合并成一段，复用 solve.ts 的合并器） */
export function segmentsToWalls(segments: readonly MmSegment[]): Wall[] {
  const axis: AxisSegment[] = [];
  const diagonal: DiagonalSegment[] = [];
  for (const s of segments) {
    if (segLen(s) < MIN_WALL_MM) continue;
    if (s.orient === 'h') {
      axis.push({ orient: 'h', fixed: s.y1, from: Math.min(s.x1, s.x2), to: Math.max(s.x1, s.x2) });
    } else if (s.orient === 'v') {
      axis.push({ orient: 'v', fixed: s.x1, from: Math.min(s.y1, s.y2), to: Math.max(s.y1, s.y2) });
    } else {
      diagonal.push({ a: roundPt({ x: s.x1, y: s.y1 }), b: roundPt({ x: s.x2, y: s.y2 }) });
    }
  }
  return [...mergeAxisSegments(axis), ...mergeDiagonalSegments(diagonal)];
}
