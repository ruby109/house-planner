/**
 * M5：柱候选检测（见 docs/CV-PIPELINE.md 第 7 节）。
 *
 * **纯 TS、不 import opencv**，配 vitest 单测。
 *
 * 背景：マンション的間取り図里，柱型（PS / 柱）常常画成一个**独立的黑实心方块**，
 * 贴在墙角或墙身上。阶段 A 的验收里 test2 的黑柱就是这么丢的——它的尺寸和填充
 * 密度跟一个汉字几乎一样，`isTextComponent` 一刀切把它当文字杀掉了。
 *
 * 两段判据分两个阶段跑，因为它们需要的信息在不同时刻才有：
 *
 * | 判据 | 在哪跑 | 原因 |
 * | --- | --- | --- |
 * | 形状（近正方形 / 边长 / 填充率） | `wallMask` 的文字剔除阶段 | 那时连通块还在 |
 * | 贴墙（离最近墙段 < 1× 笔画宽） | `pipeline` 提完墙段之后 | 那时才有墙 |
 *
 * 「贴墙」这一条是整个启发式的命门：房间中央孤零零的方块基本都是文字/图例，
 * 真柱一定长在墙上。宁可漏也不要多——识别不出就空数组，不硬凑。
 */
import type { ComponentStat } from './strokeStats';
import type { CvColumn, CvWall, TextBox } from './types';

export interface ColumnShapeParams {
  /** 墙笔画宽（px）；边长的合理区间由它推导 */
  strokePx: number;
}

/** 边长下限 / 上限相对墙笔画宽的倍率 */
export const COLUMN_MIN_SIDE_RATIO = 0.5;
export const COLUMN_MAX_SIDE_RATIO = 2;
/** 填充率下限（实心块，不是笔画） */
export const COLUMN_MIN_DENSITY = 0.85;
/** 长宽比容差：min/max ≥ 它才算「接近正方形」 */
export const COLUMN_MIN_ASPECT = 0.7;
/** 贴墙判据：中心到最近墙段的距离 ≤ 这个倍数的笔画宽 */
export const COLUMN_ATTACH_RATIO = 1;

/**
 * 形状判据：接近正方形的实心块，边长在 0.5~2× 墙笔画宽之间。
 *
 * 注意用的是**墨迹阶段**的笔画宽（闭运算之前），跟 `wallMask` 里 `isTextComponent`
 * 用的是同一个量尺，两者才可比。
 */
export function isColumnShape(c: ComponentStat, p: ColumnShapeParams): boolean {
  const stroke = Math.max(1, p.strokePx);
  const long = Math.max(c.w, c.h);
  const short = Math.min(c.w, c.h);
  if (short <= 0) return false;
  if (short / long < COLUMN_MIN_ASPECT) return false;
  if (long < stroke * COLUMN_MIN_SIDE_RATIO || long > stroke * COLUMN_MAX_SIDE_RATIO) return false;
  return c.density >= COLUMN_MIN_DENSITY;
}

/** 点到线段的距离 */
function pointSegDist(px: number, py: number, w: CvWall): number {
  const lx = w.x2 - w.x1;
  const ly = w.y2 - w.y1;
  const l2 = lx * lx + ly * ly;
  if (l2 < 1e-9) return Math.hypot(px - w.x1, py - w.y1);
  let t = ((px - w.x1) * lx + (py - w.y1) * ly) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(w.x1 + lx * t - px, w.y1 + ly * t - py);
}

export interface PickColumnOptions {
  strokePx: number;
  /** 贴墙判据的倍率（默认 `COLUMN_ATTACH_RATIO`） */
  attachRatio?: number;
}

/**
 * 形状候选 + 墙段 → 柱。
 *
 * 只保留「中心离最近墙段不超过 `attachRatio × 笔画宽`」的块；
 * 顺带按中心去重（放大处理时同一根柱可能被拆成两个块）。
 */
export function pickColumns(
  boxes: readonly TextBox[],
  walls: readonly CvWall[],
  opts: PickColumnOptions,
): CvColumn[] {
  if (walls.length === 0) return [];
  const stroke = Math.max(1, opts.strokePx);
  const maxDist = stroke * (opts.attachRatio ?? COLUMN_ATTACH_RATIO);

  const out: CvColumn[] = [];
  for (const b of boxes) {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    // 距离量的是「块边缘到墙」，所以先把半边长扣掉：柱贴着墙时中心离墙线大约半个柱宽
    let nearest = Infinity;
    for (const w of walls) {
      const d = pointSegDist(cx, cy, w);
      if (d < nearest) nearest = d;
    }
    if (nearest - Math.max(b.w, b.h) / 2 > maxDist) continue;
    if (out.some((c) => Math.abs(c.x - cx) <= stroke && Math.abs(c.y - cy) <= stroke)) continue;
    out.push({ x: cx, y: cy, wPx: b.w, hPx: b.h });
  }
  return out;
}
