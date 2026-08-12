/**
 * M3：几何求解器（见 docs/AI-RECOGNITION.md 第 4 节）。
 *
 * 输入 `RecognizeResult`（语义 + 归一化坐标）+ 图片像素尺寸，
 * 输出可直接写进 PlanDoc 的 `walls / openings / structures / rooms` 以及对齐好的底图参数。
 *
 * **纯函数**：不 import store、不碰 DOM，管线每一步单独导出，方便 `solve.test.ts` 逐步断言。
 *
 * 管线：
 *   1. estimateScale     帖数（或图纸总宽）→ k（mm / 归一化单位）
 *   2. regularizePolygon 接近水平/垂直的边吸附成轴对齐，**斜边如实保留**，顶点转 mm
 *   3. snapSharedEdges   轴对齐坐标聚类归并 → 吸附 455 网格；斜边端点插值后吸附 100mm → 平移到 (0,0)
 *   4. deriveWalls       轴向边同线合并；斜边按「角度 + 直线偏移」分组合并 → Wall[]
 *   5. placeOpenings     洞口投影到 roomA/roomB 的共享墙（任意角度），clamp + 避让
 *   6. convertColumns    柱转 Structure（吸附 100mm）
 *   7. buildRooms        规整后的多边形直接作为 Room，并校验面积与帖数标注是否自洽
 *   8. alignUnderlay     反推底图 mmPerPixel / offset，保证与生成的平面图叠放对齐
 *
 * **M3.1**：原来的 `rectilinearize` 把所有边强制轴对齐，塔楼户型的斜切角、洋室的斜边
 * 会被整条掰直。现在只有「与 0°/90° 偏差 ≤ `ANGLE_SNAP_TOL_DEG`」的边才轴对齐，
 * 其余保留真实角度，全链路（吸附 / 墙提取 / 洞口）都支持斜墙。
 */
import { HALF_GRID, newId, roundPt } from '../model/defaults';
import type { Opening, OpeningType, Pt, Room, Structure, Wall } from '../model/types';
import { clamp, pointSegProjection, polygonAreaMm2, wallLen } from '../utils/geometry';
import { TATAMI_AREA_MM2 } from '../utils/units';
import {
  OPENING_DEFAULT_SWING,
  OPENING_DEFAULT_WIDTH,
  clampOpeningOffset,
  hasOpeningConflict,
  nearestWall,
  openingFits,
} from '../tools/wallGeometry';
import {
  NORM_MAX,
  OUTSIDE_ID,
  type NormPoint,
  type RecognizeResult,
  type RecognizedColumn,
  type RecognizedOpening,
  type RecognizedRoom,
} from './recognizeSchema';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 跨房间归并轴坐标的容差 mm（≈ 一道墙的厚度量级） */
export const EDGE_CLUSTER_TOLERANCE_MM = 300;
/** 规整后的坐标吸附步长 */
export const SOLVE_SNAP_STEP = HALF_GRID;
/** 洞口离墙超过这个距离就丢弃 */
export const OPENING_MAX_ATTACH_MM = 1200;
/** 洞口宽度可以被压缩到的下限（比这还放不下就丢弃） */
export const OPENING_MIN_WIDTH_MM = 600;
/** 避让已有洞口时的搜索步长 */
export const OPENING_NUDGE_STEP_MM = 100;
/** 柱默认边长（图上没给尺寸时） */
export const COLUMN_FALLBACK_SIZE_MM = 105;
/** 柱尺寸的合理区间 */
export const COLUMN_MIN_SIZE_MM = 50;
export const COLUMN_MAX_SIZE_MM = 1200;
/** 柱坐标吸附步长 */
export const COLUMN_SNAP_MM = 100;
/**
 * 边与 0°/90° 的偏差在此以内 → 吸附成轴对齐边（模型给的水平/垂直边总是歪一点）；
 * 超过则认为是**真实的斜墙**，如实保留角度。
 */
export const ANGLE_SNAP_TOL_DEG = 10;
/**
 * 斜边端点的吸附步长。刻意**不上 455 网格**：斜边两端各自被拉到网格上会明显改变角度，
 * 100mm 足以消掉模型的抖动，又不至于让 45° 变成 43°。
 */
export const DIAGONAL_SNAP_MM = 100;
/** 斜边共线合并：偏移（点到直线距离）在此以内视为同一条直线 */
export const DIAGONAL_OFFSET_TOL_MM = 150;
/** 房间实际面积与帖数标注的相对偏差超过它就报 warning */
export const AREA_MISMATCH_TOLERANCE = 0.25;
/** 判断一条边是不是严格轴对齐（regularize 之后轴对齐边的差值精确为 0） */
const AXIS_EPS_MM = 0.5;
/** k（mm / 归一化单位）的合理区间；超出就认为比例估计失败 */
export const MIN_SCALE_MM_PER_UNIT = 0.5;
export const MAX_SCALE_MM_PER_UNIT = 100;
/** 短于此长度的墙段直接丢弃（正常流程不会出现） */
const MIN_WALL_LEN_MM = 1;
/** 判断两个浮点坐标是否“同一条线” */
const EPS = 1e-6;

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

