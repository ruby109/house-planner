/**
 * M5：**CV 几何 + AI 标注 → SolveResult**（见 docs/CV-PIPELINE.md 第 7 节）。
 *
 *   labelFuse(cvExtract, labelResult, { imageWidthPx, imageHeightPx }) → LabelFuseResult
 *
 * 与 M4 的 `fuse.ts` 的分工完全不同：
 *
 * | | fuse.ts（M4，保留供对比） | labelFuse.ts（M5，当前架构） |
 * | --- | --- | --- |
 * | 房间轮廓 | CV | CV |
 * | 墙 | CV | CV |
 * | 洞口 | **VLM 归一化坐标** | **CV 缺口候选** |
 * | 柱 | **VLM 归一化坐标** | **CV 实心块候选** |
 * | 语义挂载 | VLM 房间中心点落进哪块 CV 区域（会挂不上、会撞车） | **按编号直接对应**（不可能挂错） |
 *
 * 「按编号对应」是这一版最大的收益：AI 看到的是**画了序号圆标的图**，它只回答
 * 「几号是什么房间」，几何一个字都不给。挂载失败、坐标飞掉、多边形重叠这些
 * M3~M4 的常客在机制上不存在了。
 *
 * **纯函数**：不 import opencv，vitest 里直接跑 fixture。
 */
import type { CvColumn, CvExtract, CvOpening } from '../cv/types';
import { joinTJunctions } from '../cv/geometry';
import { newId, roundPt } from '../model/defaults';
import type { Opening, OpeningType, Pt, Structure, Wall } from '../model/types';
import { clamp, polygonAreaMm2 } from '../utils/geometry';
import { TATAMI_AREA_MM2 } from '../utils/units';
import {
  OPENING_DEFAULT_SWING,
  clampOpeningOffset,
  nearestWall,
} from '../tools/wallGeometry';
import {
  CV_EDGE_CLUSTER_TOLERANCE_MM,
  CV_THICKNESS_CORRECTION,
  MAX_MM_PER_PX,
  MIN_DIAGONAL_WALL_MM,
  MIN_MM_PER_PX,
  T_JOIN_MIN_MM,
  dropBorderWalls,
  median,
  segLen,
  segmentsToWalls,
  snapGeometry,
  toMmSegments,
  type MmSegment,
} from './cvGeometry';
import { groupRoomIndices, labelsByIndex, type LabelResult, type LabelRoom } from './labelSchema';
import { unionAdjacentPolygons } from './fuse';
import { findFakePartitions, rasterMergePolygons } from './roomMerge';
import { repairWallNet } from './wallRepair';
import {
  COLUMN_MAX_SIZE_MM,
  COLUMN_MIN_SIZE_MM,
  COLUMN_SNAP_MM,
  type PlanTransform,
  type SolveResult,
  buildRooms,
  regularizePolygon,
  resolveOpeningOffset,
  transformNormPoint,
} from './solve';
import type { RecognizedRoom } from './recognizeSchema';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 洞口宽度下限 mm：比这还窄的缺口是墙自己的断点，不是门窗 */
export const MIN_OPENING_MM = 500;
/** 洞口宽度上限 mm：1間半（2730mm）以上的口子多半是「两个房间本来就连通」 */
export const MAX_OPENING_MM = 2730;
/** 洞口离墙超过这个距离就丢（缺口本来就在墙上，给一道墙厚的余量足够） */
export const OPENING_ATTACH_MM = 600;
/** 没有任何帖数标注时的兜底：假定图纸总宽 = 底图默认宽度 9100mm */
export const FALLBACK_DRAWING_WIDTH_MM = 9100;
/** 无名区域的显示名 */
export const UNNAMED_ROOM = '房间';

// ---------------------------------------------------------------------------
// 1. 比例
// ---------------------------------------------------------------------------

