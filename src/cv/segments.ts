/**
 * 骨架 → 墙段（见 docs/CV-PIPELINE.md 第 2 节第 3、4 步）。
 *
 * `HoughLinesP` → 角度量化（±10° 内吸附轴向，斜墙保留）→ 共线合并 → 端点聚类 snap
 * → T 型接点闭合 → 厚度回填（沿线 `distanceTransform` 中位数 ×2）。
 *
 * 纯几何部分全在 `geometry.ts`（无 opencv 依赖，有单测），这里只负责跟 cv 打交道。
 */
import type { CvModule, Mat } from './cvRuntime';
import { MatScope, arrayToMask } from './cvRuntime';
import {
  dropShortSegments,
  joinTJunctions,
  mergeCollinearWithGaps,
  quantizeSegment,
  segLength,
  snapEndpoints,
  type PxSegment,
} from './geometry';
import { pruneSpurs, zhangSuenThin } from './skeleton';
import type { CvWall } from './types';

export interface SegmentOptions {
  /** 墙笔画宽（px），全部阈值都从它推导 */
  strokePx: number;
  /** 短于它的墙段丢掉；默认 max(8, stroke×2.5) */
  minWallLengthPx?: number;
}

export interface SegmentResult {
  walls: CvWall[];
  /** 细化 + 去毛刺后的骨架（0/255） */
  skeleton: Uint8Array;
  /**
   * M5：共线合并时**被跨过的缺口**（门 / 窗 / 无门开口的候选，见 `MergeResult.gaps`）。
   * 太短的（< 一个笔画宽）已经滤掉——那是骨架断点，不是洞口。
   */
  gaps: PxSegment[];
}

/** wallMask → 1px 骨架（Zhang-Suen，纯 TS） */
export function skeletonize(mask: Uint8Array, width: number, height: number, strokePx: number): Uint8Array {
  const thin = zhangSuenThin(mask, width, height);
  // 粗笔画细化后会在端头/接点长出小胡子，长度大致就是半个笔画宽
  return pruneSpurs(thin, width, height, Math.max(2, Math.round(strokePx)));
}

/** 在骨架上跑 HoughLinesP，拿到一堆碎线段 */
export function houghSegments(cv: CvModule, skeleton: Uint8Array, width: number, height: number, strokePx: number): PxSegment[] {
  const scope = new MatScope();
  try {
    const src = scope.keep(arrayToMask(cv, skeleton, width, height));
    // 故意放得很松：宁可出一堆碎段，交给 `mergeCollinearSegments` 拼回去，
    // 也不要因为门洞/接点把一整道墙的支持度打散而整条丢掉。
    const lines = scope.keep(new cv.Mat());
    const minLen = Math.max(8, strokePx);
    const maxGap = Math.max(3, strokePx * 0.8);
    const threshold = Math.max(10, Math.round(strokePx * 0.8));
    cv.HoughLinesP(src, lines, 1, Math.PI / 360, threshold, minLen, maxGap);

    // 注意：opencv.js 的 HoughLinesP 返回的是 **1 行 × N 列** 的 CV_32SC4，
    // 不是文档里常见的 N×1，所以按 data32S 的长度来数，别用 lines.rows。
    const out: PxSegment[] = [];
    const d = lines.data32S;
    for (let i = 0; i + 3 < d.length; i += 4) {
      out.push({ x1: d[i], y1: d[i + 1], x2: d[i + 2], y2: d[i + 3] });
    }
    return out;
  } finally {
    scope.dispose();
  }
}

/** 沿中心线采样 distanceTransform，中位数 ×2 就是厚度 */
export function measureThickness(dist: Float32Array, width: number, height: number, seg: PxSegment): number {
  const len = segLength(seg);
  const steps = Math.max(3, Math.round(len));
  const values: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(seg.x1 + (seg.x2 - seg.x1) * t);
    const y = Math.round(seg.y1 + (seg.y2 - seg.y1) * t);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const v = dist[y * width + x];
    if (v > 0) values.push(v);
  }
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] * 2;
}

/**
 * wallMask → 墙段。
 *
 * 注意顺序：量化必须在合并**之前**（否则两段各偏 2° 的水平线会被当成两条不同的直线），
 * 端点 snap 必须在合并**之后**（合并会改变端点位置）。
 */
export function extractSegments(
  cv: CvModule,
  wallMask: Mat,
  maskArray: Uint8Array,
  opts: SegmentOptions,
): SegmentResult {
  const width = wallMask.cols;
  const height = wallMask.rows;
  const stroke = Math.max(1, opts.strokePx);
  const minWallLength = opts.minWallLengthPx ?? Math.max(8, stroke * 1.5);

  const skeleton = skeletonize(maskArray, width, height, stroke);

  let segs = houghSegments(cv, skeleton, width, height, stroke);
  segs = segs.map((s) => quantizeSegment(s));
  // 缺口容差取一个门宽（≈ 墙厚的 6 倍）：门洞两侧本来就是**同一道墙**，
  // 洞口是 Opening 而不是墙的断点，合起来才符合 PlanDoc 的模型。
  const merged = mergeCollinearWithGaps(segs, {
    angleTolDeg: 4,
    offsetTolPx: Math.max(2, stroke * 0.5),
    gapTolPx: Math.max(4, stroke * 6),
  });
  segs = merged.segments;
  // 骨架的小断点（反锯齿、细化毛刺）也会记成缺口，按长度滤一道
  const gaps = merged.gaps.filter((g) => segLength(g) >= stroke);
  segs = segs.map((s) => quantizeSegment(s));
  segs = dropShortSegments(segs, minWallLength);
  segs = snapEndpoints(segs, Math.max(3, stroke * 1.2));
  segs = joinTJunctions(segs, Math.max(3, stroke * 1.5));
  segs = dropShortSegments(segs, minWallLength);

  // 厚度回填
  const scope = new MatScope();
  let dist: Float32Array;
  try {
    const dt = scope.keep(new cv.Mat());
    cv.distanceTransform(wallMask, dt, cv.DIST_L2, 3);
    dist = new Float32Array(dt.data32F);
  } finally {
    scope.dispose();
  }

  const walls: CvWall[] = segs.map((s) => ({
    x1: s.x1,
    y1: s.y1,
    x2: s.x2,
    y2: s.y2,
    thicknessPx: measureThickness(dist, width, height, s) || stroke,
  }));

  return { walls, skeleton, gaps };
}