export interface SolveOptions {
  imageWidthPx: number;
  imageHeightPx: number;
}

export interface SolvedUnderlay {
  mmPerPixel: number;
  offset: Pt;
  /**
   * 底图旋转角（度，顺时针为正）。纯 VLM 路径恒为 0；
   * M4-CV 的融合路径会把 CV 的 deskew 校正角写进来，底图才能跟几何对上。
   */
  rotation?: number;
}

export interface SolveResult {
  walls: Wall[];
  openings: Opening[];
  structures: Structure[];
  rooms: Room[];
  /** 底图对齐参数（配合原图 dataURL 组成 doc.underlay） */
  underlay: SolvedUnderlay;
  /** 估出来的比例：mm / 归一化单位 */
  mmPerUnit: number;
  /** 面积与帖数标注明显不符的房间 id（UI 用来高亮提示人工核对） */
  areaMismatchRoomIds: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// 1. estimateScale
// ---------------------------------------------------------------------------

export interface ScaleEstimate {
  /** mm / 归一化单位 */
  k: number;
  /** 实际用到的推算方式 */
  basis: 'tatami' | 'drawing_width';
  warnings: string[];
}

/** 归一化坐标下的多边形面积（单位：归一化单位²） */
export function normPolygonArea(polygon: readonly NormPoint[]): number {
  return polygonAreaMm2(polygon.map((p) => ({ x: p.x, y: p.y })));
}

/**
 * 比例估计。
 * - 有帖数标注：`k = sqrt(Σ(帖 × 1.6562e6 mm²) / Σ(对应房间的归一化面积))`
 * - 没有：`k = drawingWidthMm / 1000`
 */
export function estimateScale(result: RecognizeResult): ScaleEstimate {
  const warnings: string[] = [];

  let tatamiSum = 0;
  let areaSum = 0;
  for (const room of result.rooms) {
    if (room.tatamiCount === null || !(room.tatamiCount > 0)) continue;
    const area = normPolygonArea(room.polygon);
    if (!(area > 0)) continue;
    tatamiSum += room.tatamiCount;
    areaSum += area;
  }

  let k: number;
  let basis: ScaleEstimate['basis'];
  if (tatamiSum > 0 && areaSum > 0) {
    k = Math.sqrt((tatamiSum * TATAMI_AREA_MM2) / areaSum);
    basis = 'tatami';
  } else {
    k = result.scale.drawingWidthMm / NORM_MAX;
    basis = 'drawing_width';
    warnings.push('图上没有可用的帖数标注，比例按图纸总宽估算，实际尺寸可能有偏差');
  }

  if (!Number.isFinite(k) || k < MIN_SCALE_MM_PER_UNIT || k > MAX_SCALE_MM_PER_UNIT) {
    const fallback = result.scale.drawingWidthMm / NORM_MAX;
    if (Number.isFinite(fallback) && fallback >= MIN_SCALE_MM_PER_UNIT && fallback <= MAX_SCALE_MM_PER_UNIT) {
      warnings.push('帖数与图形面积明显矛盾，已改用图纸总宽估算比例');
      return { k: fallback, basis: 'drawing_width', warnings };
    }
    warnings.push('无法可靠估算比例，已按 1 归一化单位 = 9mm 兜底，请用底图标定工具校正');
    return { k: 9, basis: 'drawing_width', warnings };
  }

  return { k, basis, warnings };
}

// ---------------------------------------------------------------------------
// 2. regularizePolygon
// ---------------------------------------------------------------------------

/** 极简并查集（顶点分组：同组的 x（或 y）必须相等） */
function makeUnionFind(n: number) {
  const parent = Array.from({ length: n }, (_, i) => i);
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
  return { find, union };
}

function dedupeConsecutive(pts: Pt[], eps = 1e-6): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < eps && Math.abs(last.y - p.y) < eps) continue;
    out.push(p);
  }
  while (
    out.length > 1 &&
    Math.abs(out[0].x - out[out.length - 1].x) < eps &&
    Math.abs(out[0].y - out[out.length - 1].y) < eps
  ) {
    out.pop();
  }
  return out;
}

/** 去掉共线的中间点（含重合点） */
export function dropCollinear(pts: Pt[], eps = 1e-6): Pt[] {
  const src = dedupeConsecutive(pts, eps);
  if (src.length < 3) return src;
  const out: Pt[] = [];
  for (let i = 0; i < src.length; i++) {
    const prev = src[(i - 1 + src.length) % src.length];
    const cur = src[i];
    const next = src[(i + 1) % src.length];
    const cross = (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x);
    if (Math.abs(cross) > eps) out.push(cur);
  }
  return out.length >= 3 ? out : src;
}

/** 一条边的走向：水平 / 垂直 / 斜边 */
export type EdgeOrient = 'h' | 'v' | 'd';

/**
 * 按角度判定一条边的走向。
 * 与 0°/90° 的偏差 ≤ `ANGLE_SNAP_TOL_DEG` → 轴对齐；否则是**真实的斜边**。
 */