export interface LabelScaleEstimate {
  /** mm / 像素 */
  mmPerPx: number;
  basis: 'tatami' | 'assumed_width';
  /** 参与估计的房间数 */
  pairs: number;
  warnings: string[];
}

/**
 * 比例估计：`mm/px = sqrt(Σ(帖数 × 1.6562e6 mm²) / Σ(对应 CV 房间的像素面积))`。
 *
 * M5 里这是**唯一**可靠来源：AI 不再输出 `drawingWidthMm`（那本来也是它瞎估的），
 * 所以图上一个帖数标注都没有时只能按「图纸总宽 = 9100mm」硬假设，
 * 并且**明确警告用户去用底图标定工具校正**——底图已经按同一个比例对齐好了，
 * 标定一段已知长度就能把整张图一次性拉正。
 */
export function estimateLabelScale(
  cv: CvExtract,
  labels: LabelResult,
  imageWidthPx: number,
): LabelScaleEstimate {
  const warnings: string[] = [];
  const byIndex = labelsByIndex(labels);
  const groups = groupRoomIndices(labels, cv.rooms.length);

  // 先按「同一个真实房间」归组：帖数每组只算一次，面积按组求和。
  // 不归组的话，被切成三块的 LDK 会把 18.4 帖算三遍（test5 实测比例大出 70%）。
  const perGroup = new Map<number, { tatami: number; area: number }>();
  for (let i = 0; i < cv.rooms.length; i++) {
    const label = byIndex.get(i + 1);
    const area = cv.rooms[i].areaPx;
    if (!label || !(area > 0)) continue;
    const root = groups.get(i + 1) ?? i + 1;
    const cell = perGroup.get(root) ?? { tatami: 0, area: 0 };
    // 组里各块的帖数应该是同一个数（AI 会照抄），取最大值防它写漏
    if (label.tatamiCount !== null && label.tatamiCount > 0) {
      cell.tatami = Math.max(cell.tatami, label.tatamiCount);
    }
    cell.area += area;
    perGroup.set(root, cell);
  }

  let tatamiSum = 0;
  let areaSum = 0;
  let pairs = 0;
  for (const cell of perGroup.values()) {
    if (!(cell.tatami > 0) || !(cell.area > 0)) continue;
    tatamiSum += cell.tatami;
    areaSum += cell.area;
    pairs += 1;
  }

  if (tatamiSum > 0 && areaSum > 0) {
    const k = Math.sqrt((tatamiSum * TATAMI_AREA_MM2) / areaSum);
    if (Number.isFinite(k) && k >= MIN_MM_PER_PX && k <= MAX_MM_PER_PX) {
      warnings.push(
        `比例来源：${pairs} 个房间的帖数标注（合计 ${round(tatamiSum, 1)} 帖）÷ 轮廓提取的像素面积 → 1px ≈ ${round(k, 2)}mm`,
      );
      return { mmPerPx: k, basis: 'tatami', pairs, warnings };
    }
    warnings.push('帖数与提取出来的面积明显矛盾，已改用假设的图纸总宽估算比例');
  }

  const k = imageWidthPx > 0 ? FALLBACK_DRAWING_WIDTH_MM / imageWidthPx : 20;
  warnings.push(
    `图上没有可用的帖数标注，比例只能按「图纸总宽 ≈ ${FALLBACK_DRAWING_WIDTH_MM}mm」假设，` +
      '实际尺寸多半不准：请用底图标定工具量一段已知长度校正（底图已按同一比例对齐）',
  );
  return {
    mmPerPx: Number.isFinite(k) && k >= MIN_MM_PER_PX && k <= MAX_MM_PER_PX ? k : 20,
    basis: 'assumed_width',
    pairs: 0,
    warnings,
  };
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// ---------------------------------------------------------------------------
// 2. 洞口候选 → Opening[]
// ---------------------------------------------------------------------------

export interface PlaceCvOpeningsResult {
  openings: Opening[];
  /** 宽度不在 [500, 2730] mm 之内而丢弃的条数 */
  widthDropped: number;
  /** 找不到宿主墙而丢弃的条数 */
  orphanDropped: number;
  warnings: string[];
}

/**
 * CV 缺口候选 → `Opening[]`。
 *
 * 类型启发式（2026-08-11 用户裁定）：**外墙缺口 = window，内墙缺口 = door**。
 * 引き戸 / 无门开口这些在像素上跟平开门长得一样（都是一段留白），CV 分不出来，
 * 交给用户在属性面板改型比瞎猜强。
 *
 * 坐标处理：候选是**原图像素**，必须跟墙段走**同一条**变换链
 * （×mmPerPx → `applyAxis` 轴映射 → 平移）。
 * ⚠ 只做 `×mmPerPx + 平移` 是不够的：轴聚类 + 455 网格吸附是**分段线性**映射，
 * 一张图从头到尾能累积出上千毫米的位移，洞口会全部落到 `nearestWall` 的搜索半径之外
 * （实测 test2：9 个候选一个都放不进去）。
 */
export function placeCvOpenings(
  candidates: readonly CvOpening[],
  walls: readonly Wall[],
  mmPerPx: number,
  transform: PlanTransform,
): PlaceCvOpeningsResult {
  const placed: Opening[] = [];
  const warnings: string[] = [];
  let widthDropped = 0;
  let orphanDropped = 0;

  for (const c of candidates) {
    const widthMm = Math.hypot(c.x2 - c.x1, c.y2 - c.y1) * mmPerPx;
    if (!(widthMm >= MIN_OPENING_MM) || widthMm > MAX_OPENING_MM) {
      widthDropped += 1;
      continue;
    }

    const center = transformNormPoint(transform, {
      x: (c.x1 + c.x2) / 2,
      y: (c.y1 + c.y2) / 2,
    });
    const hit = nearestWall(walls, center, OPENING_ATTACH_MM);
    if (!hit) {
      orphanDropped += 1;
      continue;
    }

    const wallLength = Math.hypot(hit.wall.end.x - hit.wall.start.x, hit.wall.end.y - hit.wall.start.y);
    let width = Math.round(widthMm);
    if (width > wallLength) {
      // 宿主墙比缺口还短（吸附之后被切碎了）：能压多窄压多窄，压不下去就放弃
      width = Math.floor(wallLength);
      if (width < MIN_OPENING_MM) {
        orphanDropped += 1;
        continue;
      }
    }

    // `hit.along` 是**缺口中心**在墙上的位置，而 offset 说的是洞口的起点，
    // 所以要减掉半个宽度才能把洞口摆在缺口正中（solve.ts 那边没有精确宽度，只能直接用 along）
    const offset = resolveOpeningOffset(
      placed,
      hit.wall.id,
      hit.along - width / 2,
      width,
      wallLength,
    );
    if (offset === null) {
      orphanDropped += 1;
      continue;
    }

    const type: OpeningType = c.exterior ? 'window' : 'door';
    placed.push({
      id: newId('o'),
      wallId: hit.wall.id,
      type,
      offset: clampOpeningOffset(offset, width, wallLength),
      width,
      ...(type === 'door' ? { swing: OPENING_DEFAULT_SWING } : {}),
    });
  }

  if (widthDropped > 0) {
    warnings.push(
      `已忽略 ${widthDropped} 处宽度不合理（不足 ${MIN_OPENING_MM}mm 或超过 ${MAX_OPENING_MM}mm）的墙体缺口`,
    );
  }
  if (orphanDropped > 0) {
    warnings.push(`有 ${orphanDropped} 处墙体缺口没能放进任何一道墙里，已跳过`);
  }
  return { openings: placed, widthDropped, orphanDropped, warnings };
}

// ---------------------------------------------------------------------------
// 3. 柱候选 → Structure[]
// ---------------------------------------------------------------------------

/**
 * CV 柱候选 → `Structure[]`（吸附 100mm，尺寸夹到合理区间）。
 * 位置同样走 `transformNormPoint`——理由与洞口一样，见上。
 */
export function placeCvColumns(
  candidates: readonly CvColumn[],
  mmPerPx: number,
  transform: PlanTransform,
): Structure[] {
  return candidates.map((c) => {
    const p = transformNormPoint(transform, { x: c.x, y: c.y });
    return {
      id: newId('s'),
      kind: 'column' as const,
      position: {
        x: Math.round(p.x / COLUMN_SNAP_MM) * COLUMN_SNAP_MM,
        y: Math.round(p.y / COLUMN_SNAP_MM) * COLUMN_SNAP_MM,
      },
      width: Math.round(clamp(c.wPx * mmPerPx, COLUMN_MIN_SIZE_MM, COLUMN_MAX_SIZE_MM)),
      depth: Math.round(clamp(c.hPx * mmPerPx, COLUMN_MIN_SIZE_MM, COLUMN_MAX_SIZE_MM)),
      rotation: 0,
    };
  });
}

// ---------------------------------------------------------------------------
// 4. 碎块拼回（AI 说「这几块其实是同一个房间」）
// ---------------------------------------------------------------------------

export interface MergedRoom {
  /** 语义取自哪一块 CV 房间（0-based）：拼合后取**面积最大**的碎块 */
  cvIndex: number;
  polygon: Pt[];
}

export interface MergeSplitResult {
  rooms: MergedRoom[];
  /** 被拼进别的块里、不再单独成房间的块数 */
  mergedPieces: number;
  /** 被判为组内假隔断、应当从墙里摘掉的墙段下标（labelFuse 负责真的删） */
  removedWalls: number[];
  /** 因为碎块之间有真墙而放弃拼合的组（值 = 组内编号最小的 cvIndex） */
  blockedGroups: number[];
  /** 栅格拼合之后仍是多个连通域（桥没搭上）而放弃的组 */
  brokenGroups: number[];
}

export interface MergeSplitOptions {
  /** mm 空间的墙段（吸附之后）；给了才做假隔断摘除 + 栅格拼合 */
  segments?: readonly MmSegment[];
  /** 墙厚 mm（探针起点由它推出来） */
  thicknessMm?: number;
}

/** 组内两两做「共享边抵消」并集，直到并不动为止（顺序无关，比按代表块串着并稳） */
function unionFixedPoint(parts: Pt[][]): Pt[][] {
  const out = [...parts];
  for (let guard = 0; guard < parts.length && out.length > 1; guard++) {
    let merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length && !merged; j++) {
        const union = unionAdjacentPolygons(out[i], out[j]);
        if (!union) continue;
        out[i] = union;
        out.splice(j, 1);
        merged = true;
      }
    }
    if (!merged) break;
  }
  return out;
}

