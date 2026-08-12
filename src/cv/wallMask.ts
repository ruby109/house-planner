/**
 * 从二值墨迹里抠出「墙」（见 docs/CV-PIPELINE.md 第 2 节第 2 步）。
 *
 * 顺序：**文字剔除 → 闭运算合并墙带 → 开运算只留粗笔画 → 碎块过滤 → 最大连通墙体团**。
 *
 * 与规格的两点差异（都是跑真实图调出来的）：
 * 1. 文字剔除放在**开运算之前**：日式間取り图上「洋室(1) 約7.0畳」这种小字号汉字，
 *    闭运算之后会糊成一个个 8~14px 的实心块，开完运算照样在，事后再按面积杀会误伤短墙。
 *    在墨迹阶段按连通块杀，每个汉字都是独立小块，干净利落。
 * 2. 多一步**闭运算**：内墙在这类图上是「两条细线夹一条白芯」，不先把白芯填掉，
 *    开运算会把两条细线一起抹掉，内墙就整条丢了。闭运算 kernel 严格小于门宽，不会封死门洞。
 *
 * 所有 kernel 尺寸都由 `distanceTransform` 估出来的墙笔画宽推导，**不写死像素值**。
 */
import { isColumnShape } from './columns';
import type { CvModule, Mat } from './cvRuntime';
import { MatScope } from './cvRuntime';
import {
  componentBox,
  findDashChains,
  pickThinComponents,
  type DashChain,
  type ThinComponentStat,
} from './dashFilter';
import {
  analyzeStroke,
  isTextComponent,
  measureBox,
  pickPlanGroup,
  type ComponentStat,
  type TextFilterParams,
} from './strokeStats';
import type { TextBox } from './types';

export * from './strokeStats';

/** 开运算 kernel 相对「细/粗分界宽度」的比例（调参得来，见下方注释） */
export const OPEN_KERNEL_RATIO = 0.65;

export interface WallMaskOptions {
  /** 文字块判定的最大边长（px）；默认按图幅自适应 */
  textMaxSizePx?: number;
  /** 关掉「最大连通墙体团」启发式 */
  isolatePlan?: boolean;
  /**
   * 把结果**裁到主墙体块的包围盒**内。只在确认是拼版广告图时才开：
   * 广告图里的照片纹理往往紧挨着图纸，靠邻近聚类分不开，只能按范围切。
   */
  cropToPlan?: boolean;
}