export function edgeOrient(dx: number, dy: number, tolDeg = ANGLE_SNAP_TOL_DEG): EdgeOrient {
  if (Math.hypot(dx, dy) < EPS) return 'd';
  // 与水平轴的夹角，0~90
  const fromHorizontal = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
  if (fromHorizontal <= tolDeg) return 'h';
  if (fromHorizontal >= 90 - tolDeg) return 'v';
  return 'd';
}

/**
 * 把一个归一化多边形转成 mm 并做**局部**正交化：
 * - 与 0°/90° 偏差 ≤ `ANGLE_SNAP_TOL_DEG` 的边 → 轴对齐（两端点在对应轴上取均值，
 *   用并查集分组，保证「多条边串起来的一排顶点」取同一个值，与遍历顺序无关）；
 * - 其余边 → 斜边，两端点在该轴上不参与归并，保留 ×k 后的原始 mm 坐标
 *   （并查集里是单点组，均值就是它自己）。
 */
export function regularizePolygon(polygon: readonly NormPoint[], k: number): Pt[] {
  const raw = dedupeConsecutive(polygon.map((p) => ({ x: p.x * k, y: p.y * k })));
  const n = raw.length;
  if (n < 3) return [];

  const ufX = makeUnionFind(n);
  const ufY = makeUnionFind(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const orient = edgeOrient(raw[j].x - raw[i].x, raw[j].y - raw[i].y);
    if (orient === 'h') ufY.union(i, j); // 水平边 → 两端 y 相同
    else if (orient === 'v') ufX.union(i, j); // 垂直边 → 两端 x 相同
    // 斜边：两端在两个轴上都自由，保留原始坐标
  }

  const average = (uf: ReturnType<typeof makeUnionFind>, pick: (p: Pt) => number): number[] => {
    const sum = new Map<number, { total: number; count: number }>();
    for (let i = 0; i < n; i++) {
      const root = uf.find(i);
      const cell = sum.get(root) ?? { total: 0, count: 0 };
      cell.total += pick(raw[i]);
      cell.count += 1;
      sum.set(root, cell);
    }
    return raw.map((_, i) => {
      const cell = sum.get(uf.find(i))!;
      return cell.total / cell.count;
    });
  };

  const xs = average(ufX, (p) => p.x);
  const ys = average(ufY, (p) => p.y);
  return dropCollinear(raw.map((_, i) => ({ x: xs[i], y: ys[i] })));
}

/**
 * 已规整（mm 空间）的多边形每条边的走向。
 * regularize 之后轴对齐边的差值精确为 0，斜边与两轴的夹角都 > `ANGLE_SNAP_TOL_DEG`，
 * 所以这里可以直接按坐标判定，不会误判。
 */
export function classifyPolygonEdges(poly: readonly Pt[]): EdgeOrient[] {
  const out: EdgeOrient[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    if (dy < AXIS_EPS_MM && dx >= AXIS_EPS_MM) out.push('h');
    else if (dx < AXIS_EPS_MM && dy >= AXIS_EPS_MM) out.push('v');
    else out.push('d');
  }
  return out;
}

/**
 * 每个顶点的 x / y 是否由**轴对齐边**决定。
 * 只有这些坐标才参与跨房间的轴聚类；纯斜边顶点走插值（见 `snapSharedEdges`）。
 */
export function polygonAxisFlags(poly: readonly Pt[]): { axisX: boolean[]; axisY: boolean[] } {
  const n = poly.length;
  const axisX = new Array<boolean>(n).fill(false);
  const axisY = new Array<boolean>(n).fill(false);
  const kinds = classifyPolygonEdges(poly);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (kinds[i] === 'h') {
      axisY[i] = true;
      axisY[j] = true;
    } else if (kinds[i] === 'v') {
      axisX[i] = true;
      axisX[j] = true;
    }
  }
  return { axisX, axisY };
}

// ---------------------------------------------------------------------------
// 3. snapSharedEdges
// ---------------------------------------------------------------------------

export interface AxisEntry {
  /** 聚类中心（规整前的 mm 值） */
  from: number;
  /** 吸附到网格后的 mm 值 */
  to: number;
}

export interface AxisMap {
  entries: AxisEntry[];
  tolerance: number;
}

export interface AxisMapOptions {
  /**
   * 两个聚类吸附后撞到同一个网格值时怎么办：
   * - `'separate'`（默认，纯 VLM 路径）：强行错开一格，避免两条不同的墙被压成同一条
   *   ——模型给的坐标本来就抖，宁可多一条也别少一条；
   * - `'merge'`（M4-CV 融合路径）：合并成同一条线。CV 坐标是像素级实测的，
   *   两条线吸到同一格说明它们本来就是同一道墙的两个面，强行错开只会**把图纸撑大**。
   */
  onCollision?: 'separate' | 'merge';
}

/**
 * 把一串轴坐标聚类（容差内视为同一条线）→ 取均值 → 吸附到 step 网格。
 * 撞格时的处理见 `AxisMapOptions.onCollision`。
 */