/**
 * 把 AI 标成「同一个房间」的几块 CV 区域拼成一个多边形。
 *
 * 两级策略：
 *
 * 1. **共享边抵消**（`fuse.ts` 的 `unionAdjacentPolygons`）。两块真的贴在一起时这条路最准，
 *    坐标一个不动。两两试到并不动为止——按「代表块串着并」会因为顺序碰运气
 *    （test5 的 LDK：#1 跟 #2/#4 都不相邻，可 #2 跟 #4 是相邻的）。
 * 2. **摘假隔断 + 栅格拼合**（M5.2，`roomMerge.ts`）。剩下的块之间隔着一整条墙带，
 *    没有共享边可抵消：先用法向探针判出「两侧都是本组碎块」的假隔断（吧台 / 家具），
 *    摘掉它并按它扫出一条桥接矩形，再把碎块 + 桥一起栅格化拼成单个多边形。
 *
 * 任何一步拼不出单个环都**原样保留碎块**，不硬来——用户看到两块同名区域，
 * 比看到一个奇形怪状的多边形好。碎块之间是**真墙**（探针探到组外房间 / 建筑外）时
 * 连试都不试，直接记进 `blockedGroups`。
 */
export function mergeSplitRooms(
  polygons: readonly Pt[][],
  cvIndices: readonly number[],
  groups: ReadonlyMap<number, number>,
  opts: MergeSplitOptions = {},
): MergeSplitResult {
  const order: number[] = [];
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < polygons.length; i++) {
    const root = groups.get(cvIndices[i] + 1) ?? cvIndices[i] + 1;
    const list = byRoot.get(root);
    if (list) list.push(i);
    else {
      byRoot.set(root, [i]);
      order.push(root);
    }
  }

  const rooms: MergedRoom[] = [];
  const removedWalls: number[] = [];
  const blockedGroups: number[] = [];
  const brokenGroups: number[] = [];
  let mergedPieces = 0;

  for (const root of order) {
    const members = byRoot.get(root)!;
    // 语义代表：面积最大的那一块（同分时取编号小的）——大块被 AI 标错名字的概率最低
    let head = members[0];
    for (const m of members) {
      if (polygonAreaMm2(polygons[m]) > polygonAreaMm2(polygons[head])) head = m;
    }
    const headIndex = cvIndices[head];

    if (members.length === 1) {
      rooms.push({ cvIndex: headIndex, polygon: polygons[head] });
      continue;
    }

    let parts = unionFixedPoint(members.map((m) => polygons[m]));

    if (parts.length > 1 && opts.segments && opts.segments.length > 0) {
      const others: Pt[][] = [];
      for (let i = 0; i < polygons.length; i++) {
        if (!members.includes(i)) others.push(polygons[i]);
      }
      const fake = findFakePartitions(opts.segments, parts, others, {
        thicknessMm: opts.thicknessMm ?? 0,
      });
      if (fake.blocked) {
        blockedGroups.push(headIndex);
      } else if (fake.removed.length > 0) {
        const single = rasterMergePolygons([...parts, ...fake.bridges]);
        if (single) {
          parts = [single];
          removedWalls.push(...fake.removed);
        } else {
          brokenGroups.push(headIndex);
        }
      }
    }

    mergedPieces += members.length - parts.length;
    if (parts.length === 1) {
      rooms.push({ cvIndex: headIndex, polygon: parts[0] });
      continue;
    }
    // 拼不成一块：面积最大的那块挂代表编号，其余按编号顺序分配（语义只能各挂各的）
    const restIndices = [
      headIndex,
      ...members
        .map((m) => cvIndices[m])
        .filter((i) => i !== headIndex)
        .sort((a, b) => a - b),
    ];
    const ordered = [...parts].sort((a, b) => polygonAreaMm2(b) - polygonAreaMm2(a));
    for (let i = 0; i < ordered.length; i++) {
      rooms.push({ cvIndex: restIndices[i] ?? headIndex, polygon: ordered[i] });
    }
  }

  rooms.sort((a, b) => a.cvIndex - b.cvIndex);
  return { rooms, mergedPieces, removedWalls, blockedGroups, brokenGroups };
}