export interface WallMaskResult {
  /** 8UC1，255 = 墙 */
  mask: Mat;
  /** 墙笔画中位宽（px） */
  strokePx: number;
  /** 被判为文字/标注而剔除的块 */
  textBoxes: TextBox[];
  /** 被判为虚线链 / 整块细线而剔除的块（M4.1，debug 叠加图里画黄框） */
  dashBoxes: TextBox[];
  /**
   * M5：**形状**上像柱的实心方块（近正方形 / 0.5~2× 笔画宽 / 填充率 > 0.85）。
   *
   * 它们跟文字块一样不进 wallMask（一个实心方块细化出来的骨架只会是噪声墙段），
   * 但会被单独记下来，等墙段提完之后由 `pickColumns` 再按「贴不贴墙」筛一遍。
   */
  columnBoxes: TextBox[];
  /** 剔除的虚线链条数（`findDashChains` 命中的） */
  dashChains: number;
  /** 剔除的「整块都比墙细」的连通块数 */
  thinBlobs: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// 笔画宽估计
// ---------------------------------------------------------------------------

/**
 * 笔画宽 = 2 × 「distanceTransform 脊线上的中位数」。
 *
 * 脊线（局部最大点）上的距离值正好是该处笔画的半宽，比「所有前景像素的中位数」
 * 稳得多（后者会被笔画边缘的小值拉低）。
 */
/** 脊线上的距离值（= 该处笔画半宽），升序 */
export function ridgeHalfWidths(cv: CvModule, mask: Mat): number[] {
  const scope = new MatScope();
  try {
    const dist = scope.keep(new cv.Mat());
    cv.distanceTransform(mask, dist, cv.DIST_L2, 3);

    const dilated = scope.keep(new cv.Mat());
    const k = scope.keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    cv.dilate(dist, dilated, k);

    const values: number[] = [];
    const d = dist.data32F;
    const dm = dilated.data32F;
    for (let i = 0; i < d.length; i++) {
      if (d[i] >= 1 && d[i] >= dm[i] - 1e-4) values.push(d[i]);
    }
    values.sort((a, b) => a - b);
    return values;
  } finally {
    scope.dispose();
  }
}

export function estimateStrokeWidth(cv: CvModule, mask: Mat, percentile = 0.5): number {
  const values = ridgeHalfWidths(cv, mask);
  if (values.length === 0) return 2;
  const half = values[Math.min(values.length - 1, Math.floor(values.length * percentile))];
  return Math.max(1, half * 2);
}

// ---------------------------------------------------------------------------
// 连通块工具
// ---------------------------------------------------------------------------

function componentStats(cv: CvModule, mask: Mat, labels: Mat): ComponentStat[] {
  const scope = new MatScope();
  try {
    const stats = scope.keep(new cv.Mat());
    const centroids = scope.keep(new cv.Mat());
    const count = cv.connectedComponentsWithStats(mask, labels, stats, centroids, 8, cv.CV_32S);
    const out: ComponentStat[] = [];
    for (let i = 1; i < count; i++) {
      const x = stats.intAt(i, cv.CC_STAT_LEFT);
      const y = stats.intAt(i, cv.CC_STAT_TOP);
      const w = stats.intAt(i, cv.CC_STAT_WIDTH);
      const h = stats.intAt(i, cv.CC_STAT_HEIGHT);
      const area = stats.intAt(i, cv.CC_STAT_AREA);
      out.push({ label: i, x, y, w, h, area, density: area / Math.max(1, w * h) });
    }
    return out;
  } finally {
    scope.dispose();
  }
}

/**
 * 每个连通块的「代表厚度」= 该块内 `distanceTransform` 的 p90 × 2。
 *
 * 用直方图累加而不是「每块攒一个数组」，省内存也省 GC；bin 宽 0.5px 对
 * 「细线 / 墙」这种量级的判别绰绰有余。
 */
const THICKNESS_BINS = 64;
const THICKNESS_BIN_PX = 0.5;

function componentThickness(
  cv: CvModule,
  mask: Mat,
  labels: Mat,
  comps: readonly ComponentStat[],
): ThinComponentStat[] {
  let maxLabel = 0;
  for (const c of comps) maxLabel = Math.max(maxLabel, c.label);
  // 病态图（几万个碎块）就别算了，交给后面的碎块过滤
  if (maxLabel > 50000) return comps.map((c) => ({ ...c, thicknessPx: 0 }));

  const scope = new MatScope();
  try {
    const dist = scope.keep(new cv.Mat());
    cv.distanceTransform(mask, dist, cv.DIST_L2, 3);
    const d = dist.data32F;
    const labelData = labels.data32S;
    const hist = new Int32Array((maxLabel + 1) * THICKNESS_BINS);
    for (let i = 0; i < labelData.length; i++) {
      const l = labelData[i];
      if (l <= 0 || l > maxLabel) continue;
      const b = Math.min(THICKNESS_BINS - 1, Math.floor(d[i] / THICKNESS_BIN_PX));
      hist[l * THICKNESS_BINS + b]++;
    }

    return comps.map((c) => {
      const base = c.label * THICKNESS_BINS;
      let total = 0;
      for (let b = 0; b < THICKNESS_BINS; b++) total += hist[base + b];
      if (total === 0) return { ...c, thicknessPx: 0 };
      const target = total * 0.9;
      let acc = 0;
      let half = THICKNESS_BIN_PX;
      for (let b = 0; b < THICKNESS_BINS; b++) {
        acc += hist[base + b];
        if (acc >= target) {
          half = (b + 1) * THICKNESS_BIN_PX;
          break;
        }
      }
      return { ...c, thicknessPx: half * 2 };
    });
  } finally {
    scope.dispose();
  }
}

/** 按 label 白名单重建 mask */
function keepLabels(cv: CvModule, labels: Mat, keep: Uint8Array, width: number, height: number): Mat {
  const out = new cv.Mat(height, width, cv.CV_8UC1);
  const src = labels.data32S;
  const dst = out.data;
  for (let i = 0; i < src.length; i++) dst[i] = keep[src[i]] ? 255 : 0;
  return out;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export function buildWallMask(cv: CvModule, bin: Mat, opts: WallMaskOptions = {}): WallMaskResult {
  const warnings: string[] = [];
  const width = bin.cols;
  const height = bin.rows;
  const minSide = Math.min(width, height);
  const scope = new MatScope();

  try {
    // --- 0. 墨迹阶段的笔画宽（细线为主，用来定 kernel 的量级） ---
    const inkStroke = estimateStrokeWidth(cv, bin, 0.75);

    // --- 1. 文字 / 噪点剔除 ---
    const labels = scope.keep(new cv.Mat());
    const comps = componentStats(cv, bin, labels);
    const maxLabel = comps.length + 1;

    const textParams: TextFilterParams = {
      maxSizePx: opts.textMaxSizePx ?? Math.max(12, Math.round(minSide * 0.055)),
      minAreaPx: Math.max(3, Math.round(inkStroke * inkStroke * 0.8)),
      minDensity: 0.12,
    };

    // 大块实心区域（广告图的深色横幅 / 竖排装饰条 / 照片）不是笔画：
    // 留着会把后面的笔画宽估计整个带偏（它们的 distanceTransform 值比墙大一个量级）。
    const solidMinDim = Math.max(12, inkStroke * 6);

    const keep = new Uint8Array(maxLabel + 1);
    const textCandidates: ComponentStat[] = [];
    let solidDropped = 0;
    for (const c of comps) {
      if (c.area < textParams.minAreaPx) continue; // 噪点：不保留也不记账
      if (isTextComponent(c, textParams)) {
        textCandidates.push(c);
        continue;
      }
      if (c.density >= 0.7 && Math.min(c.w, c.h) >= solidMinDim) {
        solidDropped++;
        continue;
      }
      keep[c.label] = 1;
    }
    if (solidDropped > 0) warnings.push(`剔除了 ${solidDropped} 块大面积实心图形（版面色块 / 照片）`);

    // 「贴着结构线的小块」赦免：外墙里的**斜阴影线**每一根都是独立的小连通块，
    // 尺寸和密度跟汉字几乎一样，光按大小杀会把整道外墙掏空（test3/test4 就是这么翻车的）。
    // 判据是「是不是紧贴着长结构线」：阴影线夹在墙带的两条边线之间，房间名标注则孤零零地
    // 浮在房间中央。贴着的一律留下——它们要么本来就是墙的一部分，要么细到会被开运算带走。
    const structural = scope.keep(keepLabels(cv, labels, keep, width, height));
    const grown = scope.keep(new cv.Mat());
    const growK = Math.max(3, Math.round(inkStroke * 2) | 1);
    const growKernel = scope.keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(growK, growK)));
    cv.dilate(structural, grown, growKernel);

    const labelData = labels.data32S;
    const grownData = grown.data;
    const attachedHits = new Int32Array(maxLabel + 1);
    const isCandidate = new Uint8Array(maxLabel + 1);
    for (const c of textCandidates) isCandidate[c.label] = 1;
    for (let i = 0; i < labelData.length; i++) {
      const l = labelData[i];
      if (l > 0 && isCandidate[l] && grownData[i]) attachedHits[l]++;
    }

    const textBoxes: TextBox[] = [];
    // M5：柱候选的「豁免」。注意豁免的是**记账**，不是 mask：一个实心方块细化出来的
    // 骨架只会是噪声墙段，所以它照旧不进 wallMask（墙体几何一条都不变），
    // 只是从「文字块」里摘出来另立一档，等墙段提完再按「贴不贴墙」筛一遍。
    const columnBoxes: TextBox[] = [];
    for (const c of textCandidates) {
      const box = { x: c.x, y: c.y, w: c.w, h: c.h };
      // 形状候选先无条件记账：真柱多半**紧贴着墙**，会走下面的「贴结构线赦免」分支
      // 留在 mask 里，如果只在被剔除的那一支里记账，反而正好把真柱漏了。
      const columnish = isColumnShape(c, { strokePx: inkStroke });
      if (columnish) columnBoxes.push(box);
      if (attachedHits[c.label] / Math.max(1, c.area) >= 0.5) {
        keep[c.label] = 1;
        continue;
      }
      if (!columnish) textBoxes.push(box);
    }

    // --- 1.6 虚线链剔除（M4.1）：跟文字剔除同一阶段，**闭运算之前** ---
    //
    // 分辨率够高时，虚线的每一杠都是独立的小连通块，闭运算会把它们连成实线当墙用；
    // 必须在这之前就整链摘掉。间取り图上的虚线全是床暖房 / 梁 / 吊柜投影，没有一条是墙。
    const dashBoxes: TextBox[] = [];
    const dashChains: DashChain[] = findDashChains(
      comps.filter((c) => keep[c.label]),
      { strokePx: inkStroke },
    );
    for (const chain of dashChains) {
      for (const label of chain.labels) keep[label] = 0;
      dashBoxes.push(chain.box);
    }
    if (dashChains.length > 0) {
      warnings.push(`剔除了 ${dashChains.length} 条虚线链（床暖房 / 梁 / 吊柜投影等示意线，不是墙）`);
    }

    // 「最大连通墙体团」在这里先做一遍：整版广告图里照片二值化后的碎纹理如果留到
    // 闭运算，会被糊成大块实心区，把「墙笔画宽」的估计彻底带偏（test1 就是这样）。
    if (opts.isolatePlan !== false) {
      const inkComps = comps.filter((c) => keep[c.label]);
      const group = pickPlanGroup(inkComps, width, height, Math.max(3, Math.round(minSide * 0.02)));
      if (group.dropped > 0) {
        keep.fill(0);
        for (const c of group.keep) keep[c.label] = 1;
        warnings.push(`按「最大连通墙体团」把提取范围收窄到图纸区域（丢弃 ${group.dropped} 块版面元素）`);
      }
    }

    const ink = scope.keep(keepLabels(cv, labels, keep, width, height));

    // --- 1.5 量尺范围：只在「主墙体连通块」上量笔画宽 ---
    //
    // 拼版广告图里剩下的照片纹理、装饰框都会把 distanceTransform 的分布拉高，
    // kernel 一大就把真墙全削没了。主墙体块（包围盒大、填得最空的那一块）就是
    // 户型的墙网本身，拿它当量尺最准，别的东西再花也影响不到 kernel 的选取。
    const gaugeBox = measureBox(
      comps.filter((c) => keep[c.label]),
      width,
      height,
    );
    const gaugeRect = gaugeBox ? new cv.Rect(gaugeBox.x, gaugeBox.y, gaugeBox.width, gaugeBox.height) : null;
    const gauge = (m: Mat): number[] => {
      if (!gaugeRect) return ridgeHalfWidths(cv, m);
      const view = m.roi(gaugeRect);
      const copy = view.clone();
      view.delete();
      const out = ridgeHalfWidths(cv, copy);
      copy.delete();
      return out;
    };

    // --- 2. 闭运算：把「两条细线夹白芯」「外墙斜阴影线」的墙带填成实心 ---
    //
    // kernel 走**两趟**：第一趟只按墨迹笔画宽粗封一下，够把内墙的白芯填掉，
    // 由此估出墙带宽；第二趟按估出来的墙带宽再封一次，才能把外墙里
    // 间距十几像素的斜阴影线也填实（test3/test4 的外墙就是这么画的）。
    //
    // 门宽 ≈ 800mm ≈ 墙厚的 5~6 倍，所以 kernel 取「墙带宽」量级绝不会封死门洞；
    // 再加一道 minSide/25 的硬上限兜底。
    const closeCap = Math.max(3, Math.round(minSide / 25));
    const closeK1 = Math.max(2, Math.min(closeCap, Math.round(inkStroke)));
    const closed = scope.keep(new cv.Mat());
    const closeOnce = (k: number) => {
      const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k));
      cv.morphologyEx(ink, closed, cv.MORPH_CLOSE, kernel);
      kernel.delete();
    };

    closeOnce(closeK1);
    const pass1 = analyzeStroke(gauge(closed));
    const closeK2 = Math.max(closeK1, Math.min(closeCap, Math.round(pass1.strokePx * 0.9)));
    if (closeK2 > closeK1) closeOnce(closeK2);

    // --- 3. 笔画宽 + 粗细分界（Otsu 在脊线半宽分布上找「细笔画 / 墙」的分界）---
    const { split, strokePx } = analyzeStroke(gauge(closed));

    // --- 3.5 「整块都比墙细」的连通块整块剔除（M4.1）---
    //
    // 低分辨率图上虚线在源图里就糊成了连续细线（test2 的床暖房框：源图 500px 宽，
    // 灰度 232 的连续线），`findDashChains` 无从下手，只能靠粗细分辨。
    // 放在闭运算**之后**是必须的：墨迹阶段内墙也是细的（两条线夹白芯），
    // 闭运算填实白芯之后，「墙 = 粗、示意线 = 细」才成立。
    const closedLabels = scope.keep(new cv.Mat());
    const closedComps = componentStats(cv, closed, closedLabels);
    const thin = pickThinComponents(componentThickness(cv, closed, closedLabels, closedComps), {
      strokePx,
    });
    if (thin.length > 0) {
      const thinKeep = new Uint8Array(closedComps.length + 2);
      for (const c of closedComps) thinKeep[c.label] = 1;
      for (const c of thin) {
        thinKeep[c.label] = 0;
        dashBoxes.push(componentBox(c));
      }
      const pruned = keepLabels(cv, closedLabels, thinKeep, width, height);
      pruned.copyTo(closed);
      pruned.delete();
      warnings.push(`剔除了 ${thin.length} 块整体比墙细的线框（床暖房 / 家具 / 指北针等）`);
    }

    // --- 4. 开运算：只留粗笔画 ---
    // kernel 取分界宽度的 ~2/3：闭运算之后的墙带边缘并不平整（外墙的阴影线只是被
    // 「填」上，不是实心块），kernel 一旦逼近墙带宽，墙就会在窄处被咬断成一节一节的。
    // 另一道保险：内墙通常只有外墙的一半厚，kernel 再怎么样也不能超过墙宽的 ~0.45，
    // 否则「只剩外墙、内隔墙全丢」（test1 那种外墙特别粗的广告图最容易踩）。
    const cutStroke = split !== null ? split * 2 : strokePx * 0.7;
    const openK = Math.max(2, Math.round(Math.min(cutStroke * OPEN_KERNEL_RATIO, strokePx * 0.45)));
    const openKernel = scope.keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(openK, openK)));
    const opened = scope.keep(new cv.Mat());
    cv.morphologyEx(closed, opened, cv.MORPH_OPEN, openKernel);

    // --- 5. 碎块过滤 + 最大连通墙体团 ---
    const labels2 = scope.keep(new cv.Mat());
    const comps2 = componentStats(cv, opened, labels2);
    const keep2 = new Uint8Array(comps2.length + 2);

    const minBlobArea = Math.max(8, strokePx * strokePx * 2);
    // 开运算之后细装饰线没了，之前挂在图框上「蹭」过检的实心条会独立出来，这里再筛一次
    const survivors = comps2.filter(
      (c) => c.area >= minBlobArea && !(c.density >= 0.75 && Math.min(c.w, c.h) >= strokePx * 2.5),
    );

    if (opts.isolatePlan === false || survivors.length === 0) {
      for (const c of survivors) keep2[c.label] = 1;
    } else {
      const group = pickPlanGroup(survivors, width, height, Math.max(4, Math.round(minSide * 0.05)));
      for (const c of group.keep) keep2[c.label] = 1;
      if (group.dropped > 0) {
        warnings.push(`按「最大连通墙体团」剔除了 ${group.dropped} 块图框外的粗笔画（版面装饰 / 照片边框）`);
      }
    }

    const mask = keepLabels(cv, labels2, keep2, width, height);

    if (opts.cropToPlan && gaugeRect) {
      const box = cv.Mat.zeros(height, width, cv.CV_8UC1);
      cv.rectangle(
        box,
        new cv.Point(gaugeRect.x, gaugeRect.y),
        new cv.Point(gaugeRect.x + gaugeRect.width, gaugeRect.y + gaugeRect.height),
        new cv.Scalar(255, 255, 255, 255),
        -1,
      );
      cv.bitwise_and(mask, box, mask);
      box.delete();
      warnings.push('已把提取范围裁到图纸区域（拼版广告图）');
    }

    return {
      mask,
      strokePx,
      textBoxes,
      dashBoxes,
      columnBoxes,
      dashChains: dashChains.length,
      thinBlobs: thin.length,
      warnings,
    };
  } finally {
    scope.dispose();
  }
}
