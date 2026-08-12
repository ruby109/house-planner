/**
 * M5.2：**同房间碎块拼合**（见 docs/CV-PIPELINE.md 第 10 节）。
 *
 * M5 里 AI 已经能正确指出「这几块 CV 区域其实是同一间房」（`sameRoomAs`），
 * 帖数也按组只算一次了，可**几何拼不回去**：`unionAdjacentPolygons` 走的是
 * 「共享边抵消」，而被吧台 / カウンター / 垂れ壁切开的两块之间隔着**一整条墙带**
 * （test5 实测 455mm），一条共享边都没有，于是三块 LDK 各自带一个标签。
 *
 * 这个模块提供两件东西，都是纯函数、纯 mm 域、不 import opencv：
 *
 * 1. `findFakePartitions`：**假隔断判定**。沿墙段法向两侧探针采样，
 *    两侧都落在**同一组的碎块**里 → 这道墙是房间内部的吧台 / 家具隔断，可以摘；
 *    只要有一侧探到**组外房间**或**什么都探不到（建筑外）** → 这是真墙，整组放弃拼合。
 * 2. `rasterMergePolygons`：**栅格拼合**。碎块 + 桥接矩形一起打到 50mm 网格上 →
 *    填内部空洞 → 去对角夹点 → 连通域 → 边界跟踪 → 共线合并 → 顶点吸附回既有坐标。
 *    连通域 > 1（桥没搭上）时返回 `null`，**不硬拼**。
 *
 * 为什么用栅格而不是多边形布尔运算：碎块是凹多边形、可能自交，桥接矩形又会
 * 跟碎块大面积重叠——这正是 `unionAdjacentPolygons` 那套「共享边抵消」处理不了的形状。
 * 栅格化 + 洪水填充在 `cv/outline.ts` 里已经验证过一次（建筑轮廓），这里是同一个套路。
 */
import { roundPt } from '../model/defaults';
import type { Pt } from '../model/types';
import { pointInPolygon } from './cvGeometry';
import { dropCollinear } from './solve';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 探针起点 = `FACTOR × 墙厚 + EXTRA`：先跨过墙体本身，再开始找房间 */
export const PROBE_BASE_FACTOR = 0.8;
export const PROBE_BASE_EXTRA_MM = 50;
/** 探针步长 mm */
export const PROBE_STEP_MM = 25;
/**
 * 探针最远距离 mm（两个半格 = 910）。
 * 再远就会跨过整间小屋；再近就跨不过 CV 那条 455mm 的墙带（test5 实测）。
 */
export const PROBE_MAX_MM = 910;
/** 沿墙段的采样位置（中点 + 等分点） */
export const PROBE_SAMPLE_TS = [0.1, 0.3, 0.5, 0.7, 0.9] as const;
/** 短于此长度的墙段不参与假隔断判定（吧台再短也有半格） */
export const MIN_PARTITION_MM = 300;
/** 桥接带沿墙的采样步长 mm */
export const BRIDGE_STEP_MM = 100;
/**
 * 桥接带沿墙**往两头长**的上限 mm。
 * CV 往往只在墙带中间提出一小截墙段，桥不往外长就会在房间上留下豁口；
 * 长到「两侧不再都是本组碎块」自然会停，这个上限只是防御性的兜底。
 */
export const BRIDGE_MAX_GROW_MM = 6000;

/** 栅格拼合的网格边长 mm */
export const MERGE_CELL_MM = 50;
/** 拼合结果顶点吸附回既有坐标的容差 mm（栅格量化误差最多一个格） */
export const MERGE_SNAP_TOL_MM = 60;
/** 栅格上限（防御性：碎块坐标异常时不至于开出一个几百万格的数组） */
const MAX_GRID_CELLS = 4_000_000;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 只要有两个端点就行——`MmSegment` / `PxSegment` 都能直接传进来 */
export interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 一次探针的结果：撞进本组碎块 / 撞进组外房间 / 什么都没撞到（建筑外） */
export type ProbeHit =
  | { kind: 'group'; piece: number; distMm: number }
  | { kind: 'other'; distMm: number }
  | { kind: 'none' };

