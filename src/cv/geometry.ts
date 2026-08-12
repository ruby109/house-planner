/**
 * 线段几何（**纯 TS、不 import opencv**，配 vitest 单测）。
 *
 * 全部在图片像素坐标系下工作：x 向右、y 向下。角度按 `atan2(dy, dx)` 取，
 * 归一化到 [0, 180)，所以「同一条直线的两个走向」是同一个角度。
 *
 * 角度量化与 M3.1 的求解器保持一致：与 0°/90° 偏差 ≤ `ANGLE_SNAP_TOL_DEG` 才吸附成轴向，
 * **其余角度如实保留**（斜墙不许被掰直）。
 */
import { ANGLE_SNAP_TOL_DEG } from '../ai/solve';
import type { CvWall, PxPoint } from './types';

export { ANGLE_SNAP_TOL_DEG };

/** 一条线段（像素坐标） */
export interface PxSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const EPS = 1e-9;

export function segLength(s: PxSegment): number {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
}

/** 单位方向向量，归一到右半平面（dx > 0，或 dx == 0 且 dy > 0） */
export function segDirection(s: PxSegment): { ux: number; uy: number } {
  let dx = s.x2 - s.x1;
  let dy = s.y2 - s.y1;
  const len = Math.hypot(dx, dy);
  if (len < EPS) return { ux: 1, uy: 0 };
  dx /= len;
  dy /= len;
  if (dx < -EPS || (Math.abs(dx) <= EPS && dy < 0)) {
    dx = -dx;
    dy = -dy;
  }
  return { ux: dx, uy: dy };
}

/** 线段所在直线的角度，[0, 180) 度 */
export function segAngleDeg(s: PxSegment): number {
  const { ux, uy } = segDirection(s);
  const deg = (Math.atan2(uy, ux) * 180) / Math.PI;
  return ((deg % 180) + 180) % 180;
}

/** 两个 [0,180) 角度之间的最小夹角 */
export function angleDiffDeg(a: number, b: number): number {
  const d = Math.abs(((a - b) % 180) + 180) % 180;
  return Math.min(d, 180 - d);
}

export type SegOrient = 'h' | 'v' | 'd';

/** 与 0°/90° 的偏差 ≤ tol → 轴向；否则是真实斜段 */
export function segOrient(s: PxSegment, tolDeg = ANGLE_SNAP_TOL_DEG): SegOrient {
  const a = segAngleDeg(s);
  if (a <= tolDeg || a >= 180 - tolDeg) return 'h';
  if (Math.abs(a - 90) <= tolDeg) return 'v';
  return 'd';
}

/**
 * 角度量化：近水平段拉成 y 相同、近垂直段拉成 x 相同（取两端均值），
 * **斜段原样返回**。
 */
export function quantizeSegment(s: PxSegment, tolDeg = ANGLE_SNAP_TOL_DEG): PxSegment {
  const orient = segOrient(s, tolDeg);
  if (orient === 'h') {
    const y = (s.y1 + s.y2) / 2;
    return { x1: s.x1, y1: y, x2: s.x2, y2: y };
  }
  if (orient === 'v') {
    const x = (s.x1 + s.x2) / 2;
    return { x1: x, y1: s.y1, x2: x, y2: s.y2 };
  }
  return { ...s };
}

// ---------------------------------------------------------------------------
// 共线合并
// ---------------------------------------------------------------------------

export interface MergeOptions {
  /** 同组的角度容差（度） */
  angleTolDeg: number;
  /** 同一条直线的法向偏移容差（px） */
  offsetTolPx: number;
  /** 沿线方向的缺口容差（px），小于它就接成一段 */
  gapTolPx: number;
}

interface LineCluster {
  ux: number;
  uy: number;
  /** 长度加权的方向累加（用于更新组代表方向） */
  sx: number;
  sy: number;
  offset: number;
  weight: number;
  spans: Array<{ from: number; to: number }>;
  members: PxSegment[];
}

