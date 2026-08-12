/**
 * M5.2：**摘墙之后的局部墙网修补**（见 docs/CV-PIPELINE.md 第 10 节）。
 *
 * 摘掉一条假隔断（吧台 / 家具隔断）之后，原本 T 接在它身上的墙端会突然变成悬空线头。
 * 用户明确反馈过悬空线的问题，M5.1 刚把它从 41 处压到 17 处，这一版**不能让它复发**。
 *
 * 复用 `cv/wallNet.ts` 的 `closeDanglingEnds`：那套函数是**域无关**的
 * （px 或 mm 都行，只要 `strokePx` / `pxPerMm` 按同一个单位给），
 * CV 管线在 px 域用它，这里在 mm 域用它，判据一模一样。
 *
 * **只修局部**：只有端点落在「被摘墙段附近」的墙才允许被延伸 / 当碎屑丢掉，
 * 其余墙原样保留。不这样限制的话，一张图上凡是有 `sameRoomAs` 组的，
 * 整个墙网都会被重跑一遍，改动范围远超这次修复的意图。
 */
import type { CvWall } from '../cv/types';
import { attachTolerancePx, closeDanglingEnds, countDanglingEnds, pointSegDist } from '../cv/wallNet';
import type { MmSegment } from './cvGeometry';
import type { Seg } from './roomMerge';

/** 「附近」的半径：一道墙厚的量级，与 `closeDanglingEnds` 的搜索半径同源 */
export const REPAIR_RADIUS_MIN_MM = 250;

export interface WallRepairResult {
  segments: MmSegment[];
  /** 被重新 T 接到别的墙上的端点数 */
  extended: number;
  /** 作为碎屑丢掉的墙段数 */
  dropped: number;
  /** 摘墙**之前**（原始墙网）/ 摘墙 + 修补**之后**的悬空端点数 */
  danglingBefore: number;
  danglingAfter: number;
}

function toCvWall(s: MmSegment, thicknessMm: number): CvWall {
  return { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, thicknessPx: thicknessMm };
}

/**
 * 摘墙之后的局部修补：残端要么重新 T 接到别的墙上，要么按 wallNet 的碎屑规则清掉。
 *
 * @param segments  已经摘掉假隔断之后的墙段（mm 域）
 * @param removed   被摘掉的那些墙段（只用来圈定「局部」的范围）
 * @param thicknessMm 墙厚 mm
 */
export function repairWallNet(
  segments: readonly MmSegment[],
  removed: readonly Seg[],
  thicknessMm: number,
): WallRepairResult {
  const thickness = Math.max(1, thicknessMm);
  const tol = attachTolerancePx(thickness);
  const walls = segments.map((s) => toCvWall(s, thickness));
  // 基准是**摘墙之前**的墙网：这一步唯一的验收标准就是「别比原来多出悬空线头」
  const danglingBefore = countDanglingEnds(
    [...walls, ...removed.map((r) => ({ ...r, thicknessPx: thickness }))],
    tol,
  );

  if (removed.length === 0 || segments.length === 0) {
    return {
      segments: segments.map((s) => ({ ...s })),
      extended: 0,
      dropped: 0,
      danglingBefore,
      danglingAfter: danglingBefore,
    };
  }

  const radius = Math.max(REPAIR_RADIUS_MIN_MM, thickness * 1.5);
  const affected = segments.map((s) =>
    removed.some(
      (r) =>
        pointSegDist({ x: s.x1, y: s.y1 }, r) <= radius || pointSegDist({ x: s.x2, y: s.y2 }, r) <= radius,
    ),
  );

  const closed = closeDanglingEnds(walls, {
    strokePx: thickness,
    pxPerMm: 1, // mm 域：1 单位 = 1mm
    attachTolPx: tol,
  });

  const out: MmSegment[] = [];
  let extended = 0;
  let dropped = 0;
  for (let i = 0; i < segments.length; i++) {
    const original = segments[i];
    if (!affected[i]) {
      out.push({ ...original });
      continue;
    }
    const mapped = closed.indexMap[i];
    if (mapped < 0) {
      dropped += 1;
      continue;
    }
    const w = closed.walls[mapped];
    const moved =
      Math.abs(w.x1 - original.x1) > 1e-6 ||
      Math.abs(w.y1 - original.y1) > 1e-6 ||
      Math.abs(w.x2 - original.x2) > 1e-6 ||
      Math.abs(w.y2 - original.y2) > 1e-6;
    if (moved) extended += 1;
    out.push({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, orient: original.orient });
  }

  return {
    segments: out,
    extended,
    dropped,
    danglingBefore,
    danglingAfter: countDanglingEnds(
      out.map((s) => toCvWall(s, thickness)),
      tol,
    ),
  };
}