// ---------------------------------------------------------------------------
// 端到端
// ---------------------------------------------------------------------------

export interface LabelFuseOptions {
  imageWidthPx: number;
  imageHeightPx: number;
}

/** 融合器额外吐出来的统计（server 放进响应里给 UI 显示） */
export interface LabelFuseStats {
  cvWalls: number;
  cvRooms: number;
  /** 被判为图片外框而丢弃的墙段数 */
  borderWallsDropped: number;
  /** 被判为噪声而丢弃的短斜段数 */
  shortDiagonalsDropped: number;
  /** AI 给出了名字的房间数 */
  namedRooms: number;
  /** 被拼回同一个房间的碎块数（AI 判断「这几块其实是一间」） */
  mergedPieces: number;
  /** M5.2：被摘掉的「组内假隔断」（吧台 / 家具隔断）段数 */
  fakePartitionsRemoved: number;
  /** M5.2：摘墙**之前** / 摘墙 + 局部修补**之后**的悬空端点数（没摘墙时为 undefined） */
  danglingEndsBeforeMerge?: number;
  danglingEndsAfterMerge?: number;
  /** 带帖数标注的房间数 */
  tatamiRooms: number;
  /** CV 洞口候选数 / 实际落进墙里的数 */
  openingCandidates: number;
  openingsPlaced: number;
  /** CV 柱候选数 */
  columnCandidates: number;
  scaleBasis: LabelScaleEstimate['basis'];
  mmPerPixel: number;
}