export interface FakePartitionOptions {
  /** 墙厚 mm（探针起点由它推出来） */
  thicknessMm: number;
  probeStepMm?: number;
  probeMaxMm?: number;
  /** 桥接带沿墙的采样步长 */
  bridgeStepMm?: number;
  /** 桥接带沿墙往两头长的上限 */
  bridgeMaxGrowMm?: number;
  /** 桥接带在探到的落点之外再多留一点，保证栅格上真的搭得住 */
  bridgeMarginMm?: number;
}

export interface FakePartitionResult {
  /** 判为组内假隔断的墙段下标（调用方负责真的从 walls 里摘掉） */
  removed: number[];
  /** 假隔断扫出来的桥接带（一条隔断可能因为中间有断点而扫出多条） */
  bridges: Pt[][];
  /**
   * `true` = 组内碎块之间存在**真墙**（某条候选隔断的一侧是组外房间或建筑外）。
   * 调用方应当放弃这一组的拼合并给用户一条 warning——硬摘会把两间屋打通。
   */
  blocked: boolean;
}

// ---------------------------------------------------------------------------
// 1. 假隔断判定
// ---------------------------------------------------------------------------

function segLength(s: Seg): number {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
}

/**
 * 从 `p` 沿 `(nx, ny)` 方向往外走，返回**第一个**撞到的房间。
 *
 * 「第一个」是这套判据安全的关键：哪怕 `probeMax` 给得很大，探针也会先撞上
 * 最近的那间屋——想穿过一间屋去够到组内的另一块是不可能的。
 */
export function probeSide(
  p: Pt,
  nx: number,
  ny: number,
  groupPolygons: readonly Pt[][],
  otherPolygons: readonly Pt[][],
  startMm: number,
  stepMm: number,
  maxMm: number,
): ProbeHit {
  const step = Math.max(1, stepMm);
  for (let d = startMm; d <= maxMm; d += step) {
    const q = { x: p.x + nx * d, y: p.y + ny * d };
    for (let i = 0; i < groupPolygons.length; i++) {
      if (pointInPolygon(q, groupPolygons[i])) return { kind: 'group', piece: i, distMm: d };
    }
    for (const poly of otherPolygons) {
      if (pointInPolygon(q, poly)) return { kind: 'other', distMm: d };
    }
  }
  return { kind: 'none' };
}

interface SweepOptions {
  start: number;
  step: number;
  maxMm: number;
  growStep: number;
  maxGrow: number;
  margin: number;
}

/**
 * 沿墙扫出桥接带。
 *
 * 逐点（沿墙每 `growStep` 一个）往两侧放探针，两侧都落进本组碎块的位置才算数，
 * 桥接带的宽度按**该点实测**的落点距离给（不是全段取一个最大值）——
 * 一刀切会在墙带窄的地方把桥捅进屋里去。
 *
 * 还会**沿墙往两头长**：CV 只在墙带中间那一截提出了墙段（test5 的吧台实测只覆盖
 * 1820mm，而两块碎块之间的整条缝有 3640mm），不往外长的话拼出来的房间会留两个
 * 455mm 深的豁口。往外长到「两侧不再都是本组」为止，天然停在墙带的尽头。
 */
