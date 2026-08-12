/**
 * M5.1：**墙网闭合**（见 docs/CV-PIPELINE.md 第 9 节）。
 *
 * M5 的叠加图上到处是悬空线头，病根有两条：
 *
 * 1. **门洞两侧的共线墙没有跨洞合并**。`extractSegments` 的 `mergeCollinearWithGaps`
 *    只跨得过 `6× 笔画宽` 的缺口，比这更宽的门 / 引き戸就把一道墙劈成两段。
 *    可 PlanDoc 的模型里洞口是**挂在墙上的 Opening**（wallId + offset），
 *    不是墙的断点 —— 所以凡是被 `planBridges` 认成 `gap` 的缺口，
 *    两侧的墙都该合成一条连续墙（`mergeWallsAcrossGaps`）。
 *    候选后来因为宽度不合理被丢掉也照合不误：那本来就是骨架断裂，更不该留断墙。
 * 2. **骨架断裂 / T 接点容差不足**，端点差几个像素没接上垂直墙（`closeDanglingEnds`）。
 *
 * 纯 TS、不 import opencv，配 vitest。
 *
 * ## 单位：这一整个模块是**域无关**的
 *
 * 名字里的 `Px` 是历史包袱（M5.1 只在 px 域用过），实现里从来没有假设过单位：
 * 只要 `strokePx` / `attachTolPx` / 坐标都用**同一个**单位，px 或 mm 都成立。
 * 换成 mm 域时把 `pxPerMm` 传 `1` 即可 —— `minSearchMm` / `scrapMaxMm` 这两个
 * 「以 mm 表达的物理量」乘上它就回到当前单位。
 * M5.2 的 `src/ai/wallRepair.ts` 就是这么在 mm 域复用这套判据的
 * （摘掉吧台隔断之后要就地补墙网），两处的单测都在。
 */
import { segDirection } from './geometry';
import type { CvWall, PxPoint } from './types';

const EPS = 1e-9;

/** 外墙厚度经验值：与 `rooms.ts` 同一套 px ↔ mm 的粗换算 */
export const WALL_THICKNESS_MM = 140;
/** 悬空端点的搜索半径下限（mm）；实际取 `max(1.5× 墙厚, 这个值)` */
export const DANGLING_SEARCH_MIN_MM = 250;
/** 两端都悬空且短于此长度（mm）的墙段判为碎屑 */
export const SCRAP_MAX_MM = 600;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function wallLen(w: CvWall): number {
  return Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
}

/** 点到线段的距离 */
export function pointSegDist(p: PxPoint, w: { x1: number; y1: number; x2: number; y2: number }): number {
  const lx = w.x2 - w.x1;
  const ly = w.y2 - w.y1;
  const l2 = lx * lx + ly * ly;
  if (l2 < EPS) return Math.hypot(p.x - w.x1, p.y - w.y1);
  let t = ((p.x - w.x1) * lx + (p.y - w.y1) * ly) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(w.x1 + lx * t - p.x, w.y1 + ly * t - p.y);
}

function endpointOf(w: CvWall, end: 0 | 1): PxPoint {
  return end === 0 ? { x: w.x1, y: w.y1 } : { x: w.x2, y: w.y2 };
}

function setEndpoint(w: CvWall, end: 0 | 1, p: PxPoint): void {
  if (end === 0) {
    w.x1 = p.x;
    w.y1 = p.y;
  } else {
    w.x2 = p.x;
    w.y2 = p.y;
  }
}

/**
 * 复合两张 old → new 的下标映射（`-1` = 已丢弃）。
 * 管线里连着做「轮廓外剔除 → 跨洞合墙 → 碎屑剔除」，桥接段记的还是最原始的下标。
 */
export function composeIndexMaps(first: readonly number[], second: readonly number[]): number[] {
  return first.map((i) => (i < 0 ? -1 : (second[i] ?? -1)));
}

// ---------------------------------------------------------------------------
// 1. 悬空端点的度量
// ---------------------------------------------------------------------------