export interface MergeResult {
  segments: PxSegment[];
  /**
   * M5：合并过程中**被跨过的那些缺口**（每段就是一条落在同一直线上的短线段）。
   *
   * 这就是门窗洞口最靠谱的来源：第 2 步「缺口 ≤ 一个门宽就接成一段」正是
   * 为了让门洞两侧保持同一道墙（洞口在 PlanDoc 里是 Opening 而不是墙的断点），
   * 而被它跨过去的那一段，按定义就是**墙上没有墨迹的地方** —— 门 / 窗 / 无门开口。
   *
   * 反过来说，`rooms.ts` 的 `planBridges` 只能看到「合并之后还剩下的」缺口，
   * 那些多半是碎片噪声。M5 之前一直找不到像样的洞口候选，病根就在这里。
   */
  gaps: PxSegment[];
}

/**
 * Hough 出来的碎线段 → 共线合并（只要合并结果）。
 *
 * 1. 按「角度 + 到原点的法向偏移」把线段聚成若干条直线（贪心，长的先当种子）；
 * 2. 每条直线上把成员投影成区间，缺口 ≤ `gapTolPx` 的合并；
 * 3. 每个区间吐一条线段（落在拟合直线上）。
 *
 * 结果按长度降序，方便调用方直接截断。
 */
export function mergeCollinearSegments(segments: readonly PxSegment[], opts: MergeOptions): PxSegment[] {
  return mergeCollinearWithGaps(segments, opts).segments;
}

/** 同上，外加**被跨过的缺口**（M5 的洞口候选来源，见 `MergeResult.gaps`） */
export function mergeCollinearWithGaps(segments: readonly PxSegment[], opts: MergeOptions): MergeResult {
  const sorted = [...segments].filter((s) => segLength(s) > EPS).sort((a, b) => segLength(b) - segLength(a));
  const clusters: LineCluster[] = [];

  for (const seg of sorted) {
    const len = segLength(seg);
    const { ux, uy } = segDirection(seg);
    const angle = segAngleDeg(seg);

    let target: LineCluster | null = null;
    for (const c of clusters) {
      const cAngle = (((Math.atan2(c.uy, c.ux) * 180) / Math.PI) % 180 + 180) % 180;
      if (angleDiffDeg(angle, cAngle) > opts.angleTolDeg) continue;
      const nx = -c.uy;
      const ny = c.ux;
      const o1 = seg.x1 * nx + seg.y1 * ny;
      const o2 = seg.x2 * nx + seg.y2 * ny;
      if (Math.abs(o1 - c.offset) > opts.offsetTolPx || Math.abs(o2 - c.offset) > opts.offsetTolPx) continue;
      target = c;
      break;
    }

    if (!target) {
      const nx = -uy;
      const ny = ux;
      const offset = ((seg.x1 * nx + seg.y1 * ny) + (seg.x2 * nx + seg.y2 * ny)) / 2;
      clusters.push({
        ux,
        uy,
        sx: ux * len,
        sy: uy * len,
        offset,
        weight: len,
        spans: [],
        members: [seg],
      });
      continue;
    }

    // 长度加权更新方向与偏移
    target.sx += ux * len;
    target.sy += uy * len;
    const norm = Math.hypot(target.sx, target.sy);
    if (norm > EPS) {
      target.ux = target.sx / norm;
      target.uy = target.sy / norm;
    }
    const nx = -target.uy;
    const ny = target.ux;
    const segOffset = ((seg.x1 * nx + seg.y1 * ny) + (seg.x2 * nx + seg.y2 * ny)) / 2;
    target.offset = (target.offset * target.weight + segOffset * len) / (target.weight + len);
    target.weight += len;
    target.members.push(seg);
  }

  const out: PxSegment[] = [];
  const gaps: PxSegment[] = [];
  for (const c of clusters) {
    const { ux, uy } = c;
    const nx = -uy;
    const ny = ux;
    const atLine = (t: number): PxPoint => ({ x: nx * c.offset + ux * t, y: ny * c.offset + uy * t });
    const spans = c.members
      .map((m) => {
        const t1 = m.x1 * ux + m.y1 * uy;
        const t2 = m.x2 * ux + m.y2 * uy;
        return { from: Math.min(t1, t2), to: Math.max(t1, t2) };
      })
      .sort((a, b) => a.from - b.from);

    let cur = { ...spans[0] };
    const merged: Array<{ from: number; to: number }> = [];
    for (let i = 1; i < spans.length; i++) {
      if (spans[i].from <= cur.to + opts.gapTolPx) {
        // 真的隔了一段空白才算缺口（区间彼此重叠时 from < to，不是缺口）
        if (spans[i].from > cur.to + EPS) {
          const a = atLine(cur.to);
          const b = atLine(spans[i].from);
          gaps.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        }
        cur.to = Math.max(cur.to, spans[i].to);
      } else {
        merged.push(cur);
        cur = { ...spans[i] };
      }
    }
    merged.push(cur);

    for (const m of merged) {
      if (m.to - m.from < EPS) continue;
      out.push({
        x1: nx * c.offset + ux * m.from,
        y1: ny * c.offset + uy * m.from,
        x2: nx * c.offset + ux * m.to,
        y2: ny * c.offset + uy * m.to,
      });
    }
  }

  return { segments: out.sort((a, b) => segLength(b) - segLength(a)), gaps };
}

