/**
 * wallMask 用到的**纯统计/纯几何**部分（不 import opencv，配 vitest 单测）。
 *
 * 放在单独文件里有个硬性理由：`cvRuntime` 一旦被 import 就会加载 opencv 的 WASM，
 * 而 vitest 里跑 WASM 又慢又没必要（CV 整链路的验证走 `server/cv-debug.mjs` 跑真实图）。
 */

/** 一个连通块的统计量 */
export interface ComponentStat {
  label: number;
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
  /** area / (w×h) */
  density: number;
}

// ---------------------------------------------------------------------------
// 笔画粗细分界
// ---------------------------------------------------------------------------

/**
 * 一维 Otsu：在「细笔画」和「粗笔画」两群之间找分界。
 *
 * 开运算的 kernel 就是靠它定的——**不写死像素值**，而是让数据自己说
 * 「这张图上多粗才算墙」。装饰线 / 榻榻米网格 / 家具轮廓落在细的那一群，
 * 墙体落在粗的那一群。
 *
 * 返回分界处的值（与输入同量纲）；样本太少或退化时返回 null。
 */
export function otsuSplit(values: readonly number[], binWidth = 0.25): number | null {
  if (values.length < 16) return null;
  let max = 0;
  for (const v of values) if (v > max) max = v;
  const bins = Math.max(2, Math.ceil(max / binWidth) + 1);
  if (bins > 4096) return null;

  const hist = new Float64Array(bins);
  for (const v of values) hist[Math.min(bins - 1, Math.floor(v / binWidth))]++;

  const total = values.length;
  let sumAll = 0;
  for (let i = 0; i < bins; i++) sumAll += i * hist[i];

  let wB = 0;
  let sumB = 0;
  let best = -1;
  let bestBin = -1;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      bestBin = i;
    }
  }
  if (bestBin < 0) return null;
  return (bestBin + 1) * binWidth;
}

export interface StrokeAnalysis {
  /** 「细笔画 / 墙」的分界半宽（Otsu），无法判定时 null */
  split: number | null;
  /** 墙的笔画中位宽（px） */
  strokePx: number;
}

/**
 * 从脊线半宽分布（**升序**）里推出「墙有多粗」以及「多粗才算墙」。
 *
 * 先掐掉离群的粗块（图框装饰条、没剔干净的实心区）：它们的距离值比墙大一个量级，
 * 会把 Otsu 的分界整个抬上去；中位数由细笔画主导，5 倍中位数是很宽松的上限。
 */
export function analyzeStroke(halfWidths: readonly number[]): StrokeAnalysis {
  if (halfWidths.length === 0) return { split: null, strokePx: 2 };
  const rawMedian = halfWidths[Math.floor(halfWidths.length * 0.5)];
  const cap = Math.max(rawMedian * 5, 3);
  const capped = halfWidths.filter((v) => v <= cap);
  const source = capped.length >= 16 ? capped : [...halfWidths];
  const split = otsuSplit(source);
  const wallHalf = source.filter((v) => split === null || v >= split);
  const strokePx =
    wallHalf.length > 0
      ? wallHalf[Math.floor(wallHalf.length * 0.5)] * 2
      : source[Math.floor(source.length * 0.75)] * 2;
  return { split, strokePx: Math.max(1, strokePx) };
}

// ---------------------------------------------------------------------------
// 文字剔除
// ---------------------------------------------------------------------------

export interface TextFilterParams {
  /** 文字块的最大边长 */
  maxSizePx: number;
  /** 小于它直接当噪点丢掉 */
  minAreaPx: number;
  /** 填充密度下限（太空的多半是线框，不是字） */
  minDensity: number;
}

/** 判定一个连通块是不是「文字/小标注」 */
export function isTextComponent(c: ComponentStat, p: TextFilterParams): boolean {
  if (c.area < p.minAreaPx) return false; // 噪点单独处理
  const maxDim = Math.max(c.w, c.h);
  if (maxDim > p.maxSizePx) return false;
  if (c.density < p.minDensity) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 最大连通墙体团
// ---------------------------------------------------------------------------

/**
 * 「最大连通墙体团」启发式（规格第 7 节「已知风险」，为 test1 这类整版广告图准备的）。
 *
 * 墙体在开运算之后往往被门洞切成好几块，所以不能只取「最大的那一个连通分量」。
 * 做法是先按**空间邻近**把连通块聚成团（包围盒外扩 gap 后相交就并进一团），
 * 再挑「包围盒面积 − 实心面积」最大的那一团：
 *
 * - 户型墙体：包围盒铺满整张图，但自己只是一圈细线 → 这个差值极大；
 * - 广告照片 / 深色横幅：包围盒也大，但几乎被填满 → 差值接近 0。
 */
export function pickPlanGroup(
  components: readonly ComponentStat[],
  width: number,
  height: number,
  gapPx: number,
): { keep: ComponentStat[]; dropped: number } {
  const n = components.length;
  if (n === 0) return { keep: [], dropped: 0 };

  const parent = components.map((_, i) => i);
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
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = components[i];
      const b = components[j];
      const overlapX = a.x - gapPx <= b.x + b.w && b.x - gapPx <= a.x + a.w;
      const overlapY = a.y - gapPx <= b.y + b.h && b.y - gapPx <= a.y + a.h;
      if (overlapX && overlapY) union(i, j);
    }
  }

  const groups = new Map<number, ComponentStat[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(components[i]);
    else groups.set(root, [components[i]]);
  }

  let best: ComponentStat[] = [];
  let bestScore = -Infinity;
  for (const list of groups.values()) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let ink = 0;
    for (const c of list) {
      x0 = Math.min(x0, c.x);
      y0 = Math.min(y0, c.y);
      x1 = Math.max(x1, c.x + c.w);
      y1 = Math.max(y1, c.y + c.h);
      ink += c.area;
    }
    const bboxArea = Math.max(1, (x1 - x0) * (y1 - y0));
    if (bboxArea < width * height * 0.01) continue;
    const score = bboxArea - ink;
    if (score > bestScore) {
      bestScore = score;
      best = list;
    }
  }

  if (best.length === 0) return { keep: [...components], dropped: 0 };
  return { keep: best, dropped: n - best.length };
}

/**
 * 「量尺区域」：得分最高（包围盒大、填得最空）的那一块连通块的包围盒，外扩 15%。
 * 它就是户型的墙网所在，笔画宽只在这块里量；返回 null 表示没有明显的主块，用整图。
 */
export function measureBox(
  components: readonly ComponentStat[],
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } | null {
  let best: ComponentStat | null = null;
  let bestScore = 0;
  for (const c of components) {
    const bbox = c.w * c.h;
    if (bbox < width * height * 0.02) continue;
    const score = bbox - c.area;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (!best) return null;
  const padX = Math.round(best.w * 0.15);
  const padY = Math.round(best.h * 0.15);
  const x0 = Math.max(0, best.x - padX);
  const y0 = Math.max(0, best.y - padY);
  const x1 = Math.min(width, best.x + best.w + padX);
  const y1 = Math.min(height, best.y + best.h + padY);
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