export interface DanglingEnd {
  /** 墙段下标 */
  wall: number;
  end: 0 | 1;
  point: PxPoint;
}

/**
 * 「自由端点」= 半径 `tolPx` 内没有**任何别的墙段的墙体**（端点或线段本体都算）。
 *
 * 理论上一张户型图的墙网不该有自由端点：墙要么连成环，要么撞在别的墙上。
 * 例外是阳台矮墙 / 开放边界那类真·自由端 —— 所以这个函数只**数**，不删。
 */
export function findDanglingEnds(walls: readonly CvWall[], tolPx: number): DanglingEnd[] {
  const out: DanglingEnd[] = [];
  for (let i = 0; i < walls.length; i++) {
    for (const end of [0, 1] as const) {
      const p = endpointOf(walls[i], end);
      let attached = false;
      for (let j = 0; j < walls.length && !attached; j++) {
        if (j === i) continue;
        if (pointSegDist(p, walls[j]) <= tolPx) attached = true;
      }
      if (!attached) out.push({ wall: i, end, point: p });
    }
  }
  return out;
}

/** `findDanglingEnds` 的计数版（叠加图/统计用） */
export function countDanglingEnds(walls: readonly CvWall[], tolPx: number): number {
  return findDanglingEnds(walls, tolPx).length;
}

// ---------------------------------------------------------------------------
// 2. 跨洞合墙
// ---------------------------------------------------------------------------

export interface GapPair {
  a: number;
  b: number;
}

export interface MergeAcrossGapsResult {
  walls: CvWall[];
  /** 旧下标 → 新下标（这一步不丢墙，所以不会有 -1） */
  indexMap: number[];
  /** 少掉的墙段数（= 旧墙数 − 新墙数） */
  mergedCount: number;
}

/**
 * 把「被缺口隔开的共线墙段」合并成一条连续墙。
 *
 * `pairs` 直接用 `planBridges` 吐出来的 `kind: 'gap'` 桥接段（那一步已经做过
 * 「角度差 ≤ 8° + 法向偏移 ≤ 1.2× 笔画宽 + 端点间距 ≤ 一个门宽」的判定），
 * 这里再按 `angleTolDeg` / `offsetTolPx` 复核一遍，防止调用方传进来乱七八糟的配对。
 *
 * 合并方式：组内按长度加权拟合一条直线 → 所有端点投影上去 → 取投影区间的两端。
 * 厚度取长度加权平均。链式的（A—洞—B—洞—C）会并成一条，这是想要的。
 */