function sweepBridge(
  s: Seg,
  len: number,
  ux: number,
  uy: number,
  nx: number,
  ny: number,
  groupPolygons: readonly Pt[][],
  otherPolygons: readonly Pt[][],
  opts: SweepOptions,
): Pt[][] {
  const at = (d: number): Pt => ({ x: s.x1 + ux * d, y: s.y1 + uy * d });
  const probe = (d: number): { dPlus: number; dMinus: number } | null => {
    const p = at(d);
    const plus = probeSide(p, nx, ny, groupPolygons, otherPolygons, opts.start, opts.step, opts.maxMm);
    if (plus.kind !== 'group') return null;
    const minus = probeSide(p, -nx, -ny, groupPolygons, otherPolygons, opts.start, opts.step, opts.maxMm);
    if (minus.kind !== 'group') return null;
    return { dPlus: plus.distMm + opts.margin, dMinus: minus.distMm + opts.margin };
  };

  const samples: Array<{ d: number; dPlus: number; dMinus: number }> = [];
  for (let d = 0; d <= len + 1e-6; d += opts.growStep) {
    const hit = probe(d);
    if (hit) samples.push({ d, ...hit });
  }
  if (samples.length === 0) return [];
  // 往两头长，一失手就停（不许跳过一段再接着长）
  for (let d = -opts.growStep; d >= -opts.maxGrow; d -= opts.growStep) {
    const hit = probe(d);
    if (!hit) break;
    samples.unshift({ d, ...hit });
  }
  for (let d = len + opts.growStep; d <= len + opts.maxGrow; d += opts.growStep) {
    const hit = probe(d);
    if (!hit) break;
    samples.push({ d, ...hit });
  }

  // 中间可能有断点（门口之类）：按连续段切开，各出一条桥
  const runs: Array<typeof samples> = [];
  let run: typeof samples = [];
  for (const sample of samples) {
    const prev = run[run.length - 1];
    if (prev && sample.d - prev.d > opts.growStep * 1.5) {
      if (run.length >= 2) runs.push(run);
      run = [];
    }
    run.push(sample);
  }
  if (run.length >= 2) runs.push(run);

  return runs.map((r) => [
    ...r.map((k) => ({ x: at(k.d).x + nx * k.dPlus, y: at(k.d).y + ny * k.dPlus })),
    ...[...r].reverse().map((k) => ({ x: at(k.d).x - nx * k.dMinus, y: at(k.d).y - ny * k.dMinus })),
  ]);
}

/**
 * 找出「把同一组的碎块隔开的假隔断」。
 *
 * 判据（每条墙段）：
 * 1. 沿墙取 5 个采样点（中点 + 等分点），每个点往法向两侧各放一根探针；
 * 2. **候选**：至少有一个采样点，两侧分别落进本组**不同的**碎块 → 这条墙夹在两块中间；
 * 3. **可摘**：候选墙的**所有**采样点、**两侧**都落在本组碎块里 → 吧台 / 家具隔断，摘；
 * 4. **真墙**：候选墙有任何一个采样落在组外房间或建筑外 → 不摘，并且**整组放弃拼合**
 *    （这种墙一摘就是把两间屋打通，宁可让用户看到两块同名区域）。
 *
 * 只有一侧是本组、另一侧是别处的墙是这一组的**外墙**，既不是候选也不影响结论。
 */
export function findFakePartitions(
  segments: readonly Seg[],
  groupPolygons: readonly Pt[][],
  otherPolygons: readonly Pt[][],
  opts: FakePartitionOptions,
): FakePartitionResult {
  const start = PROBE_BASE_FACTOR * Math.max(0, opts.thicknessMm) + PROBE_BASE_EXTRA_MM;
  const step = opts.probeStepMm ?? PROBE_STEP_MM;
  const maxMm = Math.max(start, opts.probeMaxMm ?? PROBE_MAX_MM);
  const sweep: SweepOptions = {
    start,
    step,
    maxMm,
    growStep: opts.bridgeStepMm ?? BRIDGE_STEP_MM,
    maxGrow: opts.bridgeMaxGrowMm ?? BRIDGE_MAX_GROW_MM,
    margin: opts.bridgeMarginMm ?? MERGE_CELL_MM,
  };

  const removed: number[] = [];
  const bridges: Pt[][] = [];
  let blocked = false;

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const len = segLength(s);
    if (len < MIN_PARTITION_MM) continue;
    const ux = (s.x2 - s.x1) / len;
    const uy = (s.y2 - s.y1) / len;
    const nx = -uy;
    const ny = ux;

    let candidate = false;
    let bad = false;

    for (const t of PROBE_SAMPLE_TS) {
      const p = { x: s.x1 + (s.x2 - s.x1) * t, y: s.y1 + (s.y2 - s.y1) * t };
      const plus = probeSide(p, nx, ny, groupPolygons, otherPolygons, start, step, maxMm);
      const minus = probeSide(p, -nx, -ny, groupPolygons, otherPolygons, start, step, maxMm);
      if (plus.kind === 'group' && minus.kind === 'group') {
        if (plus.piece !== minus.piece) candidate = true;
      } else {
        bad = true;
      }
    }

    if (!candidate) continue;
    if (bad) {
      // 这条墙确实夹在两块中间，可某些位置的另一侧是别的屋 / 室外 → 它是真墙
      blocked = true;
      continue;
    }

    const spans = sweepBridge(s, len, ux, uy, nx, ny, groupPolygons, otherPolygons, sweep);
    if (spans.length === 0) continue;
    removed.push(i);
    bridges.push(...spans);
  }

  if (blocked) return { removed: [], bridges: [], blocked: true };
  return { removed, bridges, blocked: false };
}

