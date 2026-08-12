/**
 * M4-CV 阶段 B：CV 几何 + VLM 语义 的融合器（见 docs/CV-PIPELINE.md 第 3 节）。
 *
 *   fuseCvAndVlm(cvExtract, recognizeResult, { imageWidthPx, imageHeightPx }) → SolveResult
 *
 * 输出与 `solveRecognizeResult` **同型**，所以 `applyRecognition` / UI 一行都不用改。
 *
 * 分工：
 * - **几何全部来自 CV**（墙段中心线、房间多边形都是像素级精确的）；
 * - **语义全部来自 VLM**（房间名 / 地面材质 / 帖数 / 门窗类型 / 柱）；
 * - 比例也主要靠两边合作：VLM 的帖数标注 ÷ CV 的房间像素面积 → mm/px，
 *   比任何一方单独估都准（CV 面积精确，帖数是图上白纸黑字）。
 *
 * 管线：
 *   1. cleanWalls       图片外框线过滤 + 短斜段噪声过滤（阶段 A 的两个遗留项）
 *   2. mountSemantics   VLM 房间中心点落在哪个 CV 房间里 → 语义挂载
 *   3. estimateCvScale  Σ帖数 ÷ Σ房间像素面积 → mm/px（退路：VLM 的图纸总宽）
 *   4. 墙 / 房间 → mm → 轴向 455 吸附、斜向 100 吸附（复用 solve.ts 的常量与函数）
 *   5. 门窗 / 柱 / 帖数校验 / 底图对齐 —— 直接复用 solve.ts 的对应步骤
 *
 * **纯函数**：不 import opencv（只用 `src/cv/types.ts` 的类型与 `src/cv/geometry.ts` 的纯几何），
 * 因此可以在 vitest 里直接跑 fixture。
 */
import type { CvExtract, CvRoom } from '../cv/types';
import { joinTJunctions } from '../cv/geometry';
import { roundPt } from '../model/defaults';
import type { Pt } from '../model/types';
import { TATAMI_AREA_MM2 } from '../utils/units';
import {
  type PlanTransform,
  type RoomEdges,
  type SolveResult,
  buildRooms,
  convertColumns,
  dropCollinear,
  placeOpenings,
  polygonEdges,
  regularizePolygon,
} from './solve';
import {
  CV_EDGE_CLUSTER_TOLERANCE_MM,
  CV_THICKNESS_CORRECTION,
  MIN_DIAGONAL_WALL_MM,
  MIN_MM_PER_PX,
  MAX_MM_PER_PX,
  T_JOIN_MIN_MM,
  dropBorderWalls,
  median,
  pointInPolygon,
  polygonCentroid,
  segLen,
  segmentsToWalls,
  snapGeometry,
  toMmSegments,
} from './cvGeometry';
import {
  NORM_MAX,
  type RecognizeResult,
  type RecognizedColumn,
  type RecognizedOpening,
  type RecognizedRoom,
} from './recognizeSchema';

// 公共几何原样再导出：fuse.test.ts 与既有调用方的 import 路径不变
export {
  BORDER_MARGIN_FRAC,
  BORDER_SPAN_FRAC,
  CV_EDGE_CLUSTER_TOLERANCE_MM,
  CV_THICKNESS_CORRECTION,
  MAX_MM_PER_PX,
  MIN_DIAGONAL_WALL_MM,
  MIN_MM_PER_PX,
  MIN_WALL_MM,
  dropBorderWalls,
  pointInPolygon,
  polygonCentroid,
  type CleanWallsResult,
  type SnapGeometryResult,
} from './cvGeometry';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * M4.1 语义兜底：中心点挂载失败时，改用「VLM 多边形 ∩ CV 区域」的 IoU，
 * 超过这个值的最大者当宿主。0.3 是「大致是同一块地方」的量级——
 * VLM 画的轮廓本来就潦草，要求更高会一个都救不回来。
 */
export const SEMANTIC_IOU_MIN = 0.3;
/** IoU 采样网格边长（96×96 ≈ 9k 个点，对 0.3 这种阈值精度绰绰有余） */
const IOU_GRID = 96;
/** M4.1 无名碎块合并：小于这个帖数的无名块并入相邻具名房间 */
export const FRAGMENT_MAX_TATAMI = 1.5;
/** 多边形合并的坐标容差 mm */
const MERGE_TOL_MM = 1.5;
/** M4.2 小隔间判定：标注帖数小于这个值就算小隔间 */
export const SMALL_ROOM_MAX_TATAMI = 3;

