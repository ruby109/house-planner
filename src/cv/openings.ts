/**
 * M5：门窗洞口候选（见 docs/CV-PIPELINE.md 第 7 节）。
 *
 * **纯 TS、不 import opencv**，配 vitest 单测。
 *
 * 病根回顾：M4 的洞口来自 VLM 的归一化坐标，坐标约定一出错整批洞口就飞了。
 * M5 改成从 CV 自己手里拿——`rooms.ts` 封房间时补的**共线桥接段**
 * （`planBridges` 的 `kind: 'gap'`）本来就是「两段共线的墙面对面留了个口子」，
 * 那个口子就是门 / 窗 / 无门开口，位置与宽度都是像素级实测的。
 *
 * 这里只负责三件事：
 *   1. 从桥接段里挑出 `gap`（`ray` 是「隔墙没画到头」的补线，不是洞口）；
 *   2. 判定内 / 外墙（法向两侧采样，看是不是都落在 CV 房间里）；
 *   3. 去重（三段以上共线的墙会两两配对出重复的缺口）。
 *
 * **宽度的 mm 过滤（<500 / >2730 丢弃）不在这里做**：CV 阶段还不知道比例，
 * 那一步在 `src/ai/labelFuse.ts` 里。
 */
import type { PxBridge } from './geometry';
import type { CvColumn, CvOpening, CvRoom, CvWall, PxPoint } from './types';

export interface OpeningOptions {
  /** 墙笔画宽（px），采样距离由它推导 */
  strokePx: number;
  /** CV 分出来的房间（判内外墙用）；为空时一律判成外墙 */
  rooms?: readonly CvRoom[];
  /** 柱候选：正好卡在两段墙中间的柱会被误判成缺口，落在柱上的候选直接丢掉 */
  columns?: readonly CvColumn[];
}