// ---------------------------------------------------------------------------
// 2. 栅格拼合
// ---------------------------------------------------------------------------

export interface RasterMergeOptions {
  cellMm?: number;
  snapTolMm?: number;
}

interface Grid {
  cols: number;
  rows: number;
  cell: number;
  originX: number;
  originY: number;
  filled: Uint8Array;
}

function rasterize(parts: readonly Pt[][], cell: number): Grid | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of parts) {
    for (const p of poly) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;

  // 外圈留两格空白：洪水填充要有地方从边界灌进来
  const originX = minX - 2 * cell;
  const originY = minY - 2 * cell;
  const cols = Math.ceil((maxX - originX) / cell) + 3;
  const rows = Math.ceil((maxY - originY) / cell) + 3;
  if (cols < 3 || rows < 3 || cols * rows > MAX_GRID_CELLS) return null;

  const filled = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const cy = originY + (j + 0.5) * cell;
    for (let i = 0; i < cols; i++) {
      const cx = originX + (i + 0.5) * cell;
      const q = { x: cx, y: cy };
      for (const poly of parts) {
        if (pointInPolygon(q, poly)) {
          filled[j * cols + i] = 1;
          break;
        }
      }
    }
  }
  return { cols, rows, cell, originX, originY, filled };
}

/** 填掉被完全包住的空洞（外圈洪水填充填不到的空格子） */
function fillHoles(g: Grid): void {
  const { cols, rows, filled } = g;
  const seen = new Uint8Array(cols * rows);
  const stack: number[] = [];
  const push = (i: number, j: number) => {
    if (i < 0 || j < 0 || i >= cols || j >= rows) return;
    const k = j * cols + i;
    if (seen[k] || filled[k]) return;
    seen[k] = 1;
    stack.push(k);
  };
  for (let i = 0; i < cols; i++) {
    push(i, 0);
    push(i, rows - 1);
  }
  for (let j = 0; j < rows; j++) {
    push(0, j);
    push(cols - 1, j);
  }
  while (stack.length > 0) {
    const k = stack.pop()!;
    const i = k % cols;
    const j = (k - i) / cols;
    push(i + 1, j);
    push(i - 1, j);
    push(i, j + 1);
    push(i, j - 1);
  }
  for (let k = 0; k < filled.length; k++) if (!filled[k] && !seen[k]) filled[k] = 1;
}

/**
 * 去掉「对角夹点」：2×2 里只有一对对角格子是实的。
 *
 * 这种点上边界会自交（一个角点有两进两出），跟踪不出单个环。补一个格子（50mm）
 * 就消掉了，对几何的影响可以忽略。
 */
function removePinches(g: Grid): void {
  const { cols, rows, filled } = g;
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (let j = 0; j + 1 < rows; j++) {
      for (let i = 0; i + 1 < cols; i++) {
        const a = filled[j * cols + i];
        const b = filled[j * cols + i + 1];
        const c = filled[(j + 1) * cols + i];
        const d = filled[(j + 1) * cols + i + 1];
        if (a && d && !b && !c) {
          filled[j * cols + i + 1] = 1;
          changed = true;
        } else if (b && c && !a && !d) {
          filled[j * cols + i] = 1;
          changed = true;
        }
      }
    }
    if (!changed) return;
  }
}