/**
 * M4.2 小隔间的名称清单（**归一化后**的片段，做子串匹配）。
 *
 * 低分辨率的間取り图上，这些隔间在 CV 那边根本提不出独立连通域（几十像素、
 * 还被文字压着），VLM 却一定会给出来 —— 结果就是「挂载失败 → 丢弃 → 一条 warning」，
 * 一张图能刷出五六条噪声。默认把它们安静跳过，用户需要时自己画（2026-08-11 用户裁定）。
 */
export const SMALL_ROOM_NAME_PATTERNS: readonly string[] = [
  '洗面所',
  '洗面室',
  '洗面脱衣',
  '脱衣所',
  '脱衣室',
  'トイレ',
  'wc',
  '便所',
  '玄関',
  '廊下',
  'ホール',
  '納戸',
  'クローゼット',
  'クロゼット',
  'wic',
  'sic',
  'シューズクローク',
  '収納',
];

/**
 * 房间名归一化：NFKC（全角字母 → 半角、半角片假名 → 全角片假名）+ 小写 + 去掉
 * 空白与常见分隔符。`ＷＣ` / `ｳｫｰｸｲﾝｸﾛｰｾﾞｯﾄ` / `玄関・ホール` 都能落到同一条判据上。
 */
export function normalizeRoomName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s・･,，、.．。/／\\|｜~〜\-–—_＋+()（）[\]「」『』【】]/g, '');
}

/**
 * 是不是「小隔间」：标了帖数且不足 3 帖，或者名字命中清单。
 *
 * 注意只看**语义**，不看几何：这个判据要在挂载失败（拿不到任何几何）时也能用。
 */