/** 射线法：点在多边形内（与 `ai/fuse.ts` 的同名函数同一套判据，这里避免跨层 import） */
export function pointInPolygon(p: PxPoint, poly: readonly PxPoint[]): boolean {
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

function segLen(s: { x1: number; y1: number; x2: number; y2: number }): number {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
}

function midpoint(s: { x1: number; y1: number; x2: number; y2: number }): PxPoint {
  return { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
}

/** 两条缺口是不是「同一个口子」：中点近、方向近、长度近 */
function sameGap(a: CvOpening, b: CvOpening, tol: number): boolean {
  const ma = midpoint(a);
  const mb = midpoint(b);
  if (Math.hypot(ma.x - mb.x, ma.y - mb.y) > tol) return false;
  const la = segLen(a);
  const lb = segLen(b);
  if (la < 1e-6 || lb < 1e-6) return false;
  const cos =
    Math.abs(((a.x2 - a.x1) * (b.x2 - b.x1) + (a.y2 - a.y1) * (b.y2 - b.y1)) / (la * lb));
  return cos > 0.95 && Math.abs(la - lb) <= tol;
}

/** 一堆墙的包围盒（= 图纸本身的范围，跟图片边框无关） */
export function wallBounds(walls: readonly CvWall[]): { x0: number; y0: number; x1: number; y1: number } | null {
  if (walls.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const w of walls) {
    x0 = Math.min(x0, w.x1, w.x2);
    y0 = Math.min(y0, w.y1, w.y2);
    x1 = Math.max(x1, w.x1, w.x2);
    y1 = Math.max(y1, w.y1, w.y2);
  }
  return { x0, y0, x1, y1 };
}

/**
 * 缺口是不是在**外墙**上（→ 融合器判成 window，否则判成 door）。
 *
 * 两条判据取并集：
 *
 * 1. **贴着图纸外轮廓**：缺口中点离「所有墙的包围盒」某条边不到 `edgeTolPx`。
 *    这一条覆盖了绝大多数窗——日式集合住宅的采光面就在建筑外周。
 * 2. **法向两侧都不在任何 CV 房间里**：两边都是室外。
 *
 * 刻意**不用**「有一侧不在房间里就算外墙」：低分辨率图上 CV 分不出
 * 洗面所 / トイレ / 玄関 这类小间，那些区域一律「不在任何房间里」，
 * 按那条判据一半的**内门**都会被判成窗（实测 test2：9 个缺口里 7 个被判外墙）。
 * 门比窗多得多，判错方向要选代价小的那一边。
 */
export function isExteriorGap(
  gap: { x1: number; y1: number; x2: number; y2: number },
  rooms: readonly CvRoom[],
  probeDistPx: number,
  bounds: { x0: number; y0: number; x1: number; y1: number } | null,
  edgeTolPx: number,
): boolean {
  const m = midpoint(gap);

  if (bounds) {
    const nearEdge =
      Math.min(
        Math.abs(m.x - bounds.x0),
        Math.abs(m.x - bounds.x1),
        Math.abs(m.y - bounds.y0),
        Math.abs(m.y - bounds.y1),
      ) <= edgeTolPx;
    if (nearEdge) return true;
  }

  if (rooms.length === 0) return true;
  const len = segLen(gap);
  if (len < 1e-6) return true;
  const ux = (gap.x2 - gap.x1) / len;
  const uy = (gap.y2 - gap.y1) / len;
  // 缺口线段是**沿着墙**的，所以法向就是「穿过墙」的方向
  const nx = -uy;
  const ny = ux;

  let insideCount = 0;
  for (const sign of [1, -1]) {
    const p = { x: m.x + nx * probeDistPx * sign, y: m.y + ny * probeDistPx * sign };
    if (rooms.some((r) => pointInPolygon(p, r.polygon))) insideCount += 1;
  }
  return insideCount === 0;
}

/** 缺口正好落在某根柱上 → 那不是洞口，是柱把墙断开了 */
function onColumn(gap: CvOpening, columns: readonly CvColumn[]): boolean {
  const m = midpoint(gap);
  return columns.some(
    (c) => Math.abs(m.x - c.x) <= c.wPx * 0.75 && Math.abs(m.y - c.y) <= c.hPx * 0.75,
  );
}

/** 点到线段的距离（挑归属墙用） */
function pointSegDist(px: number, py: number, w: CvWall): number {
  const lx = w.x2 - w.x1;
  const ly = w.y2 - w.y1;
  const l2 = lx * lx + ly * ly;
  if (l2 < 1e-9) return Math.hypot(px - w.x1, py - w.y1);
  let t = ((px - w.x1) * lx + (py - w.y1) * ly) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(w.x1 + lx * t - px, w.y1 + ly * t - py);
}

/** 中点离哪条墙最近（合并缺口没有现成的墙下标，只能这么找） */
function nearestWallIndex(gap: CvOpening, walls: readonly CvWall[]): number | undefined {
  const m = midpoint(gap);
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < walls.length; i++) {
    const d = pointSegDist(m.x, m.y, walls[i]);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best >= 0 ? best : undefined;
}

/**
 * 缺口 → 洞口候选。
 *
 * **两个来源**，缺一不可：
 *
 * 1. `mergeGaps`（主力）：`extractSegments` 做共线合并时**被跨过的那些空白**。
 *    门洞两侧本来就是同一道墙（洞口在 PlanDoc 里是 Opening 而不是墙的断点），
 *    合并器为此会跨过一个门宽以内的缺口 —— 被它跨过去的正是门 / 窗本身。
 * 2. `bridges`（补漏）：`extractRooms` 封房间时补的**共线**桥接段。
 *    这是「合并之后还剩下的」缺口，多半是碎片，但偶尔能捡到宽一点的开口。
 *
 * 只有 2 的时候实测在 test2 上一个像样的洞口都拿不到（9 个候选里 8 个不足 500mm），
 * 病根就是 1 已经把真门洞合并掉了。
 */
export function buildOpenings(
  bridges: readonly PxBridge[],
  walls: readonly CvWall[],
  opts: OpeningOptions,
  mergeGaps: readonly { x1: number; y1: number; x2: number; y2: number }[] = [],
): CvOpening[] {
  const stroke = Math.max(1, opts.strokePx);
  const probe = Math.max(3, stroke * 2);
  const dedupeTol = Math.max(2, stroke);
  const rooms = opts.rooms ?? [];
  const columns = opts.columns ?? [];
  const bounds = wallBounds(walls);
  // 「贴着外轮廓」的容差：一道外墙的厚度量级
  const edgeTol = Math.max(3, stroke * 1.5);

  const minLen = Math.max(2, stroke * 0.5);
  const out: CvOpening[] = [];

  /** 归属墙：两侧里更长的那一条（洞口的 offset 沿它计算最稳） */
  const pickWall = (b: PxBridge): number | undefined => {
    const a = walls[b.a];
    const c = walls[b.b];
    if (a && c) return segLen(a) >= segLen(c) ? b.a : b.b;
    if (a) return b.a;
    if (c) return b.b;
    return undefined;
  };

  const add = (g: { x1: number; y1: number; x2: number; y2: number }, onWallIndex?: number) => {
    if (segLen(g) < minLen) return;
    const candidate: CvOpening = {
      x1: g.x1,
      y1: g.y1,
      x2: g.x2,
      y2: g.y2,
      exterior: isExteriorGap(g, rooms, probe, bounds, edgeTol),
      ...(onWallIndex === undefined ? {} : { onWallIndex }),
    };
    if (onColumn(candidate, columns)) return;
    if (out.some((o) => sameGap(o, candidate, dedupeTol))) return;
    out.push(candidate);
  };

  // 主力：合并时被跨过的缺口
  for (const g of mergeGaps) add(g, nearestWallIndex({ ...g, exterior: false }, walls));
  // 补漏：封房间时补的共线桥接段
  for (const b of bridges) {
    if (b.kind !== 'gap') continue;
    add(b, pickWall(b));
  }

  // 长的排前面：下游万一要截断，先保住主要开口
  return out.sort((p, q) => segLen(q) - segLen(p));
}