export function buildAxisMap(
  values: readonly number[],
  tolerance = EDGE_CLUSTER_TOLERANCE_MM,
  step = SOLVE_SNAP_STEP,
  options: AxisMapOptions = {},
): AxisMap {
  const onCollision = options.onCollision ?? 'separate';
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const entries: AxisEntry[] = [];
  if (sorted.length === 0) return { entries, tolerance };

  let cluster: number[] = [sorted[0]];
  const flush = () => {
    const center = cluster.reduce((a, b) => a + b, 0) / cluster.length;
    let snapped = Math.round(center / step) * step;
    const prev = entries[entries.length - 1];
    if (prev && snapped <= prev.to) snapped = onCollision === 'merge' ? prev.to : prev.to + step;
    entries.push({ from: center, to: snapped });
  };

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - cluster[0] <= tolerance) cluster.push(sorted[i]);
    else {
      flush();
      cluster = [sorted[i]];
    }
  }
  flush();
  return { entries, tolerance };
}

/**
 * 分段线性映射：落在两个聚类之间的值按比例插值，两端外的值按最近端点平移。
 * 用于洞口 / 柱这类「不属于任何一条墙线」的点，保持它们在墙上的相对位置。
 */
export function applyAxis(map: AxisMap, v: number): number {
  const e = map.entries;
  if (e.length === 0) return v;
  if (e.length === 1) return v + (e[0].to - e[0].from);
  if (v <= e[0].from) return v + (e[0].to - e[0].from);
  const last = e[e.length - 1];
  if (v >= last.from) return v + (last.to - last.from);
  for (let i = 0; i < e.length - 1; i++) {
    const a = e[i];
    const b = e[i + 1];
    if (v >= a.from && v <= b.from) {
      const span = b.from - a.from;
      const t = span > EPS ? (v - a.from) / span : 0;
      return a.to + t * (b.to - a.to);
    }
  }
  return v;
}

/**
 * 斜边端点专用。
 *
 * 斜边端点不能落到 455 网格上——两端各被拉一次会明显改变角度。所以：
 * 1. 先用 `applyAxis` 插值，跟着相邻的正交几何一起平移/缩放，保持相对位置；
 * 2. 如果插值结果离某条正交墙线不到 `DIAGONAL_SNAP_MM`，直接落到那条线上
 *    （斜切角的端点通常正好是某道正交墙的端点，这样才严丝合缝，也保证
 *    「在 A 房间是正交顶点、在 B 房间是斜边端点」的共享顶点一致）；
 * 3. 否则吸附到 `DIAGONAL_SNAP_MM` 网格（消掉模型抖动，且相邻房间落在同一个格子里）。
 */
export function snapDiagonalAxis(map: AxisMap, v: number, step = DIAGONAL_SNAP_MM): number {
  const mapped = applyAxis(map, v);
  let bestTo: number | null = null;
  let bestDist = Infinity;
  for (const entry of map.entries) {
    const d = Math.abs(mapped - entry.to);
    if (d < bestDist) {
      bestDist = d;
      bestTo = entry.to;
    }
  }
  if (bestTo !== null && bestDist <= step) return bestTo;
  return Math.round(mapped / step) * step;
}

/** 顶点专用：容差内直接落到聚类的吸附值（保证相邻房间共边严格一致） */
export function snapAxis(map: AxisMap, v: number): number {
  let best: AxisEntry | null = null;
  let bestDist = Infinity;
  for (const entry of map.entries) {
    const d = Math.abs(v - entry.from);
    if (d < bestDist) {
      bestDist = d;
      best = entry;
    }
  }
  if (best && bestDist <= map.tolerance) return best.to;
  return applyAxis(map, v);
}

/** 归一化坐标 → 文档 mm 的完整变换 */
export interface PlanTransform {
  /** mm / 归一化单位 */
  k: number;
  xMap: AxisMap;
  yMap: AxisMap;
  /** 吸附之后整体平移量（让最小角落落在原点） */
  translation: Pt;
}

export interface SnapResult {
  polygons: Pt[][];
  xMap: AxisMap;
  yMap: AxisMap;
  translation: Pt;
}

/**
 * 跨房间归并轴坐标 → 吸附 455 网格 → 平移，使最小角落在 (0,0)。
 * 返回的 xMap/yMap + translation 同时供洞口 / 柱 / 底图复用。
 *
 * **只有轴对齐边的坐标参与聚类**——把斜边端点也塞进去会污染墙线的聚类中心；
 * 斜边端点改走 `snapDiagonalAxis`（插值 + 100mm 吸附），角度因此得以保留。
 */
export function snapSharedEdges(
  polygons: readonly Pt[][],
  tolerance = EDGE_CLUSTER_TOLERANCE_MM,
  step = SOLVE_SNAP_STEP,
): SnapResult {
  const flags = polygons.map((poly) => polygonAxisFlags(poly));

  const xs: number[] = [];
  const ys: number[] = [];
  for (let pi = 0; pi < polygons.length; pi++) {
    const poly = polygons[pi];
    for (let i = 0; i < poly.length; i++) {
      if (flags[pi].axisX[i]) xs.push(poly[i].x);
      if (flags[pi].axisY[i]) ys.push(poly[i].y);
    }
  }
  const xMap = buildAxisMap(xs, tolerance, step);
  const yMap = buildAxisMap(ys, tolerance, step);

  const snapped = polygons.map((poly, pi) =>
    dropCollinear(
      poly.map((p, i) => ({
        x: flags[pi].axisX[i] ? snapAxis(xMap, p.x) : snapDiagonalAxis(xMap, p.x),
        y: flags[pi].axisY[i] ? snapAxis(yMap, p.y) : snapDiagonalAxis(yMap, p.y),
      })),
    ),
  );

  let minX = Infinity;
  let minY = Infinity;
  for (const poly of snapped) {
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
    }
  }
  if (!Number.isFinite(minX)) minX = 0;
  if (!Number.isFinite(minY)) minY = 0;

  const translation = { x: -minX, y: -minY };
  return {
    polygons: snapped.map((poly) => poly.map((p) => roundPt({ x: p.x + translation.x, y: p.y + translation.y }))),
    xMap,
    yMap,
    translation,
  };
}