// ---------------------------------------------------------------------------
// 端点吸附（角点闭合 + T 型接点）
// ---------------------------------------------------------------------------

interface EndpointRef {
  seg: number;
  end: 0 | 1;
}

function endpointOf(s: PxSegment, end: 0 | 1): PxPoint {
  return end === 0 ? { x: s.x1, y: s.y1 } : { x: s.x2, y: s.y2 };
}

function setEndpoint(s: PxSegment, end: 0 | 1, p: PxPoint): void {
  if (end === 0) {
    s.x1 = p.x;
    s.y1 = p.y;
  } else {
    s.x2 = p.x;
    s.y2 = p.y;
  }
}

/** 点到线段所在**直线**的投影（保证吸附后线段角度分毫不变） */
export function projectOnLine(p: PxPoint, s: PxSegment): PxPoint {
  const { ux, uy } = segDirection(s);
  const t = (p.x - s.x1) * ux + (p.y - s.y1) * uy;
  return { x: s.x1 + ux * t, y: s.y1 + uy * t };
}

/**
 * 端点聚类吸附：半径内的端点视为同一个角点。
 *
 * 角点位置用**最小二乘**解（到各成员所在直线的距离平方和最小）——两条垂直墙时
 * 正好是它们的交点；随后再把结果**投影回各自的直线**，保证每条线段的角度一点不变
 * （轴向段吸附完仍然严格轴向）。
 */
export function snapEndpoints(segments: readonly PxSegment[], radiusPx: number): PxSegment[] {
  const segs: PxSegment[] = segments.map((s) => ({ ...s }));
  const refs: EndpointRef[] = [];
  for (let i = 0; i < segs.length; i++) {
    refs.push({ seg: i, end: 0 }, { seg: i, end: 1 });
  }

  // 并查集聚类
  const parent = refs.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) {
      const n = parent[i];
      parent[i] = r;
      i = n;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const pts = refs.map((r) => endpointOf(segs[r.seg], r.end));
  for (let i = 0; i < refs.length; i++) {
    for (let j = i + 1; j < refs.length; j++) {
      if (refs[i].seg === refs[j].seg) continue;
      if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) <= radiusPx) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < refs.length; i++) {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  }

  for (const list of groups.values()) {
    if (list.length < 2) continue;

    // 最小二乘：min Σ (n_k·p - d_k)²
    let a = 0;
    let b = 0;
    let c = 0;
    let dx = 0;
    let dy = 0;
    for (const i of list) {
      const s = segs[refs[i].seg];
      const { ux, uy } = segDirection(s);
      const nx = -uy;
      const ny = ux;
      const d = s.x1 * nx + s.y1 * ny;
      a += nx * nx;
      b += nx * ny;
      c += ny * ny;
      dx += nx * d;
      dy += ny * d;
    }
    const det = a * c - b * b;
    let sol: PxPoint;
    if (Math.abs(det) > 1e-6) {
      sol = { x: (c * dx - b * dy) / det, y: (a * dy - b * dx) / det };
    } else {
      // 全平行：退回质心
      let sx = 0;
      let sy = 0;
      for (const i of list) {
        const p = endpointOf(segs[refs[i].seg], refs[i].end);
        sx += p.x;
        sy += p.y;
      }
      sol = { x: sx / list.length, y: sy / list.length };
    }

    for (const i of list) {
      const s = segs[refs[i].seg];
      const original = endpointOf(s, refs[i].end);
      const projected = projectOnLine(sol, s);
      // 解算失败（离原端点太远）就别动，避免把墙拉飞
      if (Math.hypot(projected.x - original.x, projected.y - original.y) > radiusPx * 2.5) continue;
      setEndpoint(s, refs[i].end, projected);
    }
  }

  return segs;
}