export interface LabelFuseResult extends SolveResult {
  labelStats: LabelFuseStats;
}

/**
 * CV 几何 + AI 标注 → 可直接写进 PlanDoc 的 `SolveResult`。
 *
 * `mmPerUnit` 在这条路径下是 **mm / 图片像素**（纯 VLM 路径是 mm / 归一化单位），
 * 因为这里所有几何都以像素为原始坐标系；下游只把它当「比例」展示，不做换算。
 */
export function labelFuse(
  cv: CvExtract,
  labels: LabelResult,
  opts: LabelFuseOptions,
): LabelFuseResult {
  const warnings: string[] = [];
  const imageWidthPx = opts.imageWidthPx > 0 ? opts.imageWidthPx : cv.stats.imageWidthPx;
  const imageHeightPx = opts.imageHeightPx > 0 ? opts.imageHeightPx : cv.stats.imageHeightPx;
  const byIndex = labelsByIndex(labels);

  // 1. 墙段清洗：图片外框
  const cleaned = dropBorderWalls(cv.walls, imageWidthPx, imageHeightPx, cv.stats.wallStrokePx);
  if (cleaned.borderDropped > 0) {
    warnings.push(`已忽略 ${cleaned.borderDropped} 段贴着图片边缘的装饰边框线`);
  }

  // 2. 比例（CV 面积 + AI 帖数）
  const scale = estimateLabelScale(cv, labels, imageWidthPx);
  warnings.push(...scale.warnings);
  const mmPerPx = scale.mmPerPx;

  const cvOpenings = cv.openings ?? [];
  const cvColumns = cv.columns ?? [];
  const stats: LabelFuseStats = {
    cvWalls: cv.walls.length,
    cvRooms: cv.rooms.length,
    borderWallsDropped: cleaned.borderDropped,
    shortDiagonalsDropped: 0,
    namedRooms: 0,
    mergedPieces: 0,
    fakePartitionsRemoved: 0,
    tatamiRooms: scale.pairs,
    openingCandidates: cvOpenings.length,
    openingsPlaced: 0,
    columnCandidates: cvColumns.length,
    scaleBasis: scale.basis,
    mmPerPixel: mmPerPx,
  };

  // 3. 墙段 → mm，丢短斜段噪声
  let segments: MmSegment[] = toMmSegments(cleaned.walls, mmPerPx);
  const beforeDiagonals = segments.length;
  segments = segments.filter((s) => s.orient !== 'd' || segLen(s) >= MIN_DIAGONAL_WALL_MM);
  stats.shortDiagonalsDropped = beforeDiagonals - segments.length;
  if (stats.shortDiagonalsDropped > 0) {
    warnings.push(`已忽略 ${stats.shortDiagonalsDropped} 段过短的斜线（多半是填色边缘的锯齿）`);
  }

  // T 型接点闭合：半径取一道墙的厚度量级（厚度乘经验系数 0.8 修正）
  const thicknessMm =
    median(cv.walls.map((w) => w.thicknessPx)) * mmPerPx * CV_THICKNESS_CORRECTION;
  const joinRadius = Math.max(T_JOIN_MIN_MM, thicknessMm * 1.5);
  const joined = joinTJunctions(segments, joinRadius);
  segments = joined.map((s, i) => ({ ...s, orient: segments[i].orient }));

  // 4. 房间多边形 → mm（近轴边吸成轴向，斜边如实保留）
  const rectified: Pt[][] = [];
  const keptRooms: number[] = [];
  for (let i = 0; i < cv.rooms.length; i++) {
    const poly = regularizePolygon(cv.rooms[i].polygon, mmPerPx);
    if (poly.length < 3) continue;
    rectified.push(poly);
    keptRooms.push(i);
  }

  if (rectified.length === 0 && segments.length === 0) {
    return emptyResult(mmPerPx, [...warnings, '没有可用的墙体或房间几何'], stats);
  }

  // 5. 轴聚类 + 吸附 + 平移
  const snapped = snapGeometry(rectified, segments, CV_EDGE_CLUSTER_TOLERANCE_MM);
  // 洞口 / 柱要走**同一条**变换（像素 → mm → 轴映射 → 平移），否则会整体错位
  const transform: PlanTransform = {
    k: mmPerPx,
    xMap: snapped.xMap,
    yMap: snapped.yMap,
    translation: snapped.translation,
  };

  // 6. 房间：先把「同一个真实房间的碎块」拼回去，再按编号挂标注
  const groups = groupRoomIndices(labels, cv.rooms.length);
  const merged = mergeSplitRooms(snapped.polygons, keptRooms, groups, {
    segments: snapped.segments,
    thicknessMm,
  });
  stats.mergedPieces = merged.mergedPieces;
  if (merged.mergedPieces > 0) {
    warnings.push(
      `有 ${merged.mergedPieces} 块区域按 AI 的判断拼回了同一个房间（吧台 / 垂れ壁把房间切开了）`,
    );
  }

  // 6b. 摘掉假隔断（吧台 / 家具隔断）→ 局部重跑墙网闭合，别留下新的悬空线头
  const removedSet = new Set(merged.removedWalls);
  stats.fakePartitionsRemoved = removedSet.size;
  let finalSegments: MmSegment[] = snapped.segments;
  if (removedSet.size > 0) {
    const removedSegs = snapped.segments.filter((_, i) => removedSet.has(i));
    const repair = repairWallNet(
      snapped.segments.filter((_, i) => !removedSet.has(i)),
      removedSegs,
      thicknessMm,
    );
    finalSegments = repair.segments;
    stats.danglingEndsBeforeMerge = repair.danglingBefore;
    stats.danglingEndsAfterMerge = repair.danglingAfter;
    warnings.push(
      `已摘除 ${removedSet.size} 段吧台 / 家具隔断（它们把同一个房间切成了几块）` +
        `${repair.extended > 0 ? `，${repair.extended} 处残端已重新接回墙网` : ''}` +
        `${repair.dropped > 0 ? `，${repair.dropped} 段残屑已清理` : ''}`,
    );
    if (repair.danglingAfter > repair.danglingBefore) {
      warnings.push(
        `摘除隔断后多出了 ${repair.danglingAfter - repair.danglingBefore} 处悬空墙端，请人工检查`,
      );
    }
  }
  const walls = segmentsToWalls(finalSegments);

  // 探针探到组外房间 / 建筑外：那是真墙，摘了就是把两间屋打通，一律保留分块
  const blockedNames = new Set<string>();
  for (const idx of merged.blockedGroups) {
    blockedNames.add(byIndex.get(idx + 1)?.name ?? UNNAMED_ROOM);
  }
  if (blockedNames.size > 0) {
    warnings.push(
      `「${[...blockedNames].join('」「')}」的碎块之间存在共享墙（不是吧台那种半截隔断），已保留分块`,
    );
  }
  const brokenNames = new Set<string>();
  for (const idx of merged.brokenGroups) {
    brokenNames.add(byIndex.get(idx + 1)?.name ?? UNNAMED_ROOM);
  }
  if (brokenNames.size > 0) {
    warnings.push(`「${[...brokenNames].join('」「')}」的碎块摘掉隔断后仍然不连通，已保留分块`);
  }

  // 拼不上的碎块组：帖数标注对**任何一块**都不成立（每块只是房间的一部分），
  // 留着只会刷出一串「面积与标注偏差 60%」的假警报。整组的帖数一律清掉，
  // 换成一条说人话的提示，让用户自己去合并。
  const splitGroups = new Map<number, number>();
  for (const r of merged.rooms) {
    const root = groups.get(r.cvIndex + 1) ?? r.cvIndex + 1;
    splitGroups.set(root, (splitGroups.get(root) ?? 0) + 1);
  }
  const unmergedNames = new Set<string>();

  const source: RecognizedRoom[] = merged.rooms.map((r): RecognizedRoom => {
    const label: LabelRoom | undefined = byIndex.get(r.cvIndex + 1);
    if (label && label.name) stats.namedRooms += 1;
    const root = groups.get(r.cvIndex + 1) ?? r.cvIndex + 1;
    const stillSplit = (splitGroups.get(root) ?? 1) > 1;
    if (stillSplit && label?.tatamiCount) unmergedNames.add(label.name ?? UNNAMED_ROOM);
    return {
      id: `cv${r.cvIndex}`,
      name: label?.name ?? UNNAMED_ROOM,
      floor: label?.floor ?? 'other',
      tatamiCount: stillSplit ? null : (label?.tatamiCount ?? null),
      polygon: [],
    };
  });
  if (unmergedNames.size > 0) {
    warnings.push(
      `「${[...unmergedNames].join('」「')}」在图上被半截隔断切成了好几块，程序没能拼回一整间：` +
        '每一块都只是房间的一部分（面积与帖数标注对不上是正常的），需要的话请手动合并',
    );
  }
  const built = buildRooms(
    source,
    merged.rooms.map((r) => r.polygon),
  );
  warnings.push(...built.warnings);

  const unnamed = source.length - stats.namedRooms;
  if (unnamed > 0) {
    warnings.push(`有 ${unnamed} 块区域 AI 没能认出房间名（已命名为「${UNNAMED_ROOM}」），请人工确认`);
  }

  // 7. 洞口：CV 缺口候选 → 外墙=窗 / 内墙=门
  const openings = placeCvOpenings(cvOpenings, walls, mmPerPx, transform);
  warnings.push(...openings.warnings);
  stats.openingsPlaced = openings.openings.length;

  // 8. 柱：CV 实心块候选
  const structures = placeCvColumns(cvColumns, mmPerPx, transform);

  // 9. 底图对齐：比例就是 mm/px，偏移就是整体平移量，deskew 角写进 rotation
  if (Math.abs(cv.deskewDeg) > 0.05) {
    warnings.push(
      `图纸做了 ${round(cv.deskewDeg, 1)}° 的倾斜校正，底图已同步旋转，如有错位请用底图标定工具微调`,
    );
  }

  return {
    walls,
    openings: openings.openings,
    structures,
    rooms: built.rooms,
    underlay: {
      mmPerPixel: mmPerPx,
      offset: roundPt(snapped.translation),
      rotation: cv.deskewDeg,
    },
    mmPerUnit: mmPerPx,
    areaMismatchRoomIds: built.mismatchedRoomIds,
    warnings,
    labelStats: stats,
  };
}

function emptyResult(mmPerPx: number, warnings: string[], stats: LabelFuseStats): LabelFuseResult {
  return {
    walls: [],
    openings: [],
    structures: [],
    rooms: [],
    underlay: { mmPerPixel: mmPerPx, offset: { x: 0, y: 0 }, rotation: 0 },
    mmPerUnit: mmPerPx,
    areaMismatchRoomIds: [],
    warnings,
    labelStats: stats,
  };
}