/** 归一化点 → 文档 mm（整数） */
export function transformNormPoint(t: PlanTransform, p: NormPoint): Pt {
  return roundPt({
    x: applyAxis(t.xMap, p.x * t.k) + t.translation.x,
    y: applyAxis(t.yMap, p.y * t.k) + t.translation.y,
  });
}

// ---------------------------------------------------------------------------
// 4. deriveWalls
// ---------------------------------------------------------------------------

type Orient = 'h' | 'v';

export interface AxisSegment {
  orient: Orient;
  /** 水平段的 y / 垂直段的 x */
  fixed: number;
  from: number;
  to: number;
}

/** 一条斜边（保留真实端点） */
export interface DiagonalSegment {
  a: Pt;
  b: Pt;
}

/** 一个房间多边形拆出来的所有边 */
export interface RoomEdges {
  axis: AxisSegment[];
  diagonal: DiagonalSegment[];
}

/** 拆出多边形的所有轴对齐边（斜边不在其中，见 `polygonDiagonals`） */
export function polygonSegments(poly: readonly Pt[]): AxisSegment[] {
  const out: AxisSegment[] = [];
  const kinds = classifyPolygonEdges(poly);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (kinds[i] === 'h') {
      out.push({ orient: 'h', fixed: a.y, from: Math.min(a.x, b.x), to: Math.max(a.x, b.x) });
    } else if (kinds[i] === 'v') {
      out.push({ orient: 'v', fixed: a.x, from: Math.min(a.y, b.y), to: Math.max(a.y, b.y) });
    }
  }
  return out;
}

/** 拆出多边形的所有斜边 */
export function polygonDiagonals(poly: readonly Pt[]): DiagonalSegment[] {
  const out: DiagonalSegment[] = [];
  const kinds = classifyPolygonEdges(poly);
  for (let i = 0; i < poly.length; i++) {
    if (kinds[i] === 'd') out.push({ a: poly[i], b: poly[(i + 1) % poly.length] });
  }
  return out;
}

/** 轴对齐边 + 斜边 */
export function polygonEdges(poly: readonly Pt[]): RoomEdges {
  return { axis: polygonSegments(poly), diagonal: polygonDiagonals(poly) };
}

/**
 * 一堆**轴对齐**线段 → 按 (方向, 固定坐标) 分组 → 重叠 / 相接的共线段合并去重 → Wall[]。
 * 相邻房间的共享边因此只会生成**一段**墙。
 *
 * 单独导出是给 M4-CV 的融合器（`fuse.ts`）复用的：那边的线段直接来自 CV 提取，
 * 不是从房间多边形拆出来的。
 */
export function mergeAxisSegments(segments: readonly AxisSegment[]): Wall[] {
  const groups = new Map<string, AxisSegment[]>();
  for (const seg of segments) {
    const key = `${seg.orient}:${Math.round(seg.fixed)}`;
    const list = groups.get(key);
    if (list) list.push(seg);
    else groups.set(key, [seg]);
  }

  const walls: Wall[] = [];
  const keys = [...groups.keys()].sort();
  for (const key of keys) {
    const segs = groups.get(key)!.slice().sort((a, b) => a.from - b.from);
    let cur = { ...segs[0] };
    const merged: AxisSegment[] = [];
    for (let i = 1; i < segs.length; i++) {
      const s = segs[i];
      if (s.from <= cur.to + 0.5) cur.to = Math.max(cur.to, s.to);
      else {
        merged.push(cur);
        cur = { ...s };
      }
    }
    merged.push(cur);

    for (const seg of merged) {
      if (seg.to - seg.from < MIN_WALL_LEN_MM) continue;
      const start =
        seg.orient === 'h'
          ? { x: Math.round(seg.from), y: Math.round(seg.fixed) }
          : { x: Math.round(seg.fixed), y: Math.round(seg.from) };
      const end =
        seg.orient === 'h'
          ? { x: Math.round(seg.to), y: Math.round(seg.fixed) }
          : { x: Math.round(seg.fixed), y: Math.round(seg.to) };
      walls.push({ id: newId('w'), start, end });
    }
  }
  return walls;
}

/** 单位方向向量，方向归一到右半平面（同一条直线的两个走向落进同一组） */
function lineDirection(a: Pt, b: Pt): { ux: number; uy: number } | null {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < EPS) return null;
  dx /= len;
  dy /= len;
  if (dx < -EPS || (Math.abs(dx) <= EPS && dy < 0)) {
    dx = -dx;
    dy = -dy;
  }
  return { ux: dx, uy: dy };
}