/**
 * T 型接点闭合：某条线段的端点离另一条线段的**本体**很近时，
 * 沿自己的方向延长/缩短到两条直线的交点。同样只沿自身直线移动，角度不变。
 */
export function joinTJunctions(segments: readonly PxSegment[], radiusPx: number): PxSegment[] {
  const segs: PxSegment[] = segments.map((s) => ({ ...s }));

  for (let i = 0; i < segs.length; i++) {
    for (const end of [0, 1] as const) {
      const p = endpointOf(segs[i], end);
      let best: PxPoint | null = null;
      let bestDist = Infinity;

      for (let j = 0; j < segs.length; j++) {
        if (j === i) continue;
        const other = segs[j];
        const di = segDirection(segs[i]);
        const dj = segDirection(other);
        const cross = di.ux * dj.uy - di.uy * dj.ux;
        if (Math.abs(cross) < 0.17) continue; // 夹角 < ~10°，不算 T 接点

        // 端点到 other 的距离（线段，不是直线）
        const lx = other.x2 - other.x1;
        const ly = other.y2 - other.y1;
        const l2 = lx * lx + ly * ly;
        if (l2 < EPS) continue;
        let t = ((p.x - other.x1) * lx + (p.y - other.y1) * ly) / l2;
        t = Math.max(0, Math.min(1, t));
        const foot = { x: other.x1 + lx * t, y: other.y1 + ly * t };
        const dist = Math.hypot(foot.x - p.x, foot.y - p.y);
        if (dist > radiusPx || dist >= bestDist) continue;

        // 两条直线的交点
        const rx = p.x - other.x1;
        const ry = p.y - other.y1;
        const s = (rx * dj.uy - ry * dj.ux) / cross;
        const hit = { x: p.x - di.ux * s, y: p.y - di.uy * s };
        if (Math.hypot(hit.x - p.x, hit.y - p.y) > radiusPx * 1.5) continue;
        bestDist = dist;
        best = hit;
      }

      if (best) setEndpoint(segs[i], end, best);
    }
  }

  return segs;
}

/** 丢掉太短的线段 */
export function dropShortSegments(segments: readonly PxSegment[], minLengthPx: number): PxSegment[] {
  return segments.filter((s) => segLength(s) >= minLengthPx);
}

// ---------------------------------------------------------------------------
// 封门洞用的连接段（rooms.ts 用）
// ---------------------------------------------------------------------------

function endpoints(w: CvWall): [PxPoint, PxPoint] {
  return [
    { x: w.x1, y: w.y1 },
    { x: w.x2, y: w.y2 },
  ];
}

