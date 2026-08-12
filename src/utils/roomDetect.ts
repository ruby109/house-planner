/**
 * 墙段图 → 封闭房间轮廓（M1d）。
 *
 * 思路（平面图的「面」枚举）：
 * 1. 把所有墙段两两求交（含 T 型接点与共线重叠），在交点处打断成子段；
 * 2. 端点按 1mm 容差归并成节点，构成平面直线图（PSLG）；
 * 3. 每条无向边拆成两条有向边（dart）。在每个节点上把出射 dart 按方位角升序排好，
 *    定义 next(u→v) = (v→w)，其中 w 是「u 在 v 的邻居环上的上一个」。
 *    沿 next 迭代即可把所有 dart 划分成若干环 —— 这些环正好是平面图的面。
 * 4. 该规则下**内部面的有符号面积为正**、外轮廓为负（见单测），据此丢掉外轮廓；
 * 5. 点在哪个房间：取所有包含该点的内部面里面积最小的一个（正确处理嵌套）。
 *
 * 全部是纯函数，无 store / React 依赖，便于 vitest 单测。
 * 输入坐标是整数 mm；中间计算用浮点，输出顶点重新取整。
 */
import type { Pt, Wall } from '../model/types';
import { pointSegProjection } from './geometry';

/** 节点归并容差 mm */
const NODE_EPS = 1;
/** 线段参数比较容差（无量纲） */
const T_EPS = 1e-9;
/** 共线判定容差（叉积，mm²）；整数坐标下真正共线时叉积恰为 0 */
const COLLINEAR_EPS = 1;
/** 小于该面积的环视为退化，不算房间：0.01 ㎡ */
export const MIN_LOOP_AREA_MM2 = 10_000;
/** 保护上限：子段数超过它就放弃（避免病态输入卡死 UI） */
const MAX_SUBSEGMENTS = 20_000;

export interface RoomLoop {
  /** 闭合环顶点（整数 mm，不重复首尾） */
  polygon: Pt[];
  /** 绝对面积 mm² */
  areaMm2: number;
}

interface Seg {
  a: Pt;
  b: Pt;
}

// ---------------------------------------------------------------------------
// 线段细分
// ---------------------------------------------------------------------------

function segLen(s: Seg): number {
  return Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
}

function lerp(s: Seg, t: number): Pt {
  return { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t };
}

/** `other` 在 `seg` 上打出的分割参数 t ∈ (0,1)（不含端点） */
function splitParams(seg: Seg, other: Seg): number[] {
  const r = { x: seg.b.x - seg.a.x, y: seg.b.y - seg.a.y };
  const s = { x: other.b.x - other.a.x, y: other.b.y - other.a.y };
  const denom = r.x * s.y - r.y * s.x;
  const qp = { x: other.a.x - seg.a.x, y: other.a.y - seg.a.y };

  if (Math.abs(denom) > T_EPS) {
    const t = (qp.x * s.y - qp.y * s.x) / denom;
    const u = (qp.x * r.y - qp.y * r.x) / denom;
    if (t > T_EPS && t < 1 - T_EPS && u >= -T_EPS && u <= 1 + T_EPS) return [t];
    return [];
  }

  // 平行：只有共线重叠才产生分割点（把 other 的端点投影回 seg）
  const out: number[] = [];
  for (const p of [other.a, other.b]) {
    const proj = pointSegProjection(p, seg.a, seg.b);
    if (proj.distance <= NODE_EPS && proj.t > T_EPS && proj.t < 1 - T_EPS) out.push(proj.t);
  }
  return out;
}