/** 方向 → 取整到 1° 的直线角度，归一化到 [0, 180) */
export function lineAngleKey(ux: number, uy: number): number {
  const deg = Math.round((Math.atan2(uy, ux) * 180) / Math.PI);
  return ((deg % 180) + 180) % 180;
}

/**
 * 一堆斜线段 → 墙。
 *
 * 按「角度（取整到 1°）」分组，组内再按「到原点的法向偏移」聚类成同一条直线，
 * 最后沿直线方向做区间合并——**相邻房间共享的那条斜边只会出一段墙**。
 *
 * 与 `mergeAxisSegments` 一样，单独导出供 `fuse.ts` 复用。
 */
export function mergeDiagonalSegments(segments: readonly DiagonalSegment[]): Wall[] {
  const groups = new Map<number, Array<{ a: Pt; b: Pt; ux: number; uy: number }>>();
  for (const seg of segments) {
    const dir = lineDirection(seg.a, seg.b);
    if (!dir) continue;
    const key = lineAngleKey(dir.ux, dir.uy);
    const list = groups.get(key);
    const item = { a: seg.a, b: seg.b, ux: dir.ux, uy: dir.uy };
    if (list) list.push(item);
    else groups.set(key, [item]);
  }

  const walls: Wall[] = [];
  for (const key of [...groups.keys()].sort((a, b) => a - b)) {
    const segs = groups.get(key)!;
    // 组代表方向：成员方向的平均（同组内彼此相差 <1°，直接相加不会抵消）
    let sx = 0;
    let sy = 0;
    for (const s of segs) {
      sx += s.ux;
      sy += s.uy;
    }
    const norm = Math.hypot(sx, sy);
    if (norm < EPS) continue;
    const ux = sx / norm;
    const uy = sy / norm;
    const nx = -uy;
    const ny = ux;

    const items = segs
      .map((s) => {
        const offset = ((s.a.x * nx + s.a.y * ny) + (s.b.x * nx + s.b.y * ny)) / 2;
        const tA = s.a.x * ux + s.a.y * uy;
        const tB = s.b.x * ux + s.b.y * uy;
        return { offset, from: Math.min(tA, tB), to: Math.max(tA, tB) };
      })
      .sort((a, b) => a.offset - b.offset || a.from - b.from);

    let cluster = [items[0]];
    const flush = () => {
      const offset = cluster.reduce((sum, i) => sum + i.offset, 0) / cluster.length;
      const spans = cluster.slice().sort((a, b) => a.from - b.from);
      let cur = { from: spans[0].from, to: spans[0].to };
      const merged: Array<{ from: number; to: number }> = [];
      for (let i = 1; i < spans.length; i++) {
        if (spans[i].from <= cur.to + 0.5) cur.to = Math.max(cur.to, spans[i].to);
        else {
          merged.push(cur);
          cur = { from: spans[i].from, to: spans[i].to };
        }
      }
      merged.push(cur);
      for (const m of merged) {
        if (m.to - m.from < MIN_WALL_LEN_MM) continue;
        walls.push({
          id: newId('w'),
          start: roundPt({ x: nx * offset + ux * m.from, y: ny * offset + uy * m.from }),
          end: roundPt({ x: nx * offset + ux * m.to, y: ny * offset + uy * m.to }),
        });
      }
    };
    for (let i = 1; i < items.length; i++) {
      if (items[i].offset - cluster[0].offset <= DIAGONAL_OFFSET_TOL_MM) cluster.push(items[i]);
      else {
        flush();
        cluster = [items[i]];
      }
    }
    flush();
  }
  return walls;
}

/** 轴向墙 + 斜墙 */
export function deriveWalls(polygons: readonly Pt[][]): Wall[] {
  const axis: AxisSegment[] = [];
  const diagonal: DiagonalSegment[] = [];
  for (const poly of polygons) {
    axis.push(...polygonSegments(poly));
    diagonal.push(...polygonDiagonals(poly));
  }
  return [...mergeAxisSegments(axis), ...mergeDiagonalSegments(diagonal)];
}

// ---------------------------------------------------------------------------
// 5. placeOpenings
// ---------------------------------------------------------------------------

/**
 * 某个房间贴着哪些墙（用于把洞口投影到 roomA / roomB 的共享墙上）。
 * 轴向墙走坐标比较，斜墙走「两端点都贴着这道墙 + 投影区间有重叠」。
 */
function roomBordersWall(edges: RoomEdges, wall: Wall): boolean {
  const horizontal = wall.start.y === wall.end.y;
  const vertical = wall.start.x === wall.end.x;

  if (!horizontal && !vertical) {
    for (const seg of edges.diagonal) {
      const pa = pointSegProjection(seg.a, wall.start, wall.end);
      const pb = pointSegProjection(seg.b, wall.start, wall.end);
      if (pa.distance > DIAGONAL_SNAP_MM || pb.distance > DIAGONAL_SNAP_MM) continue;
      if (Math.abs(pa.along - pb.along) > 1) return true;
    }
    return false;
  }

  const orient: Orient = horizontal ? 'h' : 'v';
  const fixed = horizontal ? wall.start.y : wall.start.x;
  const from = horizontal ? Math.min(wall.start.x, wall.end.x) : Math.min(wall.start.y, wall.end.y);
  const to = horizontal ? Math.max(wall.start.x, wall.end.x) : Math.max(wall.start.y, wall.end.y);
  for (const seg of edges.axis) {
    if (seg.orient !== orient) continue;
    if (Math.abs(seg.fixed - fixed) > 1) continue;
    const overlap = Math.min(seg.to, to) - Math.max(seg.from, from);
    if (overlap > 1) return true;
  }
  return false;
}