function dist(a: PxPoint, b: PxPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 点到线段的距离 */
function pointSegDist(p: PxPoint, s: PxSegment): number {
  const lx = s.x2 - s.x1;
  const ly = s.y2 - s.y1;
  const l2 = lx * lx + ly * ly;
  if (l2 < 1e-9) return Math.hypot(p.x - s.x1, p.y - s.y1);
  let t = ((p.x - s.x1) * lx + (p.y - s.y1) * ly) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(s.x1 + lx * t - p.x, s.y1 + ly * t - p.y);
}

/**
 * 一条封洞用的连接段，带上「它是怎么来的」。
 *
 * M5 起这个区分是**有语义的**：`gap` 就是门窗洞口候选（两段共线的墙面对面留了个
 * 小于门宽的口子），`ray` 只是「隔墙没画到头」的补线，不是洞口。
 */
export interface PxBridge extends PxSegment {
  kind: 'gap' | 'ray';
  /** 缺口一侧的墙段下标 */
  a: number;
  /** 另一侧的墙段下标（`ray` 时是被射线撞到的那道墙） */
  b: number;
}

/**
 * 算出所有需要补的连接段。
 * 纯几何、无 cv 依赖，方便单测。
 */
export function planBridges(walls: readonly CvWall[], maxGapPx: number, strokePx: number): PxBridge[] {
  const bridges: PxBridge[] = [];
  const offsetTol = Math.max(2, strokePx * 1.2);

  // 1. 共线缺口
  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const a = walls[i];
      const b = walls[j];
      if (angleDiffDeg(segAngleDeg(a), segAngleDeg(b)) > 8) continue;

      // b 的端点到 a 所在直线的偏移
      const dir = segDirection(a);
      const nx = -dir.uy;
      const ny = dir.ux;
      const base = a.x1 * nx + a.y1 * ny;
      const ob1 = Math.abs(b.x1 * nx + b.y1 * ny - base);
      const ob2 = Math.abs(b.x2 * nx + b.y2 * ny - base);
      if (ob1 > offsetTol || ob2 > offsetTol) continue;

      let best: [PxPoint, PxPoint] | null = null;
      let bestGap = Infinity;
      for (const pa of endpoints(a)) {
        for (const pb of endpoints(b)) {
          const g = dist(pa, pb);
          if (g < bestGap) {
            bestGap = g;
            best = [pa, pb];
          }
        }
      }
      if (!best || bestGap <= 1 || bestGap > maxGapPx) continue;
      bridges.push({ x1: best[0].x, y1: best[0].y, x2: best[1].x, y2: best[1].y, kind: 'gap', a: i, b: j });
    }
  }

  // 2. 悬空端点沿自身方向打射线
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    const dir = segDirection(w);
    for (const [end, sign] of [
      [endpoints(w)[0], -1],
      [endpoints(w)[1], 1],
    ] as Array<[PxPoint, number]>) {
      // 端点已经接上别的墙了就跳过
      let attached = false;
      for (let j = 0; j < walls.length && !attached; j++) {
        if (j === i) continue;
        if (pointSegDist(end, walls[j]) <= Math.max(2, strokePx)) attached = true;
      }
      if (attached) continue;

      let hit: PxPoint | null = null;
      let hitIndex = -1;
      let hitDist = Infinity;
      for (let j = 0; j < walls.length; j++) {
        if (j === i) continue;
        const other = walls[j];
        const od = segDirection(other);
        const cross = dir.ux * od.uy - dir.uy * od.ux;
        if (Math.abs(cross) < 0.17) continue;
        const rx = end.x - other.x1;
        const ry = end.y - other.y1;
        const s = (rx * od.uy - ry * od.ux) / cross;
        const t = -s * sign; // 沿射线方向的前进距离
        if (t <= 1 || t > maxGapPx || t >= hitDist) continue;
        const p = { x: end.x + dir.ux * sign * t, y: end.y + dir.uy * sign * t };
        // 交点必须落在 other 的实际范围内
        if (pointSegDist(p, other) > Math.max(2, strokePx)) continue;
        hitDist = t;
        hit = p;
        hitIndex = j;
      }
      if (hit) bridges.push({ x1: end.x, y1: end.y, x2: hit.x, y2: hit.y, kind: 'ray', a: i, b: hitIndex });
    }
  }

  return bridges;
}
