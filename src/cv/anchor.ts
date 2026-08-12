/**
 * M5：房间的**标签锚点** —— 在多边形内部找一个「适合放序号圆标」的点。
 *
 * **纯 TS、不 import opencv**，配 vitest 单测。
 *
 * 为什么不能直接用面积重心：CV 分出来的房间常常是 L 形 / 带阶梯的凹多边形，
 * 重心可能落在房间**外面**（L 形的内凹口），序号圆标画到隔壁房间头上，
 * AI 就会把两个房间的语义答反 —— 这在 M5 里是最致命的一类错误，
 * 因为整条管线的语义挂载完全靠编号。
 *
 * 做法（穷人版 pole of inaccessibility）：
 *   1. 重心在多边形内 → 直接用（矩形房间的绝大多数情形，一次判定就结束）；
 *   2. 否则沿 y 方向扫若干条水平线，取**最长的那段内部区间**的中点。
 */
import type { PxPoint } from './types';

/** 扫描线条数：够找出「哪一横排最宽」，又不至于算得太久 */
const SCAN_LINES = 33;

/** 射线法：点在多边形内 */
export function pointInPoly(p: PxPoint, poly: readonly PxPoint[]): boolean {
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

/** 面积重心（退化时返回顶点均值） */
export function polyCentroid(poly: readonly PxPoint[]): PxPoint {
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

/** 多边形包围盒 */
export function polyBounds(poly: readonly PxPoint[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of poly) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0, y0, x1, y1 };
}

/**
 * 一条水平线 y 与多边形所有边的交点（升序）。
 * 顶点正好落在扫描线上时可能出重复交点，成对取用足够稳。
 */
function scanCrossings(poly: readonly PxPoint[], y: number): number[] {
  const xs: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (a.y > y !== b.y > y) {
      xs.push(((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x);
    }
  }
  return xs.sort((p, q) => p - q);
}

export interface LabelAnchor extends PxPoint {
  /** 锚点所在的那段内部宽度（px）；越大越放得下圆标 */
  spanPx: number;
}

/**
 * 房间的标签锚点：**保证落在多边形内部**（除非多边形本身退化）。
 *
 * 返回值还带上「这个位置有多宽」，调用方可以据此收缩圆标半径，
 * 免得在细长的走廊里画一个把墙盖住的大圆。
 */
export function roomLabelAnchor(poly: readonly PxPoint[]): LabelAnchor {
  const bounds = polyBounds(poly);
  if (poly.length < 3) {
    return { x: (bounds.x0 + bounds.x1) / 2, y: (bounds.y0 + bounds.y1) / 2, spanPx: 0 };
  }

  const centroid = polyCentroid(poly);
  if (pointInPoly(centroid, poly)) {
    const xs = scanCrossings(poly, centroid.y);
    let span = 0;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (centroid.x >= xs[i] && centroid.x <= xs[i + 1]) span = xs[i + 1] - xs[i];
    }
    return { x: centroid.x, y: centroid.y, spanPx: span || bounds.x1 - bounds.x0 };
  }

  // 凹多边形：扫描线里挑最宽的一段
  let best: LabelAnchor = {
    x: (bounds.x0 + bounds.x1) / 2,
    y: (bounds.y0 + bounds.y1) / 2,
    spanPx: 0,
  };
  const height = bounds.y1 - bounds.y0;
  for (let i = 1; i < SCAN_LINES; i++) {
    const y = bounds.y0 + (height * i) / SCAN_LINES;
    const xs = scanCrossings(poly, y);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const span = xs[k + 1] - xs[k];
      if (span > best.spanPx) best = { x: (xs[k] + xs[k + 1]) / 2, y, spanPx: span };
    }
  }
  return best;
}