/** 在墙上找一个不与已有洞口冲突的位置；找不到返回 null */
export function resolveOpeningOffset(
  placed: readonly Opening[],
  wallId: string,
  wantOffset: number,
  width: number,
  wallLength: number,
): number | null {
  const base = clampOpeningOffset(wantOffset, width, wallLength);
  if (!hasOpeningConflict(placed, wallId, base, width)) return base;
  const tried = new Set<number>([base]);
  for (let step = OPENING_NUDGE_STEP_MM; step <= wallLength; step += OPENING_NUDGE_STEP_MM) {
    for (const cand of [base + step, base - step]) {
      const c = clampOpeningOffset(cand, width, wallLength);
      if (tried.has(c)) continue;
      tried.add(c);
      if (!hasOpeningConflict(placed, wallId, c, width)) return c;
    }
  }
  return null;
}

export interface PlaceOpeningsInput {
  openings: readonly RecognizedOpening[];
  /** 房间 id → 规整后的多边形边（轴向 + 斜边，用于判断共享墙） */
  roomSegments: ReadonlyMap<string, RoomEdges>;
  walls: readonly Wall[];
  transform: PlanTransform;
}

export interface PlaceOpeningsResult {
  openings: Opening[];
  warnings: string[];
}

function openingLabel(o: RecognizedOpening): string {
  const name: Record<OpeningType, string> = {
    door: '门',
    sliding_door: '引き戸',
    window: '窗',
    opening: '开口',
  };
  return `${name[o.type]}（${o.roomA} ↔ ${o.roomB}）`;
}

/**
 * 洞口中心点 → mm → 投影到 roomA/roomB 的共享墙段（找不到共享墙则退回全局最近墙）。
 * 距离超过 `OPENING_MAX_ATTACH_MM` 直接丢弃并记 warning。
 */
export function placeOpenings(input: PlaceOpeningsInput): PlaceOpeningsResult {
  const { openings, roomSegments, walls, transform } = input;
  const placed: Opening[] = [];
  const warnings: string[] = [];

  for (const o of openings) {
    const p = transformNormPoint(transform, { x: o.x, y: o.y });

    const sides = [o.roomA, o.roomB].filter((id) => id !== OUTSIDE_ID && roomSegments.has(id));
    const shared = walls.filter((w) => sides.every((id) => roomBordersWall(roomSegments.get(id)!, w)));
    const candidates = shared.length > 0 ? shared : walls;

    let hit = nearestWall(candidates, p, OPENING_MAX_ATTACH_MM);
    if (!hit && candidates !== walls) hit = nearestWall(walls, p, OPENING_MAX_ATTACH_MM);
    if (!hit) {
      warnings.push(`${openingLabel(o)} 离最近的墙太远，已跳过`);
      continue;
    }

    const length = wallLen(hit.wall);
    let width = OPENING_DEFAULT_WIDTH[o.type];
    if (!openingFits(width, length)) {
      width = Math.floor(length);
      if (width < OPENING_MIN_WIDTH_MM) {
        warnings.push(`${openingLabel(o)} 所在墙段只有 ${Math.round(length)}mm，放不下，已跳过`);
        continue;
      }
    }

    const offset = resolveOpeningOffset(placed, hit.wall.id, hit.along, width, length);
    if (offset === null) {
      warnings.push(`${openingLabel(o)} 与同墙上已有的开口冲突，已跳过`);
      continue;
    }

    placed.push({
      id: newId('o'),
      wallId: hit.wall.id,
      type: o.type,
      offset,
      width,
      ...(o.type === 'door' ? { swing: OPENING_DEFAULT_SWING } : {}),
    });
  }

  return { openings: placed, warnings };
}

// ---------------------------------------------------------------------------
// 6. convertColumns
// ---------------------------------------------------------------------------

function columnSize(v: number | null, k: number): number {
  if (v === null || !Number.isFinite(v) || v <= 0) return COLUMN_FALLBACK_SIZE_MM;
  return Math.round(clamp(v * k, COLUMN_MIN_SIZE_MM, COLUMN_MAX_SIZE_MM));
}

/** 柱：坐标 ×k 后吸附 100mm；w/h 为 null 时用 105×105 */
export function convertColumns(
  columns: readonly RecognizedColumn[],
  transform: PlanTransform,
): Structure[] {
  return columns.map((c) => {
    const p = transformNormPoint(transform, { x: c.x, y: c.y });
    return {
      id: newId('s'),
      kind: 'column' as const,
      position: {
        x: Math.round(p.x / COLUMN_SNAP_MM) * COLUMN_SNAP_MM,
        y: Math.round(p.y / COLUMN_SNAP_MM) * COLUMN_SNAP_MM,
      },
      width: columnSize(c.w, transform.k),
      depth: columnSize(c.h, transform.k),
      rotation: 0,
    };
  });
}