/** 4 连通域个数（> 1 = 桥没搭上，这一组不该硬拼） */
function countComponents(g: Grid): number {
  const { cols, rows, filled } = g;
  const seen = new Uint8Array(cols * rows);
  let count = 0;
  for (let k0 = 0; k0 < filled.length; k0++) {
    if (!filled[k0] || seen[k0]) continue;
    count += 1;
    const stack = [k0];
    seen[k0] = 1;
    while (stack.length > 0) {
      const k = stack.pop()!;
      const i = k % cols;
      const j = (k - i) / cols;
      const nb = [
        i + 1 < cols ? k + 1 : -1,
        i - 1 >= 0 ? k - 1 : -1,
        j + 1 < rows ? k + cols : -1,
        j - 1 >= 0 ? k - cols : -1,
      ];
      for (const n of nb) {
        if (n < 0 || seen[n] || !filled[n]) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
  }
  return count;
}

/**
 * 边界跟踪：把实心格子的外轮廓串成一个环（格点坐标）。
 *
 * 每条边界边都定向成「实心格在右手边」，于是每个格点最多一进一出（夹点已经消掉了），
 * 顺着 `起点 → 终点` 一路走回起点就是完整的环。
 */
function traceBoundary(g: Grid): Array<{ i: number; j: number }> | null {
  const { cols, rows, filled } = g;
  const key = (i: number, j: number) => j * (cols + 1) + i;
  const next = new Map<number, { i: number; j: number }>();
  const from = new Map<number, { i: number; j: number }>();

  const add = (ax: number, ay: number, bx: number, by: number): boolean => {
    const k = key(ax, ay);
    if (next.has(k)) return false; // 还有夹点：跟踪不出单个环
    next.set(k, { i: bx, j: by });
    from.set(k, { i: ax, j: ay });
    return true;
  };

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (!filled[j * cols + i]) continue;
      const up = j > 0 && filled[(j - 1) * cols + i];
      const down = j + 1 < rows && filled[(j + 1) * cols + i];
      const left = i > 0 && filled[j * cols + i - 1];
      const right = i + 1 < cols && filled[j * cols + i + 1];
      // 上边：向 +x（实心格在右手边 = 下方）
      if (!up && !add(i, j, i + 1, j)) return null;
      // 右边：向 +y
      if (!right && !add(i + 1, j, i + 1, j + 1)) return null;
      // 下边：向 −x
      if (!down && !add(i + 1, j + 1, i, j + 1)) return null;
      // 左边：向 −y
      if (!left && !add(i, j + 1, i, j)) return null;
    }
  }
  if (next.size === 0) return null;

  // 从最上最左的实心格的左上角起步：它一定在外轮廓上
  let startK = -1;
  for (let j = 0; j < rows && startK < 0; j++) {
    for (let i = 0; i < cols; i++) {
      if (filled[j * cols + i]) {
        startK = key(i, j);
        break;
      }
    }
  }
  if (startK < 0 || !next.has(startK)) return null;

  const ring: Array<{ i: number; j: number }> = [];
  let cur = from.get(startK)!;
  const guard = next.size + 1;
  for (let n = 0; n < guard; n++) {
    ring.push(cur);
    const step = next.get(key(cur.i, cur.j));
    if (!step) return null;
    if (key(step.i, step.j) === startK) {
      // 环闭合了；如果没走遍所有边界边，说明还有别的环（内洞没填干净）
      return ring.length === next.size ? ring : null;
    }
    cur = step;
  }
  return null;
}

/** 点到线段的垂距（退化成点时就是点距） */
function perpDist(p: Pt, a: Pt, b: Pt): number {
  const lx = b.x - a.x;
  const ly = b.y - a.y;
  const l2 = lx * lx + ly * ly;
  if (l2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * lx + (p.y - a.y) * ly) / l2;
  const c = { x: a.x + lx * t, y: a.y + ly * t };
  return Math.hypot(p.x - c.x, p.y - c.y);
}

/**
 * Ramer–Douglas–Peucker：把栅格化留下的**阶梯**压回直线。
 *
 * 非做不可：房间轮廓里只要有一条斜边（test5 的 LDK 有一条），50mm 的网格就会把它
 * 切成几十级台阶，拼出来的多边形顶点数直接冲到 50+。容差取一个格边长，
 * 恰好吃掉量化误差（斜边的栅格化偏差最多半格），又留不住任何真实的凹凸
 * （CV 的最小特征是半格 455mm，比它大一个量级）。
 *
 * 闭环的锚点取环上的第一个点：它是「最上最左实心格的左上角」，一定是个真拐角。
 */
