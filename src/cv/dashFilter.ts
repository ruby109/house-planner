/**
 * M4.1：**虚线剔除**（见 docs/CV-PIPELINE.md 第 6 节）。
 *
 * 日式間取り图上的虚线**从来不是墙**：
 * - LDK 里的虚线矩形是**床暖房（地暖）**的铺设范围；
 * - 其余虚线是梁、吊柜投影、上层轮廓、可动间仕切りの軌道 之类的示意线。
 *
 * M4-CV 原来的管线会在闭运算时把虚线的一个个短横杠连成实线，再当墙提取出来，
 * 于是 LDK 被地暖框切成两半（test2 的「LDK 只剩 8 帖 + 一堆无名小房间」就是这么来的）。
 *
 * 这里出两把刀，都是**纯函数**（不 import opencv，配 vitest；cv 那边只负责喂统计量）：
 *
 * 1. `findDashChains`：闭运算**之前**，在墨迹连通块上找「短小 + 细 + 沿同一直线等间距重复 ≥3 个」
 *    的链条，整链剔除。分辨率够高、虚线的每一杠还是独立连通块时走这条。
 * 2. `pickThinComponents`：闭运算**之后**、开运算之前，把「整块都比墙细」的连通块整块剔除。
 *    网上抓的 500px 宽小图上，虚线在**源图分辨率上就已经糊成一条连续细线**了
 *    （test2 的地暖框实测：源图灰度 232 的连续线，放大到 1200px 宽后 6px 粗，
 *    而墙笔画 11.5px）——这时候「找虚线杠」根本无从找起，只能靠**粗细**分辨。
 *    之所以必须放在闭运算之后：墨迹阶段的内墙是「两条细线夹白芯」，本身也很细，
 *    闭运算把白芯填实之后墙才「变粗」，这时细/粗的分界才有意义。
 */
import type { ComponentStat } from './strokeStats';
import type { TextBox } from './types';

// ---------------------------------------------------------------------------
// 1. 虚线链（共线 + 等间距 + 重复 ≥3）
// ---------------------------------------------------------------------------

export interface DashChainParams {
  /** 墙笔画中位宽（px）；所有默认阈值都从它推导 */
  strokePx: number;
  /** 候选虚线杠的最大长边；默认 3×strokePx */
  maxDashSpanPx?: number;
  /** 候选虚线杠的最大短边（笔画粗细）；默认 0.8×strokePx */
  maxDashThicknessPx?: number;
  /** 相邻两杠中心的最大间距；默认 8×strokePx */
  maxSpacingPx?: number;
  /** 「等间距」的相对容差（吃 JPEG 压缩带来的抖动）；默认 0.45 */
  spacingTolFrac?: number;
  /** 共线判定的法向容差；默认 max(2, 0.8×strokePx) */
  offsetTolPx?: number;
  /** 成链的最少杠数；默认 3 */
  minChainLength?: number;
  /** 候选数上限（防病态图爆掉 O(n²)）；默认 1200 */
  maxCandidates?: number;
}

export interface DashChain {
  /** 链上各杠的连通块 label */
  labels: number[];
  /** 整链的包围盒（debug 叠加图里画**黄框**，与文字块的蓝框区分） */
  box: TextBox;
  /** 链的方向，[0,180) 度 */
  angleDeg: number;
  /** 相邻两杠中心的平均间距 */
  spacingPx: number;
}

interface Candidate {
  index: number;
  label: number;
  cx: number;
  cy: number;
  stat: ComponentStat;
}

function centerOf(c: ComponentStat): { cx: number; cy: number } {
  return { cx: c.x + c.w / 2, cy: c.y + c.h / 2 };
}

/**
 * 找出所有「虚线链」。
 *
 * 判据（三条全中才算）：
 * 1. **短小**：长边 < `maxDashSpanPx`（默认 3× 墙笔画宽）；
 * 2. **细**：短边 < `maxDashThicknessPx`（默认 0.8× 墙笔画宽）；
 * 3. **沿同一直线等间距重复 ≥ `minChainLength` 个**。
 *
 * 算法是贪心的：拿一对候选当种子定出方向与步长，再朝两头按步长「点名」，
 * 点得到就接上去。容差故意给得宽（沿线 45%、法向 0.8 个笔画宽），
 * 因为 JPEG 压缩会让每一杠的重心抖出一两个像素。
 */