export function isSmallRoom(room: Pick<RecognizedRoom, 'name' | 'tatamiCount'>): boolean {
  if (room.tatamiCount !== null && room.tatamiCount < SMALL_ROOM_MAX_TATAMI) return true;
  const name = normalizeRoomName(room.name ?? '');
  if (!name) return false;
  return SMALL_ROOM_NAME_PATTERNS.some((p) => name.includes(p));
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 两个多边形的 IoU（**采样法**）。
 *
 * 不用精确的多边形布尔运算：CV 房间是凹多边形（L 型、带阶梯的都有），
 * Sutherland–Hodgman 那类算法要求裁剪多边形是凸的，靠不住；
 * 而这里只需要判「是不是大致同一块地方」，网格采样又快又不会算错。
 */
export function polygonIoU(a: readonly Pt[], b: readonly Pt[], grid = IOU_GRID): number {
  if (a.length < 3 || b.length < 3) return 0;
  const xs = [...a, ...b].map((p) => p.x);
  const ys = [...a, ...b].map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  if (!(x1 > x0) || !(y1 > y0)) return 0;

  const stepX = (x1 - x0) / grid;
  const stepY = (y1 - y0) / grid;
  let inter = 0;
  let union = 0;
  for (let gy = 0; gy < grid; gy++) {
    const y = y0 + (gy + 0.5) * stepY;
    for (let gx = 0; gx < grid; gx++) {
      const p = { x: x0 + (gx + 0.5) * stepX, y };
      const inA = pointInPolygon(p, a);
      const inB = pointInPolygon(p, b);
      if (inA && inB) inter++;
      if (inA || inB) union++;
    }
  }
  return union > 0 ? inter / union : 0;
}

/** 归一化坐标 → 图片像素。注意 y 与 x 同一比例尺（都按图片**宽度**归一化） */
function normToPx(v: number, imageWidthPx: number): number {
  return (v / NORM_MAX) * imageWidthPx;
}

// ---------------------------------------------------------------------------
// 2. 语义挂载
// ---------------------------------------------------------------------------

export interface MountResult {
  /** 与 `cvRooms` 一一对应：挂上的 VLM 房间，没有就是 null */
  hosts: Array<RecognizedRoom | null>;
  /** VLM 房间 id → 它落在的 CV 房间下标 */
  roomIndexById: Map<string, number>;
  /** 靠 IoU 兜底才挂上的房间数（M4.1） */
  iouMounted: number;
  /** M4.2：挂载失败、按「小隔间」安静跳过的房间数（没有产生 warning） */
  ignoredSmallRooms: number;
  warnings: string[];
}

export interface MountOptions {
  /**
   * M4.2：挂载失败的**小隔间**（洗面所 / トイレ / 玄関 …，见 `isSmallRoom`）
   * 安静跳过，不产生 warning，只计数。默认 `true`。
   */
  ignoreSmallRooms?: boolean;
}

/** 一次挂载申领 */
interface Claim {
  room: RecognizedRoom;
  /** 'center' = 中心点落在里面（强）；'iou' = 靠重叠面积兜底（弱） */
  kind: 'center' | 'iou';
  /** center：中心到 CV 重心的距离（越小越好）；iou：1 − IoU（越小越好） */
  cost: number;
}

/**
 * 语义挂载：VLM 房间中心（归一化 → px）落在哪个 CV 房间多边形里，就把语义挂给它。
 *
 * - 一个 CV 房间被多个 VLM 房间命中 → 取中心离 CV 房间重心最近的那个，其余丢弃并警告；
 * - VLM 房间落不进任何 CV 房间 → 丢弃并警告（多半是 VLM 把轮廓画飞了）；
 * - CV 房间没人认领 → 后面按「房间」处理并警告（多半是收纳/バルコニー这类 VLM 没画的区域）。
 *
 * 中心点依次试三个候选：面积重心 → 顶点均值 → 包围盒中心。凹多边形（L 型房间）的
 * 面积重心可能落在房间外面，多试两个就能救回来。
 *
 * M4.2：`ignoreSmallRooms`（默认开）时，**挂载失败**的小隔间不再刷 warning，
 * 只计进 `ignoredSmallRooms`。挂载成功的小隔间完全不受影响。
 */
export function mountSemantics(
  cvRooms: readonly CvRoom[],
  vlmRooms: readonly RecognizedRoom[],
  imageWidthPx: number,
  opts: MountOptions = {},
): MountResult {
  const ignoreSmall = opts.ignoreSmallRooms !== false;
  const warnings: string[] = [];
  const hosts: Array<RecognizedRoom | null> = cvRooms.map(() => null);
  const roomIndexById = new Map<string, number>();
  /** CV 房间下标 → 竞争者 */
  const claims = new Map<number, Claim[]>();
  let iouMounted = 0;
  let ignoredSmallRooms = 0;

  /** 挂载失败的收尾：小隔间安静计数，其余照旧 warning */
  const dropRoom = (room: RecognizedRoom, warning: string) => {
    if (ignoreSmall && isSmallRoom(room)) {
      ignoredSmallRooms += 1;
      return;
    }
    warnings.push(warning);
  };

  const cvCentroids = cvRooms.map((r) => polygonCentroid(r.polygon));
  const addClaim = (index: number, claim: Claim) => {
    const list = claims.get(index);
    if (list) list.push(claim);
    else claims.set(index, [claim]);
  };

  for (const room of vlmRooms) {
    const pts = room.polygon.map((p) => ({
      x: normToPx(p.x, imageWidthPx),
      y: normToPx(p.y, imageWidthPx),
    }));
    if (pts.length < 3) {
      dropRoom(room, `房间「${room.name}」的轮廓点太少，无法挂到图纸上，已跳过`);
      continue;
    }
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const candidates: Pt[] = [
      polygonCentroid(pts),
      { x: xs.reduce((a, b) => a + b, 0) / xs.length, y: ys.reduce((a, b) => a + b, 0) / ys.length },
      { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 },
    ];

    let hit = -1;
    let center: Pt | null = null;
    for (const c of candidates) {
      for (let i = 0; i < cvRooms.length; i++) {
        if (pointInPolygon(c, cvRooms[i].polygon)) {
          hit = i;
          center = c;
          break;
        }
      }
      if (hit >= 0) break;
    }

    if (hit >= 0 && center) {
      const dist = Math.hypot(center.x - cvCentroids[hit].x, center.y - cvCentroids[hit].y);
      addClaim(hit, { room, kind: 'center', cost: dist });
      continue;
    }

    // M4.1 兜底：中心点挂不上（凹房间、VLM 把轮廓画偏了、CV 把房间切碎了）
    // 就退一步比「重叠面积」。IoU 最大且过阈值的那块 CV 区域收留它。
    let bestIndex = -1;
    let bestIoU = 0;
    for (let i = 0; i < cvRooms.length; i++) {
      const iou = polygonIoU(pts, cvRooms[i].polygon);
      if (iou > bestIoU) {
        bestIoU = iou;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0 && bestIoU >= SEMANTIC_IOU_MIN) {
      addClaim(bestIndex, { room, kind: 'iou', cost: 1 - bestIoU });
      continue;
    }

    dropRoom(room, `房间「${room.name}」的中心没有落进任何提取出来的房间轮廓，已丢弃`);
  }

  const rank = (c: Claim) => (c.kind === 'center' ? 0 : 1);
  for (const [index, list] of claims) {
    // 中心点命中永远压过 IoU 兜底；同类再比 cost
    list.sort((a, b) => rank(a) - rank(b) || a.cost - b.cost);
    hosts[index] = list[0].room;
    roomIndexById.set(list[0].room.id, index);
    if (list[0].kind === 'iou') iouMounted += 1;
    for (const loser of list.slice(1)) {
      dropRoom(
        loser.room,
        `房间「${loser.room.name}」与「${list[0].room.name}」落在同一块区域里，只保留了后者`,
      );
    }
  }
  if (iouMounted > 0) {
    warnings.push(`有 ${iouMounted} 个房间是按轮廓重叠面积（IoU）兜底挂上的，位置可能略有出入`);
  }

  const orphans = hosts.filter((h) => h === null).length;
  if (orphans > 0) {
    warnings.push(`有 ${orphans} 块提取出来的区域没有对应的房间名（已命名为「房间」），请人工确认`);
  }

  return { hosts, roomIndexById, iouMounted, ignoredSmallRooms, warnings };
}

// ---------------------------------------------------------------------------
// 2b. 无名碎块合并（M4.1）
// ---------------------------------------------------------------------------

interface MmEdge {
  a: Pt;
  b: Pt;
}

function polySignedArea(poly: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

export function polygonArea(poly: readonly Pt[]): number {
  return Math.abs(polySignedArea(poly));
}

/** 统一绕向（正面积），保证两个多边形的边方向可比 */
function toPositive(poly: readonly Pt[]): Pt[] {
  return polySignedArea(poly) < 0 ? [...poly].reverse() : [...poly];
}

function polyEdges(poly: readonly Pt[]): MmEdge[] {
  const out: MmEdge[] = [];
  for (let i = 0; i < poly.length; i++) out.push({ a: poly[i], b: poly[(i + 1) % poly.length] });
  return out;
}

function edgeLength(e: MmEdge): number {
  return Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
}

/**
 * 两条边**反向共线**时的重叠区间（用 `e` 的弧长参数表示）。没有重叠返回 null。
 *
 * 「反向」是关键：两个多边形绕向一致时，它们的**公共边**方向必然相反，
 * 而各自的外边界不会。抵消掉所有反向共线的重叠段，剩下的就是并集的轮廓。
 */
function overlapInterval(e: MmEdge, f: MmEdge, tol: number): { from: number; to: number } | null {
  const el = edgeLength(e);
  const fl = edgeLength(f);
  if (el < tol || fl < tol) return null;
  const ux = (e.b.x - e.a.x) / el;
  const uy = (e.b.y - e.a.y) / el;
  const dot = ((f.b.x - f.a.x) * ux + (f.b.y - f.a.y) * uy) / fl;
  if (dot > -0.999) return null;

  const nx = -uy;
  const ny = ux;
  const d1 = (f.a.x - e.a.x) * nx + (f.a.y - e.a.y) * ny;
  const d2 = (f.b.x - e.a.x) * nx + (f.b.y - e.a.y) * ny;
  if (Math.abs(d1) > tol || Math.abs(d2) > tol) return null;

  const t1 = (f.a.x - e.a.x) * ux + (f.a.y - e.a.y) * uy;
  const t2 = (f.b.x - e.a.x) * ux + (f.b.y - e.a.y) * uy;
  const from = Math.max(0, Math.min(t1, t2));
  const to = Math.min(el, Math.max(t1, t2));
  return to - from >= tol ? { from, to } : null;
}

/** 两个多边形的公共边总长（挑「并到哪个邻居」用的判据） */
export function sharedEdgeLength(a: readonly Pt[], b: readonly Pt[], tol = MERGE_TOL_MM): number {
  const ea = polyEdges(toPositive(a));
  const eb = polyEdges(toPositive(b));
  let total = 0;
  for (const e of ea) {
    for (const f of eb) {
      const ov = overlapInterval(e, f, tol);
      if (ov) total += ov.to - ov.from;
    }
  }
  return total;
}

/** 从一条边里挖掉若干区间，返回剩下的片段 */
function subtractIntervals(e: MmEdge, cuts: Array<{ from: number; to: number }>, tol: number): MmEdge[] {
  const len = edgeLength(e);
  if (len < tol) return [];
  const ux = (e.b.x - e.a.x) / len;
  const uy = (e.b.y - e.a.y) / len;
  const at = (t: number): Pt => ({ x: e.a.x + ux * t, y: e.a.y + uy * t });

  const sorted = [...cuts].sort((p, q) => p.from - q.from);
  const out: MmEdge[] = [];
  let cursor = 0;
  for (const c of sorted) {
    if (c.from > cursor + tol) out.push({ a: at(cursor), b: at(c.from) });
    cursor = Math.max(cursor, c.to);
  }
  if (len > cursor + tol) out.push({ a: at(cursor), b: at(len) });
  return out;
}

/** 把一堆首尾相接的边串成一个环；串不成（多个环 / 有断口）返回 null */
function chainRing(edges: readonly MmEdge[], tol: number): Pt[] | null {
  if (edges.length < 3) return null;
  const used = new Uint8Array(edges.length);
  const ring: Pt[] = [edges[0].a, edges[0].b];
  used[0] = 1;
  let cursor = edges[0].b;
  const start = edges[0].a;

  for (let guard = 0; guard < edges.length; guard++) {
    if (Math.hypot(cursor.x - start.x, cursor.y - start.y) <= tol) break;
    let next = -1;
    let bestDist = tol;
    for (let i = 0; i < edges.length; i++) {
      if (used[i]) continue;
      const d = Math.hypot(edges[i].a.x - cursor.x, edges[i].a.y - cursor.y);
      if (d <= bestDist) {
        bestDist = d;
        next = i;
      }
    }
    if (next < 0) return null;
    used[next] = 1;
    cursor = edges[next].b;
    ring.push(cursor);
  }

  if (Math.hypot(cursor.x - start.x, cursor.y - start.y) > tol) return null;
  for (let i = 0; i < edges.length; i++) if (!used[i]) return null; // 还剩下别的环 → 不是简单相邻
  ring.pop(); // 首尾重合，去掉最后一个
  return ring.length >= 3 ? ring : null;
}

/**
 * 共享边拼接式的多边形并集（只处理「两块贴在一起、边界部分重合」这种情形）。
 *
 * 做法：两个多边形取同一绕向 → 把**反向共线且重叠**的边段成对抵消 →
 * 剩下的边首尾相接串成一个环。矩形/L 型/带阶梯的直角多边形全都吃得下，
 * 而且不会像凸包那样把中间的墙也吞进去。
 *
 * 失败（拼不成单个环 / 面积对不上）返回 null，调用方原样保留两块。
 */
export function unionAdjacentPolygons(
  a: readonly Pt[],
  b: readonly Pt[],
  tol = MERGE_TOL_MM,
): Pt[] | null {
  if (a.length < 3 || b.length < 3) return null;
  const pa = toPositive(a);
  const pb = toPositive(b);
  const ea = polyEdges(pa).map((e) => ({ e, cuts: [] as Array<{ from: number; to: number }> }));
  const eb = polyEdges(pb).map((e) => ({ e, cuts: [] as Array<{ from: number; to: number }> }));

  let shared = 0;
  for (const sa of ea) {
    for (const sb of eb) {
      const ov = overlapInterval(sa.e, sb.e, tol);
      if (!ov) continue;
      shared += ov.to - ov.from;
      sa.cuts.push(ov);
      const back = overlapInterval(sb.e, sa.e, tol);
      if (back) sb.cuts.push(back);
    }
  }
  if (shared < tol) return null;

  const pieces: MmEdge[] = [];
  for (const s of [...ea, ...eb]) pieces.push(...subtractIntervals(s.e, s.cuts, tol));

  const ring = chainRing(pieces, tol);
  if (!ring) return null;

  const expected = polygonArea(pa) + polygonArea(pb);
  const got = polygonArea(ring);
  if (expected <= 0 || Math.abs(got - expected) / expected > 0.02) return null;
  return dropCollinear(ring.map((p) => roundPt(p)));
}

export interface FragmentMergeResult {
  polygons: Pt[][];
  /** 被并掉（不再单独成房间）的下标 */
  absorbed: number[];
  warnings: string[];
}

/**
 * 无名碎块合并：面积小于 `maxAreaMm2` 的**无名**区域，并进与它公共边最长的**具名**邻居。
 *
 * 这些碎块基本都是虚线/孤岛剔除之后残留的切口，或者门槛线把房间削出来的一小条；
 * 单独留着就会在成果里冒出「房间 · 1.2 帖」这种东西。
 * 拼不出合法多边形时（不相邻、拼出多个环）就原样留着，不硬来。
 */
export function mergeUnnamedFragments(
  polygons: readonly Pt[][],
  named: readonly boolean[],
  maxAreaMm2: number,
): FragmentMergeResult {
  const out = polygons.map((p) => [...p]);
  const absorbed: number[] = [];
  const warnings: string[] = [];

  const order = polygons
    .map((poly, i) => ({ i, area: polygonArea(poly) }))
    .filter(({ i, area }) => !named[i] && area > 0 && area < maxAreaMm2)
    .sort((a, b) => a.area - b.area);

  for (const { i } of order) {
    let best = -1;
    let bestShared = 0;
    for (let j = 0; j < out.length; j++) {
      if (j === i || !named[j] || absorbed.includes(j)) continue;
      const shared = sharedEdgeLength(out[i], out[j]);
      if (shared > bestShared) {
        bestShared = shared;
        best = j;
      }
    }
    if (best < 0) continue;
    const merged = unionAdjacentPolygons(out[best], out[i]);
    if (!merged) continue;
    out[best] = merged;
    absorbed.push(i);
  }

  if (absorbed.length > 0) {
    warnings.push(`把 ${absorbed.length} 块无名小区域并进了相邻的房间（多半是虚线/孤岛剔除后留下的切口）`);
  }
  return { polygons: out, absorbed, warnings };
}

// ---------------------------------------------------------------------------
// 3. 比例
// ---------------------------------------------------------------------------

export interface CvScaleEstimate {
  /** mm / 像素 */
  mmPerPx: number;
  basis: 'tatami' | 'drawing_width';
  warnings: string[];
}

/**
 * 比例估计：`mm/px = sqrt(Σ(帖数 × 1.6562e6 mm²) / Σ(对应 CV 房间的像素面积))`。
 *
 * 只用**挂载成功且标了帖数**的房间对：CV 的像素面积是连通域实测，比 VLM 自己画的
 * 多边形可靠得多。没有任何帖数标注时退回 VLM 的 `drawingWidthMm`（假定图纸总宽 = 图片宽）。
 */
export function estimateCvScale(
  cvRooms: readonly CvRoom[],
  hosts: ReadonlyArray<RecognizedRoom | null>,
  vlm: RecognizeResult,
  imageWidthPx: number,
): CvScaleEstimate {
  const warnings: string[] = [];

  let tatamiSum = 0;
  let areaSum = 0;
  let pairs = 0;
  for (let i = 0; i < cvRooms.length; i++) {
    const host = hosts[i];
    if (!host || host.tatamiCount === null || !(host.tatamiCount > 0)) continue;
    const area = cvRooms[i].areaPx;
    if (!(area > 0)) continue;
    tatamiSum += host.tatamiCount;
    areaSum += area;
    pairs += 1;
  }

  const fallback = () => {
    const k = vlm.scale.drawingWidthMm / imageWidthPx;
    if (Number.isFinite(k) && k >= MIN_MM_PER_PX && k <= MAX_MM_PER_PX) {
      return { mmPerPx: k, basis: 'drawing_width' as const, warnings };
    }
    warnings.push('无法可靠估算比例，已按 1px = 20mm 兜底，请用底图标定工具校正');
    return { mmPerPx: 20, basis: 'drawing_width' as const, warnings };
  };

  if (tatamiSum > 0 && areaSum > 0) {
    const k = Math.sqrt((tatamiSum * TATAMI_AREA_MM2) / areaSum);
    if (Number.isFinite(k) && k >= MIN_MM_PER_PX && k <= MAX_MM_PER_PX) {
      warnings.push(
        `比例来源：${pairs} 个房间的帖数标注（合计 ${round(tatamiSum, 1)} 帖）÷ 轮廓提取的像素面积 → 1px ≈ ${round(k, 2)}mm`,
      );
      return { mmPerPx: k, basis: 'tatami', warnings };
    }
    warnings.push('帖数与提取出来的面积明显矛盾，已改用图纸总宽估算比例');
    return fallback();
  }

  warnings.push('图上没有可用的帖数标注，比例按 AI 估的图纸总宽推算，实际尺寸可能有偏差');
  return fallback();
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}


// ---------------------------------------------------------------------------
// 端到端
// ---------------------------------------------------------------------------

export interface FuseOptions {
  imageWidthPx: number;
  imageHeightPx: number;
  /**
   * M4.2：挂载失败的小隔间（洗面所 / トイレ / 玄関 …）安静跳过，不刷 warning。
   * 默认 `true`——低分辨率的間取り图上这些隔间 CV 提不出来，留着只有噪声。
   * 传 `false` 恢复 M4.1 的行为（丢弃 + 每个一条 warning）。
   */
  ignoreSmallRooms?: boolean;
}

/** 融合器额外吐出来的统计（server 放进响应里给 UI 显示） */
export interface FuseStats {
  cvWalls: number;
  cvRooms: number;
  /** 被判为图片外框而丢弃的墙段数 */
  borderWallsDropped: number;
  /** 被判为噪声而丢弃的短斜段数 */
  shortDiagonalsDropped: number;
  /** 语义挂载成功的房间数 */
  matchedRooms: number;
  /** 其中靠 IoU 兜底才挂上的（M4.1） */
  iouMountedRooms: number;
  /** 被并进相邻具名房间的无名碎块数（M4.1） */
  unnamedMerged: number;
  /** 挂载失败、按「小隔间」安静忽略掉的房间数（M4.2） */
  ignoredSmallRooms: number;
  scaleBasis: CvScaleEstimate['basis'];
  mmPerPixel: number;
}

export interface FuseResult extends SolveResult {
  fuseStats: FuseStats;
}

function emptyResult(mmPerPx: number, warnings: string[], stats: FuseStats): FuseResult {
  return {
    walls: [],
    openings: [],
    structures: [],
    rooms: [],
    underlay: { mmPerPixel: mmPerPx, offset: { x: 0, y: 0 }, rotation: 0 },
    mmPerUnit: mmPerPx,
    areaMismatchRoomIds: [],
    warnings,
    fuseStats: stats,
  };
}

/**
 * CV 几何 + VLM 语义 → 可直接写进 PlanDoc 的 `SolveResult`。
 *
 * `mmPerUnit` 的语义在这条路径下是 **mm / 图片像素**（纯 VLM 路径是 mm / 归一化单位），
 * 因为这里所有几何都以像素为原始坐标系；下游只把它当「比例」展示，不做换算。
 */
export function fuseCvAndVlm(cv: CvExtract, vlm: RecognizeResult, opts: FuseOptions): FuseResult {
  const warnings: string[] = [];
  const imageWidthPx = opts.imageWidthPx > 0 ? opts.imageWidthPx : cv.stats.imageWidthPx;
  const imageHeightPx = opts.imageHeightPx > 0 ? opts.imageHeightPx : cv.stats.imageHeightPx;

  // 1. 墙段清洗：图片外框
  const cleaned = dropBorderWalls(cv.walls, imageWidthPx, imageHeightPx, cv.stats.wallStrokePx);
  if (cleaned.borderDropped > 0) {
    warnings.push(`已忽略 ${cleaned.borderDropped} 段贴着图片边缘的装饰边框线`);
  }

  // 2. 语义挂载（在像素空间做，不依赖比例）
  const mount = mountSemantics(cv.rooms, vlm.rooms, imageWidthPx, {
    ignoreSmallRooms: opts.ignoreSmallRooms,
  });
  warnings.push(...mount.warnings);
  const matchedRooms = mount.hosts.filter((h) => h !== null).length;

  // 3. 比例
  const scale = estimateCvScale(cv.rooms, mount.hosts, vlm, imageWidthPx);
  warnings.push(...scale.warnings);
  const mmPerPx = scale.mmPerPx;

  const baseStats: FuseStats = {
    cvWalls: cv.walls.length,
    cvRooms: cv.rooms.length,
    borderWallsDropped: cleaned.borderDropped,
    shortDiagonalsDropped: 0,
    matchedRooms,
    iouMountedRooms: mount.iouMounted,
    unnamedMerged: 0,
    ignoredSmallRooms: mount.ignoredSmallRooms,
    scaleBasis: scale.basis,
    mmPerPixel: mmPerPx,
  };

  // 4. 墙段 → mm，丢短斜段噪声
  let segments = toMmSegments(cleaned.walls, mmPerPx);
  const beforeDiagonals = segments.length;
  segments = segments.filter((s) => s.orient !== 'd' || segLen(s) >= MIN_DIAGONAL_WALL_MM);
  const shortDiagonalsDropped = beforeDiagonals - segments.length;
  if (shortDiagonalsDropped > 0) {
    warnings.push(`已忽略 ${shortDiagonalsDropped} 段过短的斜线（多半是填色边缘的锯齿）`);
  }
  baseStats.shortDiagonalsDropped = shortDiagonalsDropped;

  // T 型接点闭合：半径取一道墙的厚度量级（厚度乘经验系数 0.8 修正）
  const thicknessMm =
    median(cv.walls.map((w) => w.thicknessPx)) * mmPerPx * CV_THICKNESS_CORRECTION;
  const joinRadius = Math.max(T_JOIN_MIN_MM, thicknessMm * 1.5);
  const joined = joinTJunctions(segments, joinRadius);
  segments = joined.map((s, i) => ({ ...s, orient: segments[i].orient }));

  // 4b. 房间多边形 → mm（近轴边吸成轴向，斜边如实保留）
  const rectified: Pt[][] = [];
  const keptRooms: number[] = [];
  for (let i = 0; i < cv.rooms.length; i++) {
    const poly = regularizePolygon(cv.rooms[i].polygon, mmPerPx);
    if (poly.length < 3) continue;
    rectified.push(poly);
    keptRooms.push(i);
  }

  if (rectified.length === 0 && segments.length === 0) {
    return emptyResult(mmPerPx, [...warnings, '没有可用的墙体或房间几何'], baseStats);
  }

  // 4c. 轴聚类 + 吸附 + 平移
  const snapped = snapGeometry(rectified, segments, CV_EDGE_CLUSTER_TOLERANCE_MM);
  const transform: PlanTransform = {
    k: mmPerPx,
    xMap: snapped.xMap,
    yMap: snapped.yMap,
    translation: snapped.translation,
  };

  const walls = segmentsToWalls(snapped.segments);

  // 5. 无名碎块合并（M4.1）：并进公共边最长的具名邻居
  const named = keptRooms.map((i) => mount.hosts[i] !== null);
  const fragments = mergeUnnamedFragments(
    snapped.polygons,
    named,
    FRAGMENT_MAX_TATAMI * TATAMI_AREA_MM2,
  );
  warnings.push(...fragments.warnings);
  baseStats.unnamedMerged = fragments.absorbed.length;
  const absorbed = new Set(fragments.absorbed);
  const finalIndices = keptRooms.map((_, idx) => idx).filter((idx) => !absorbed.has(idx));
  const finalPolygons = finalIndices.map((idx) => fragments.polygons[idx]);

  // 6. 房间（语义 + 帖数校验都复用 solve.ts 的 buildRooms）
  const source: RecognizedRoom[] = finalIndices.map((idx) => {
    const host = mount.hosts[keptRooms[idx]];
    return host
      ? { id: host.id, name: host.name, floor: host.floor, tatamiCount: host.tatamiCount, polygon: [] }
      : { id: `cv${keptRooms[idx]}`, name: '房间', floor: 'other' as const, tatamiCount: null, polygon: [] };
  });
  const built = buildRooms(source, finalPolygons);
  warnings.push(...built.warnings);

  // 7. 门窗：VLM 的归一化坐标 → 像素，再走 solve.ts 原来的投影逻辑
  const roomSegments = new Map<string, RoomEdges>();
  for (let n = 0; n < finalIndices.length; n++) {
    const host = mount.hosts[keptRooms[finalIndices[n]]];
    if (host) roomSegments.set(host.id, polygonEdges(finalPolygons[n]));
  }
  const openings = placeOpenings({
    openings: vlm.openings.map(
      (o): RecognizedOpening => ({
        ...o,
        x: normToPx(o.x, imageWidthPx),
        y: normToPx(o.y, imageWidthPx),
      }),
    ),
    roomSegments,
    walls,
    transform,
  });
  warnings.push(...openings.warnings);

  // 8. 柱：沿用 VLM（CV 还没有实心块检测）
  const structures = convertColumns(
    vlm.columns.map(
      (c): RecognizedColumn => ({
        x: normToPx(c.x, imageWidthPx),
        y: normToPx(c.y, imageWidthPx),
        w: c.w === null ? null : normToPx(c.w, imageWidthPx),
        h: c.h === null ? null : normToPx(c.h, imageWidthPx),
      }),
    ),
    transform,
  );

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
    fuseStats: baseStats,
  };
}