/** 把线段集合在交点处打断，返回互不内部相交的子段 */
function subdivide(segs: readonly Seg[]): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const len = segLen(seg);
    if (len <= NODE_EPS) continue;

    const ts: number[] = [0, 1];
    for (let j = 0; j < segs.length; j++) {
      if (i === j) continue;
      for (const t of splitParams(seg, segs[j])) ts.push(t);
    }
    ts.sort((a, b) => a - b);

    // 相邻参数距离不足 NODE_EPS 的合并掉
    const uniq: number[] = [];
    for (const t of ts) {
      if (uniq.length === 0 || (t - uniq[uniq.length - 1]) * len > NODE_EPS) uniq.push(t);
    }
    if (uniq.length < 2) continue;
    uniq[uniq.length - 1] = 1;

    for (let k = 1; k < uniq.length; k++) {
      out.push({ a: lerp(seg, uniq[k - 1]), b: lerp(seg, uniq[k]) });
      if (out.length > MAX_SUBSEGMENTS) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 平面图
// ---------------------------------------------------------------------------

interface Graph {
  nodes: Pt[];
  /** node → 按方位角升序排列的邻居 node 下标 */
  order: number[][];
  /** `${v}|${u}` → u 在 order[v] 中的下标 */
  posInOrder: Map<string, number>;
  /** 所有有向边 */
  darts: Array<[number, number]>;
}

function buildGraph(segs: readonly Seg[]): Graph {
  const nodes: Pt[] = [];
  const index = new Map<string, number>();
  const nodeId = (p: Pt): number => {
    const q = { x: Math.round(p.x), y: Math.round(p.y) };
    const key = `${q.x},${q.y}`;
    const hit = index.get(key);
    if (hit !== undefined) return hit;
    const id = nodes.length;
    nodes.push(q);
    index.set(key, id);
    return id;
  };

  const edgeKeys = new Set<string>();
  const adj: number[][] = [];
  const touch = (id: number) => {
    while (adj.length <= id) adj.push([]);
  };

  for (const s of segs) {
    const u = nodeId(s.a);
    const v = nodeId(s.b);
    if (u === v) continue;
    const key = u < v ? `${u}|${v}` : `${v}|${u}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    touch(u);
    touch(v);
    adj[u].push(v);
    adj[v].push(u);
  }
  touch(nodes.length - 1);

  const order = adj.map((nbrs, v) =>
    nbrs
      .slice()
      .sort(
        (a, b) =>
          Math.atan2(nodes[a].y - nodes[v].y, nodes[a].x - nodes[v].x) -
          Math.atan2(nodes[b].y - nodes[v].y, nodes[b].x - nodes[v].x),
      ),
  );

  const posInOrder = new Map<string, number>();
  const darts: Array<[number, number]> = [];
  for (let v = 0; v < order.length; v++) {
    order[v].forEach((u, i) => {
      posInOrder.set(`${v}|${u}`, i);
      darts.push([v, u]);
    });
  }

  return { nodes, order, posInOrder, darts };
}

// ---------------------------------------------------------------------------
// 多边形工具
// ---------------------------------------------------------------------------

function samePt(a: Pt, b: Pt): boolean {
  return Math.abs(a.x - b.x) <= NODE_EPS && Math.abs(a.y - b.y) <= NODE_EPS;
}

function cross3(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - a.y) - (a.y - o.y) * (b.x - a.x);
}

/** 去掉重复顶点、共线顶点与「原路折返」的悬挂枝 */
export function simplifyRing(ring: readonly Pt[]): Pt[] {
  let pts = ring.slice();
  let removed = true;
  let guard = 0;
  while (removed && pts.length > 2 && guard++ < 1000) {
    removed = false;
    let i = 0;
    while (i < pts.length && pts.length > 2) {
      const n = pts.length;
      const prev = pts[(i - 1 + n) % n];
      const cur = pts[i];
      const next = pts[(i + 1) % n];
      if (samePt(cur, next) || samePt(cur, prev) || Math.abs(cross3(prev, cur, next)) < COLLINEAR_EPS) {
        pts.splice(i, 1);
        removed = true;
      } else {
        i++;
      }
    }
  }
  return pts;
}

/** 有符号面积 mm²（鞋带公式，本文件的面遍历规则下内部面为正） */
export function signedAreaMm2(poly: readonly Pt[]): number {
  if (poly.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return sum / 2;
}

/** 射线法：点是否在多边形内部（边界视为内部的行为未定义，不影响使用） */
export function pointInPolygon(p: Pt, poly: readonly Pt[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const straddles = a.y > p.y !== b.y > p.y;
    if (!straddles) continue;
    const x = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (p.x < x) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/** 枚举墙段图围出的全部封闭区域（内部面），按面积升序 */
export function wallLoops(walls: readonly { start: Pt; end: Pt }[]): RoomLoop[] {
  const segs: Seg[] = [];
  for (const w of walls) {
    if (w.start.x === w.end.x && w.start.y === w.end.y) continue;
    segs.push({ a: w.start, b: w.end });
  }
  if (segs.length < 3) return [];

  const g = buildGraph(subdivide(segs));
  const visited = new Set<string>();
  const loops: RoomLoop[] = [];

  for (const [u0, v0] of g.darts) {
    if (visited.has(`${u0}|${v0}`)) continue;
    const cycle: number[] = [];
    let a = u0;
    let b = v0;
    let guard = 0;
    while (!visited.has(`${a}|${b}`) && guard++ <= g.darts.length) {
      visited.add(`${a}|${b}`);
      cycle.push(a);
      const nbrs = g.order[b];
      const i = g.posInOrder.get(`${b}|${a}`);
      if (i === undefined || nbrs.length === 0) break;
      const w = nbrs[(i - 1 + nbrs.length) % nbrs.length];
      a = b;
      b = w;
    }

    const polygon = simplifyRing(cycle.map((id) => g.nodes[id]));
    if (polygon.length < 3) continue;
    const signed = signedAreaMm2(polygon);
    // 只保留内部面（外轮廓在本规则下为负），并滤掉退化环
    if (signed < MIN_LOOP_AREA_MM2) continue;
    loops.push({ polygon, areaMm2: signed });
  }

  loops.sort((x, y) => x.areaMm2 - y.areaMm2);
  return loops;
}

/**
 * 求包含点 p 的最小封闭区域。找不到（点在墙围合区域之外）返回 null。
 */
export function findLoopAt(walls: readonly { start: Pt; end: Pt }[], p: Pt): RoomLoop | null {
  for (const loop of wallLoops(walls)) {
    if (pointInPolygon(p, loop.polygon)) return loop;
  }
  return null;
}

/** 便捷重载：直接吃 Wall[] */
export function findRoomPolygonAt(walls: readonly Wall[], p: Pt): Pt[] | null {
  return findLoopAt(walls, p)?.polygon ?? null;
}