export function findDashChains(
  components: readonly ComponentStat[],
  params: DashChainParams,
): DashChain[] {
  const stroke = Math.max(1, params.strokePx);
  const maxSpan = params.maxDashSpanPx ?? stroke * 3;
  const maxThickness = params.maxDashThicknessPx ?? stroke * 0.8;
  const maxSpacing = params.maxSpacingPx ?? stroke * 8;
  const spacingTol = params.spacingTolFrac ?? 0.45;
  const offsetTol = params.offsetTolPx ?? Math.max(2, stroke * 0.8);
  const minChain = Math.max(3, params.minChainLength ?? 3);
  const maxCandidates = params.maxCandidates ?? 1200;

  const candidates: Candidate[] = [];
  for (const c of components) {
    if (c.w <= 0 || c.h <= 0) continue;
    if (Math.max(c.w, c.h) > maxSpan) continue;
    if (Math.min(c.w, c.h) > maxThickness) continue;
    const { cx, cy } = centerOf(c);
    candidates.push({ index: candidates.length, label: c.label, cx, cy, stat: c });
    if (candidates.length >= maxCandidates) break;
  }
  if (candidates.length < minChain) return [];

  // 排序只为让结果稳定可复现（同一张图跑两遍必须一模一样）
  candidates.sort((a, b) => a.cx - b.cx || a.cy - b.cy || a.label - b.label);
  candidates.forEach((c, i) => {
    c.index = i;
  });

  const used = new Uint8Array(candidates.length);
  const chains: DashChain[] = [];

  /** 朝 (dx,dy) 方向按步长 step 点名，返回接上的候选序列 */
  const walk = (from: Candidate, dx: number, dy: number, step: number): Candidate[] => {
    const out: Candidate[] = [];
    let cur = from;
    for (let guard = 0; guard < candidates.length; guard++) {
      const tx = cur.cx + dx * step;
      const ty = cur.cy + dy * step;
      const alongTol = Math.max(2, step * spacingTol);
      let best: Candidate | null = null;
      let bestErr = Infinity;
      for (const c of candidates) {
        if (used[c.index] || c === cur || out.includes(c)) continue;
        const ex = c.cx - tx;
        const ey = c.cy - ty;
        // 分解成「沿线」「法向」两个方向分别判容差
        const along = ex * dx + ey * dy;
        const across = ex * -dy + ey * dx;
        if (Math.abs(along) > alongTol || Math.abs(across) > offsetTol) continue;
        const err = Math.abs(along) / alongTol + Math.abs(across) / offsetTol;
        if (err < bestErr) {
          bestErr = err;
          best = c;
        }
      }
      if (!best) break;
      out.push(best);
      cur = best;
    }
    return out;
  };

  for (let i = 0; i < candidates.length; i++) {
    if (used[i]) continue;
    const a = candidates[i];
    let bestChain: Candidate[] | null = null;
    let bestStep = 0;

    for (let j = i + 1; j < candidates.length; j++) {
      if (used[j]) continue;
      const b = candidates[j];
      const vx = b.cx - a.cx;
      const vy = b.cy - a.cy;
      const step = Math.hypot(vx, vy);
      if (step < 1 || step > maxSpacing) continue;
      const dx = vx / step;
      const dy = vy / step;

      const forward = walk(b, dx, dy, step);
      const backward = walk(a, -dx, -dy, step);
      const chain = [...backward.slice().reverse(), a, b, ...forward];
      if (chain.length < minChain) continue;
      if (!bestChain || chain.length > bestChain.length) {
        bestChain = chain;
        bestStep = step;
      }
    }

    if (!bestChain) continue;
    for (const c of bestChain) used[c.index] = 1;

    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const c of bestChain) {
      x0 = Math.min(x0, c.stat.x);
      y0 = Math.min(y0, c.stat.y);
      x1 = Math.max(x1, c.stat.x + c.stat.w);
      y1 = Math.max(y1, c.stat.y + c.stat.h);
    }
    const head = bestChain[0];
    const tail = bestChain[bestChain.length - 1];
    const deg = (Math.atan2(tail.cy - head.cy, tail.cx - head.cx) * 180) / Math.PI;
    chains.push({
      labels: bestChain.map((c) => c.label),
      box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      angleDeg: ((deg % 180) + 180) % 180,
      spacingPx: bestStep,
    });
  }

  return chains;
}

// ---------------------------------------------------------------------------
// 2. 「整块都比墙细」的连通块
// ---------------------------------------------------------------------------

/** 连通块 + 一个代表厚度（cv 那边用 distanceTransform 的 p90×2 算出来） */
export interface ThinComponentStat extends ComponentStat {
  /** 该块的代表厚度（px） */
  thicknessPx: number;
}

export interface ThinComponentParams {
  /** 墙笔画中位宽（px） */
  strokePx: number;
  /** 厚度低于 `strokePx × thinRatio` 判为细线；默认 0.6 */
  thinRatio?: number;
  /** 长边不到它就不管（太小的块判断不可靠，交给碎块过滤）；默认 3×strokePx */
  minSpanPx?: number;
}

/**
 * 挑出「整块都比墙细」的连通块。
 *
 * 闭运算之后，真墙（哪怕是「两条细线夹白芯」的内墙）已经被填成实心带，厚度接近墙笔画宽；
 * 而地暖框、家具轮廓、指北针、尺寸线这些**从来就是单根细线**的东西厚度不会变。
 * 所以此时用一条厚度线就能把它们整块摘掉，且不会伤到任何真墙。
 *
 * 用 p90 而不是最大值：细线的交叉点、圆角处会有几个像素偏厚，最大值不稳。
 */
export function pickThinComponents(
  components: readonly ThinComponentStat[],
  params: ThinComponentParams,
): ThinComponentStat[] {
  const stroke = Math.max(1, params.strokePx);
  const maxThickness = stroke * (params.thinRatio ?? 0.6);
  const minSpan = params.minSpanPx ?? stroke * 3;
  return components.filter(
    (c) => Math.max(c.w, c.h) >= minSpan && c.thicknessPx > 0 && c.thicknessPx < maxThickness,
  );
}

/** 连通块 → debug 用的框 */
export function componentBox(c: ComponentStat): TextBox {
  return { x: c.x, y: c.y, w: c.w, h: c.h };
}