export function mergeWallsAcrossGaps(
  walls: readonly CvWall[],
  pairs: readonly GapPair[],
  opts: { angleTolDeg?: number; offsetTolPx: number },
): MergeAcrossGapsResult {
  const n = walls.length;
  if (n === 0) return { walls: [], indexMap: [], mergedCount: 0 };

  const angleTol = opts.angleTolDeg ?? 8;
  const cosTol = Math.cos((angleTol * Math.PI) / 180);

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

  for (const pair of pairs) {
    const { a, b } = pair;
    if (a < 0 || b < 0 || a >= n || b >= n || a === b) continue;
    const wa = walls[a];
    const wb = walls[b];
    const da = segDirection(wa);
    const db = segDirection(wb);
    if (Math.abs(da.ux * db.ux + da.uy * db.uy) < cosTol) continue;
    // b 的两个端点到 a 所在直线的法向偏移
    const nx = -da.uy;
    const ny = da.ux;
    const base = wa.x1 * nx + wa.y1 * ny;
    if (Math.abs(wb.x1 * nx + wb.y1 * ny - base) > opts.offsetTolPx) continue;
    if (Math.abs(wb.x2 * nx + wb.y2 * ny - base) > opts.offsetTolPx) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  }

  // 按「组内最小原下标」的出现顺序输出，结果稳定可测
  const order: number[] = [];
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = byRoot.get(root);
    if (list) list.push(i);
    else {
      byRoot.set(root, [i]);
      order.push(root);
    }
  }

  const out: CvWall[] = [];
  const indexMap = new Array<number>(n).fill(-1);
  for (const root of order) {
    const members = byRoot.get(root)!;
    const newIndex = out.length;
    for (const i of members) indexMap[i] = newIndex;

    if (members.length === 1) {
      out.push({ ...walls[members[0]] });
      continue;
    }

    // 长度加权拟合方向 + 法向偏移
    let sx = 0;
    let sy = 0;
    for (const i of members) {
      const w = walls[i];
      const len = wallLen(w);
      const d = segDirection(w);
      sx += d.ux * len;
      sy += d.uy * len;
    }
    let norm = Math.hypot(sx, sy);
    if (norm < EPS) {
      const d = segDirection(walls[members[0]]);
      sx = d.ux;
      sy = d.uy;
      norm = 1;
    }
    const ux = sx / norm;
    const uy = sy / norm;
    const nx = -uy;
    const ny = ux;

    let offsetSum = 0;
    let weightSum = 0;
    let thickSum = 0;
    for (const i of members) {
      const w = walls[i];
      const len = Math.max(wallLen(w), EPS);
      offsetSum += ((w.x1 * nx + w.y1 * ny) + (w.x2 * nx + w.y2 * ny)) / 2 * len;
      thickSum += (w.thicknessPx || 0) * len;
      weightSum += len;
    }
    const offset = offsetSum / weightSum;
    const thickness = thickSum / weightSum;

    let tMin = Infinity;
    let tMax = -Infinity;
    for (const i of members) {
      const w = walls[i];
      for (const p of [
        { x: w.x1, y: w.y1 },
        { x: w.x2, y: w.y2 },
      ]) {
        const t = p.x * ux + p.y * uy;
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
      }
    }

    out.push({
      x1: nx * offset + ux * tMin,
      y1: ny * offset + uy * tMin,
      x2: nx * offset + ux * tMax,
      y2: ny * offset + uy * tMax,
      thicknessPx: thickness,
    });
  }

  return { walls: out, indexMap, mergedCount: n - out.length };
}

// ---------------------------------------------------------------------------
// 3. 悬空端点闭合
// ---------------------------------------------------------------------------

export interface CloseDanglingOptions {
  /** 墙笔画宽（px） */
  strokePx: number;
  /** px / mm（管线里由 `strokePx / 140mm` 推出来） */
  pxPerMm: number;
  /** 「已经接上了」的容差（px）；默认 `max(2, 1.2× 笔画宽)` */
  attachTolPx?: number;
  /** 搜索半径下限（mm），默认 250 */
  minSearchMm?: number;
  /** 碎屑长度上限（mm），默认 600 */
  scrapMaxMm?: number;
}

export interface CloseDanglingResult {
  walls: CvWall[];
  /** 被延伸到别的墙上（T 接）的端点数 */
  extended: number;
  /** 作为碎屑丢掉的墙段 */
  dropped: CvWall[];
  /** 旧下标 → 新下标（碎屑是 -1） */
  indexMap: number[];
  /** 处理前 / 处理后仍然悬空的端点数 */
  danglingBefore: number;
  danglingAfter: number;
}

/**
 * 悬空端点闭合。
 *
 * 每个自由端点（吸附距离内没有任何别的墙）：
 *
 * 1. 在 `max(1.5× 墙厚, 250mm)` 内找最近的**墙体**（非平行的才有交点）→
 *    沿自身方向延伸到两条直线的交点（T 接）。交点必须落在对方墙的实际范围内，
 *    而且不许把线段拉过头（反向 / 归零）。
 * 2. 找不到：只有当这段墙**短于 600mm 且另一端也悬空**时才当碎屑丢掉。
 *    阳台矮墙、开放边界都是合法的自由端，宁可留着记一条 warning。
 */
