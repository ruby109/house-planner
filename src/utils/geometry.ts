/**
 * 纯几何函数。无状态、无副作用、可单测。
 * 所有输入输出单位为 mm / 度（见 docs/ARCHITECTURE.md 第 5 节）。
 */
import type { Pt } from '../model/types';

const EPS = 1e-9;

/** 把 v 吸附到 step 的整数倍；step <= 1 时退化为取整 */
export function snap(v: number, step: number): number {
  if (!Number.isFinite(v)) return 0;
  if (!Number.isFinite(step) || step <= 1) return Math.round(v);
  return Math.round(v / step) * step;
}

/** 逐分量吸附 */
export function snapPt(p: Pt, step: number): Pt {
  return { x: snap(p.x, step), y: snap(p.y, step) };
}

export function distance(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export interface SegProjection {
  /** 投影点（已 clamp 到线段内） */
  point: Pt;
  /** 参数 t ∈ [0,1]，0 = a，1 = b */
  t: number;
  /** 沿线段从 a 起算的弧长 mm */
  along: number;
  /** p 到线段的距离 mm */
  distance: number;
}

/**
 * 点到线段的投影。用于门窗沿墙滑动、点选墙体。
 * 退化线段（a === b）时返回 a。
 */
export function pointSegProjection(p: Pt, a: Pt, b: Pt): SegProjection {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 <= EPS) {
    return { point: { x: a.x, y: a.y }, t: 0, along: 0, distance: distance(p, a) };
  }
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.min(1, Math.max(0, t));
  const point = { x: a.x + abx * t, y: a.y + aby * t };
  const len = Math.sqrt(len2);
  return { point, t, along: t * len, distance: distance(p, point) };
}

/** 墙（或任意线段）方向单位向量；零长度返回 {x:0,y:0} */
export function wallDir(seg: { start: Pt; end: Pt }): Pt {
  const dx = seg.end.x - seg.start.x;
  const dy = seg.end.y - seg.start.y;
  const len = Math.hypot(dx, dy);
  if (len <= EPS) return { x: 0, y: 0 };
  return { x: dx / len, y: dy / len };
}

/** 墙（或任意线段）长度 mm */
export function wallLen(seg: { start: Pt; end: Pt }): number {
  return Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y);
}

/** 墙方向的法向单位向量（左法线） */
export function wallNormal(seg: { start: Pt; end: Pt }): Pt {
  const d = wallDir(seg);
  return { x: -d.y, y: d.x };
}

/**
 * 画墙时的正交约束：把终点锁到相对起点的水平 / 垂直方向（取偏移较大的轴）。
 * `free = true`（按住 Shift）时原样返回。
 */
export function constrainOrtho(from: Pt, to: Pt, free = false): Pt {
  if (free) return { x: to.x, y: to.y };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return Math.abs(dx) >= Math.abs(dy) ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
}

/**
 * 绕中心旋转的矩形四角，顺序为局部坐标的 左上 → 右上 → 右下 → 左下。
 * @param deg 顺时针为正（与屏幕 y 向下一致）
 */
export function rotatedRectCorners(center: Pt, w: number, d: number, deg: number): Pt[] {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = w / 2;
  const hd = d / 2;
  const local: Pt[] = [
    { x: -hw, y: -hd },
    { x: hw, y: -hd },
    { x: hw, y: hd },
    { x: -hw, y: hd },
  ];
  return local.map((l) => ({
    x: center.x + l.x * cos - l.y * sin,
    y: center.y + l.x * sin + l.y * cos,
  }));
}

/** 把线段按给定宽度扩成矩形多边形（墙的碰撞体 / 视觉宽度） */
export function segmentPolygon(a: Pt, b: Pt, width: number): Pt[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const h = width / 2;
  if (len <= EPS) {
    return [
      { x: a.x - h, y: a.y - h },
      { x: a.x + h, y: a.y - h },
      { x: a.x + h, y: a.y + h },
      { x: a.x - h, y: a.y + h },
    ];
  }
  const nx = (-dy / len) * h;
  const ny = (dx / len) * h;
  return [
    { x: a.x + nx, y: a.y + ny },
    { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny },
    { x: a.x - nx, y: a.y - ny },
  ];
}

function projectPoly(poly: Pt[], axis: Pt): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const p of poly) {
    const v = p.x * axis.x + p.y * axis.y;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

/**
 * 凸多边形相交检测（分离轴定理）。
 * 仅接触（投影区间刚好相接）视为**不相交**，避免家具紧靠时误报碰撞。
 */
export function polysIntersectSAT(a: Pt[], b: Pt[]): boolean {
  if (a.length < 3 || b.length < 3) return false;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      let ax = -(p2.y - p1.y);
      let ay = p2.x - p1.x;
      const len = Math.hypot(ax, ay);
      if (len <= EPS) continue;
      ax /= len;
      ay /= len;
      const axis = { x: ax, y: ay };
      const [minA, maxA] = projectPoly(a, axis);
      const [minB, maxB] = projectPoly(b, axis);
      if (maxA - minB <= EPS || maxB - minA <= EPS) return false;
    }
  }
  return true;
}

/** 鞋带公式，返回**绝对**面积 mm²（与顶点绕向无关） */
export function polygonAreaMm2(poly: Pt[]): number {
  if (poly.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i];
    const p2 = poly[(i + 1) % poly.length];
    sum += p1.x * p2.y - p2.x * p1.y;
  }
  return Math.abs(sum) / 2;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 点集包围盒；空集合返回 null */
export function boundsOf(points: Pt[]): Bounds | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