// ---------------------------------------------------------------------------
// 7. buildRooms
// ---------------------------------------------------------------------------

export interface BuildRoomsResult {
  rooms: Room[];
  /** 面积与帖数标注明显不符的房间 id */
  mismatchedRoomIds: string[];
  warnings: string[];
}

/**
 * 规整后的多边形直接作为 Room，同时做**帖数一致性校验**：
 * 多边形的实际面积换算成帖数后，与图上标注偏差超过 `AREA_MISMATCH_TOLERANCE` 就报 warning。
 *
 * 这类偏差通常意味着模型把房间的轮廓画错了（把隔壁的一块也圈了进来），
 * 比例本身是全局最小二乘出来的，所以「个别房间偏差大」是可靠的错误信号。
 */
export function buildRooms(
  source: readonly RecognizedRoom[],
  polygons: readonly Pt[][],
): BuildRoomsResult {
  const rooms: Room[] = [];
  const mismatchedRoomIds: string[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < source.length; i++) {
    const polygon = polygons[i];
    if (!polygon || polygon.length < 3) continue;
    const name = source[i].name || '房间';
    const room: Room = { id: newId('r'), name, floor: source[i].floor, polygon };
    rooms.push(room);

    const labelled = source[i].tatamiCount;
    if (labelled === null || !(labelled > 0)) continue;
    const actual = polygonAreaMm2(polygon) / TATAMI_AREA_MM2;
    if (!(actual > 0)) continue;
    const deviation = Math.abs(actual - labelled) / labelled;
    if (deviation > AREA_MISMATCH_TOLERANCE) {
      mismatchedRoomIds.push(room.id);
      warnings.push(
        `房间「${name}」面积（${actual.toFixed(1)}帖）与标注（${labelled}帖）偏差 ${Math.round(deviation * 100)}%，建议核对`,
      );
    }
  }

  return { rooms, mismatchedRoomIds, warnings };
}

// ---------------------------------------------------------------------------
// 8. alignUnderlay
// ---------------------------------------------------------------------------

/**
 * 底图对齐：归一化 x=1000 对应图片右边缘，所以 `mmPerPixel = k × 1000 / imageWidthPx`；
 * 图片左上角（归一化原点）在文档里的位置正好是步骤 3 的平移量。
 */
export function alignUnderlay(k: number, imageWidthPx: number, translation: Pt): SolvedUnderlay {
  const mmPerPixel = imageWidthPx > 0 ? (k * NORM_MAX) / imageWidthPx : k;
  return { mmPerPixel, offset: roundPt(translation) };
}

// ---------------------------------------------------------------------------
// 端到端
// ---------------------------------------------------------------------------

export function solveRecognizeResult(result: RecognizeResult, options: SolveOptions): SolveResult {
  const warnings: string[] = [];

  const scale = estimateScale(result);
  warnings.push(...scale.warnings);
  const k = scale.k;

  // 2. 规整（轴对齐边吸附、斜边保留；同时丢掉退化的房间）
  const kept: RecognizedRoom[] = [];
  const rectified: Pt[][] = [];
  for (const room of result.rooms) {
    const poly = regularizePolygon(room.polygon, k);
    if (poly.length < 3) {
      warnings.push(`房间「${room.name}」的轮廓无法规整成有效多边形，已跳过`);
      continue;
    }
    kept.push(room);
    rectified.push(poly);
  }

  if (rectified.length === 0) {
    return {
      walls: [],
      openings: [],
      structures: [],
      rooms: [],
      underlay: alignUnderlay(k, options.imageWidthPx, { x: 0, y: 0 }),
      mmPerUnit: k,
      areaMismatchRoomIds: [],
      warnings: [...warnings, '没有识别到任何可用的房间'],
    };
  }

  // 3. 共边归并 + 网格吸附 + 平移
  const snapped = snapSharedEdges(rectified);
  const transform: PlanTransform = {
    k,
    xMap: snapped.xMap,
    yMap: snapped.yMap,
    translation: snapped.translation,
  };

  // 4. 墙
  const walls = deriveWalls(snapped.polygons);

  // 5. 洞口
  const roomSegments = new Map<string, RoomEdges>();
  for (let i = 0; i < kept.length; i++) {
    roomSegments.set(kept[i].id, polygonEdges(snapped.polygons[i]));
  }
  const openings = placeOpenings({
    openings: result.openings,
    roomSegments,
    walls,
    transform,
  });
  warnings.push(...openings.warnings);

  // 6~8
  const structures = convertColumns(result.columns, transform);
  const built = buildRooms(kept, snapped.polygons);
  warnings.push(...built.warnings);
  const underlay = alignUnderlay(k, options.imageWidthPx, snapped.translation);

  return {
    walls,
    openings: openings.openings,
    structures,
    rooms: built.rooms,
    underlay,
    mmPerUnit: k,
    areaMismatchRoomIds: built.mismatchedRoomIds,
    warnings,
  };
}