export function closeDanglingEnds(walls: readonly CvWall[], opts: CloseDanglingOptions): CloseDanglingResult {
  const stroke = Math.max(1, opts.strokePx);
  const pxPerMm = opts.pxPerMm > 0 ? opts.pxPerMm : stroke / WALL_THICKNESS_MM;
  const attachTol = opts.attachTolPx ?? Math.max(2, stroke * 1.2);
  const minSearch = (opts.minSearchMm ?? DANGLING_SEARCH_MIN_MM) * pxPerMm;
  const scrapMax = (opts.scrapMaxMm ?? SCRAP_MAX_MM) * pxPerMm;

  const segs: CvWall[] = walls.map((w) => ({ ...w }));
  const danglingBefore = countDanglingEnds(segs, attachTol);
  let extended = 0;

  for (let i = 0; i < segs.length; i++) {
    for (const end of [0, 1] as const) {
      const p = endpointOf(segs[i], end);

      let attached = false;
      for (let j = 0; j < segs.length && !attached; j++) {
        if (j === i) continue;
        if (pointSegDist(p, segs[j]) <= attachTol) attached = true;
      }
      if (attached) continue;

      const search = Math.max(1.5 * (segs[i].thicknessPx || stroke), minSearch);
      const di = segDirection(segs[i]);
      const other = endpointOf(segs[i], end === 0 ? 1 : 0);

      let best: PxPoint | null = null;
      let bestDist = Infinity;
      for (let j = 0; j < segs.length; j++) {
        if (j === i) continue;
        const w = segs[j];
        const dist = pointSegDist(p, w);
        if (dist > search || dist >= bestDist) continue;
        const dj = segDirection(w);
        const cross = di.ux * dj.uy - di.uy * dj.ux;
        if (Math.abs(cross) < 0.17) continue; // 夹角 < ~10°，没有可靠的交点

        // 两条直线的交点
        const rx = p.x - w.x1;
        const ry = p.y - w.y1;
        const s = (rx * dj.uy - ry * dj.ux) / cross;
        const hit = { x: p.x - di.ux * s, y: p.y - di.uy * s };
        // 端点只许移动一个搜索半径的量级
        if (Math.hypot(hit.x - p.x, hit.y - p.y) > search * 1.5) continue;
        // 交点必须落在对方墙的实际范围内（延长线上的交点不算 T 接）
        if (pointSegDist(hit, w) > attachTol) continue;
        // 不许把线段拉过头（长度归零或方向反转）
        const nl = Math.hypot(hit.x - other.x, hit.y - other.y);
        if (nl < Math.max(1, stroke * 0.5)) continue;
        const ox = p.x - other.x;
        const oy = p.y - other.y;
        if ((hit.x - other.x) * ox + (hit.y - other.y) * oy <= 0) continue;

        bestDist = dist;
        best = hit;
      }

      if (best) {
        setEndpoint(segs[i], end, best);
        extended += 1;
      }
    }
  }

  // 碎屑剔除：两端都还悬空 + 短于 600mm
  const free = new Uint8Array(segs.length * 2);
  for (const d of findDanglingEnds(segs, attachTol)) free[d.wall * 2 + d.end] = 1;

  const kept: CvWall[] = [];
  const dropped: CvWall[] = [];
  const indexMap = new Array<number>(segs.length).fill(-1);
  for (let i = 0; i < segs.length; i++) {
    const scrap = free[i * 2] === 1 && free[i * 2 + 1] === 1 && wallLen(segs[i]) < scrapMax;
    if (scrap) {
      dropped.push(segs[i]);
      continue;
    }
    indexMap[i] = kept.length;
    kept.push(segs[i]);
  }

  return {
    walls: kept,
    extended,
    dropped,
    indexMap,
    danglingBefore,
    danglingAfter: countDanglingEnds(kept, attachTol),
  };
}

/** 给外部（cv-debug / pipeline 统计）用的默认吸附容差 */
export function attachTolerancePx(strokePx: number): number {
  return Math.max(2, Math.max(1, strokePx) * 1.2);
}