function simplifyRing(points: readonly Pt[], epsilon: number): Pt[] {
  if (points.length < 3) return [...points];
  const chain = [...points, points[0]];
  const keep = new Uint8Array(chain.length);
  keep[0] = 1;
  keep[chain.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, chain.length - 1]];
  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    if (to - from < 2) continue;
    let best = -1;
    let bestD = epsilon;
    for (let i = from + 1; i < to; i++) {
      const d = perpDist(chain[i], chain[from], chain[to]);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) continue;
    keep[best] = 1;
    stack.push([from, best], [best, to]);
  }

  const out: Pt[] = [];
  for (let i = 0; i < chain.length - 1; i++) if (keep[i]) out.push(chain[i]);
  return out.length >= 3 ? out : [...points];
}

/** 把一个坐标吸回「碎块 / 桥接矩形本来就有的坐标」，消掉栅格量化留下的抖动 */
function snapToExisting(values: readonly number[], v: number, tol: number): number {
  let best = v;
  let bestD = tol;
  for (const c of values) {
    const d = Math.abs(c - v);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/**
 * 顶点吸附：**按边吸，不按点吸**。
 *
 * 逐条边看走向：近水平的边把两个端点的 y 拉成同一个（吸回既有 y），近垂直的边同理拉 x，
 * 斜边的端点只由它另一侧那条轴向边定坐标。挨个顶点独立吸 x/y 的话，斜边中间会被
 * 拽出一截 140mm 的假水平段（test5 的 LDK 实测），这里是刻意避开。
 */
function snapRing(
  points: readonly Pt[],
  xs: readonly number[],
  ys: readonly number[],
  tol: number,
  axisTol: number,
): Pt[] {
  const n = points.length;
  const out = points.map((p) => ({ ...p }));
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const j = (i + 1) % n;
    if (Math.abs(b.y - a.y) <= axisTol && Math.abs(b.x - a.x) > axisTol) {
      const y = snapToExisting(ys, (a.y + b.y) / 2, tol);
      out[i].y = y;
      out[j].y = y;
    } else if (Math.abs(b.x - a.x) <= axisTol && Math.abs(b.y - a.y) > axisTol) {
      const x = snapToExisting(xs, (a.x + b.x) / 2, tol);
      out[i].x = x;
      out[j].x = x;
    }
  }
  return out;
}

/** 去掉重复点（吸附之后可能出现零长边） */
function dedupe(points: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue;
    out.push(p);
  }
  while (
    out.length > 1 &&
    Math.abs(out[0].x - out[out.length - 1].x) < 1e-6 &&
    Math.abs(out[0].y - out[out.length - 1].y) < 1e-6
  ) {
    out.pop();
  }
  return out;
}

/**
 * 栅格拼合：`parts`（碎块 + 桥接矩形）→ **单个**多边形。
 *
 * 返回 `null` = 拼不出单个连通体（桥没搭上）或跟踪不出单个环——
 * 调用方应当保留碎块，**不要**硬拼。
 */
export function rasterMergePolygons(
  parts: readonly Pt[][],
  opts: RasterMergeOptions = {},
): Pt[] | null {
  const usable = parts.filter((p) => p.length >= 3);
  if (usable.length === 0) return null;
  if (usable.length === 1) return dropCollinear(usable[0].map((p) => roundPt(p)));

  const cell = opts.cellMm ?? MERGE_CELL_MM;
  const grid = rasterize(usable, cell);
  if (!grid) return null;

  fillHoles(grid);
  removePinches(grid);
  fillHoles(grid);

  if (countComponents(grid) !== 1) return null;

  const ring = traceBoundary(grid);
  if (!ring || ring.length < 4) return null;

  const xs: number[] = [];
  const ys: number[] = [];
  for (const poly of usable) {
    for (const p of poly) {
      xs.push(p.x);
      ys.push(p.y);
    }
  }
  const tol = opts.snapTolMm ?? MERGE_SNAP_TOL_MM;

  const raw = ring.map((c) => ({ x: grid.originX + c.i * cell, y: grid.originY + c.j * cell }));
  const points = snapRing(simplifyRing(raw, cell * 1.5), xs, ys, tol, cell * 1.5).map((p) => roundPt(p));
  const simplified = dropCollinear(dedupe(points));
  return simplified.length >= 3 ? simplified : null;
}
