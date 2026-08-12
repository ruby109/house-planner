/**
 * M5.1：**建筑轮廓外剔除**（见 docs/CV-PIPELINE.md 第 9 节）。
 *
 * 指北针、图例、家具示意、比例尺……这些装饰图形有一个雷打不动的共同点：
 * **永远画在建筑轮廓之外**。M4.1 的孤岛剔除只抓「与主墙网不连通 + 比墙细」的，
 * 指北针的指针一旦蹭到图框线（test2）或者本身够粗（test5 的竖针）就能逃掉。
 *
 * 这里换一条正交的判据：
 *
 *   建筑轮廓 = **主墙网围出来的那一片**（含所有内部空腔）∪ CV 房间并集 → 向外扩 1× 墙厚
 *   三个采样点（两端 + 中点）都落在轮廓之外的墙段 → 剔除
 *
 * 三个细节是跑 test2 / test5 跑出来的，规格里没写但缺了就误杀真墙：
 *
 * 1. **轮廓要用「墙网围出来的面」，不能只用房间并集**。低分辨率图上 CV 分不出的
 *    洗面所 / トイレ / 廊下 在房间并集里是一整片空白，而且顺着玄关一路通到图外
 *    （不是封闭的洞，填洞救不了）—— 实测 test2 会误杀 8 段真内墙。
 *    改成「把主墙网 + 封洞桥接段栅格化，再从图边洪水填充，填不到的就是建筑内部」，
 *    这些夹缝立刻全归到建筑里。
 * 2. **只用主墙网**（`islandFilter.findWallIslands` 的最大连通子图）。
 *    图框线是独立孤岛：算进去的话「图框与建筑之间那一圈」会被判成建筑内部，
 *    贴着图框画的指北针（test2）就逃掉了。
 * 3. **栅格里的墙要盖 3×3 的戳**，否则粗栅格上的斜墙会漏，洪水填充直接灌进屋里。
 *
 * 实现用**栅格**而不是多边形布尔运算：房间是凹多边形、还可能自交，
 * 栅格化 + 洪水填充 + 膨胀既简单又稳，而且分辨率可调（默认半个墙厚一格，
 * 1200×900 的工作尺度上也就 400×300 格）。
 *
 * 纯 TS、不 import opencv，配 vitest。
 */
import type { PxSegment } from './geometry';
import type { CvRoom, CvWall, PxPoint } from './types';

export interface OutlineOptions {
  /** 工作画布尺寸（px） */
  width: number;
  height: number;
  /** 向外扩的距离（px），一般取 1× 墙厚 */
  marginPx: number;
  /** 栅格边长（px）；默认 `max(1, margin/2)`，再夹到「总格数 ≤ 600×600」 */
  cellPx?: number;
  /**
   * 封洞用的连接段（`extractRooms` 的 `bridges`）。
   * 门洞不封上的话洪水填充会顺着门口灌进屋里，整座建筑都算不进轮廓。
   */
  sealSegments?: readonly PxSegment[];
}

export interface BuildingOutline {
  cols: number;
  rows: number;
  cellPx: number;
  /** 0/1，1 = 在轮廓内 */
  mask: Uint8Array;
  /** 点是否落在建筑轮廓内 */
  contains(p: PxPoint): boolean;
}

/** 射线法：点在多边形内 */
function pointInPolygon(p: PxPoint, poly: readonly PxPoint[]): boolean {
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

/**
 * 主墙网围出来的面 ∪ 房间并集 → 向外扩 `marginPx` → 建筑轮廓。
 *
 * @param rooms     CV 房间多边形（兜底：墙网没围严实时至少房间还在）
 * @param coreWalls **确定属于建筑**的墙段；管线传的是主墙网连通子图
 *
 * 房间和主墙网都为空时返回 `null`（调用方一律按「不剔除」处理 —— 没轮廓就没依据）。
 */
export function buildBuildingOutline(
  rooms: readonly CvRoom[],
  coreWalls: readonly CvWall[],
  opts: OutlineOptions,
): BuildingOutline | null {
  if (rooms.length === 0 && coreWalls.length === 0) return null;
  const width = Math.max(1, Math.ceil(opts.width));
  const height = Math.max(1, Math.ceil(opts.height));

  let cell = opts.cellPx ?? Math.max(1, opts.marginPx / 2);
  cell = Math.max(cell, width / 600, height / 600);
  const cols = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));
  const mask = new Uint8Array(cols * rows);

  // 1. 把主墙网 + 封洞段栅格化成「不透水的墙」（3×3 的戳，粗栅格上才不漏）
  const barrier = new Uint8Array(cols * rows);
  const stamp = (px: number, py: number) => {
    const cx = Math.floor(px / cell);
    const cy = Math.floor(py / cell);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        barrier[ny * cols + nx] = 1;
      }
    }
  };
  const strokeGrid = (s: { x1: number; y1: number; x2: number; y2: number }) => {
    const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    const steps = Math.max(1, Math.ceil((len / cell) * 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      stamp(s.x1 + (s.x2 - s.x1) * t, s.y1 + (s.y2 - s.y1) * t);
    }
  };
  for (const w of coreWalls) strokeGrid(w);
  for (const s of opts.sealSegments ?? []) strokeGrid(s);

  // 2. 从图边洪水填充「不是墙」的格子；填不到的就是墙网围出来的建筑内部
  const outsideCell = new Uint8Array(cols * rows);
  const stack: number[] = [];
  const push = (cx: number, cy: number) => {
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return;
    const idx = cy * cols + cx;
    if (barrier[idx] || outsideCell[idx]) return;
    outsideCell[idx] = 1;
    stack.push(idx);
  };
  for (let cx = 0; cx < cols; cx++) {
    push(cx, 0);
    push(cx, rows - 1);
  }
  for (let cy = 0; cy < rows; cy++) {
    push(0, cy);
    push(cols - 1, cy);
  }
  while (stack.length > 0) {
    const idx = stack.pop()!;
    const cx = idx % cols;
    const cy = (idx - cx) / cols;
    push(cx + 1, cy);
    push(cx - 1, cy);
    push(cx, cy + 1);
    push(cx, cy - 1);
  }
  for (let i = 0; i < mask.length; i++) if (!outsideCell[i]) mask[i] = 1;

  // 3. 房间并集也并进来（墙网没围严实、整栋楼都被判成外部时的兜底）
  for (const room of rooms) {
    const poly = room.polygon;
    if (poly.length < 3) continue;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of poly) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    const cx0 = Math.max(0, Math.floor(x0 / cell));
    const cx1 = Math.min(cols - 1, Math.ceil(x1 / cell));
    const cy0 = Math.max(0, Math.floor(y0 / cell));
    const cy1 = Math.min(rows - 1, Math.ceil(y1 / cell));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const idx = cy * cols + cx;
        if (mask[idx]) continue;
        if (pointInPolygon({ x: (cx + 0.5) * cell, y: (cy + 0.5) * cell }, poly)) mask[idx] = 1;
      }
    }
  }

  // 4. 向外扩 marginPx（多源 BFS，8 邻域 → 切比雪夫距离，比欧氏保守一点，正合适）
  const steps = Math.floor(opts.marginPx / cell);
  if (steps > 0) {
    let frontier: number[] = [];
    for (let i = 0; i < mask.length; i++) if (mask[i]) frontier.push(i);
    for (let s = 0; s < steps && frontier.length > 0; s++) {
      const next: number[] = [];
      for (const idx of frontier) {
        const cx = idx % cols;
        const cy = (idx - cx) / cols;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            const n = ny * cols + nx;
            if (mask[n]) continue;
            mask[n] = 1;
            next.push(n);
          }
        }
      }
      frontier = next;
    }
  }

  const cellPx = cell;
  return {
    cols,
    rows,
    cellPx,
    mask,
    contains(p: PxPoint): boolean {
      const cx = Math.floor(p.x / cellPx);
      const cy = Math.floor(p.y / cellPx);
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return false;
      return mask[cy * cols + cx] === 1;
    },
  };
}

export interface DropOutsideResult {
  walls: CvWall[];
  /** 被剔除的墙段（debug 叠加图里画品红框） */
  dropped: CvWall[];
  /** 旧下标 → 新下标（被剔除的是 -1） */
  indexMap: number[];
}

/**
 * 两端**和中点**都在建筑轮廓之外的墙段 → 剔除（指北针 / 图例 / 比例尺通杀）。
 *
 * 中点还落在轮廓里的不剔除：那是一条横穿建筑的墙，两头伸到轮廓外只是画长了。
 * 判据刻意要求「都在外面」——真墙至少有一端接在建筑上。
 */
export function dropOutsideWalls(
  walls: readonly CvWall[],
  outline: BuildingOutline | null,
): DropOutsideResult {
  if (!outline) {
    return { walls: [...walls], dropped: [], indexMap: walls.map((_, i) => i) };
  }
  const kept: CvWall[] = [];
  const dropped: CvWall[] = [];
  const indexMap = new Array<number>(walls.length).fill(-1);
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    const outsideA = !outline.contains({ x: w.x1, y: w.y1 });
    const outsideB = !outline.contains({ x: w.x2, y: w.y2 });
    const outsideMid = !outline.contains({ x: (w.x1 + w.x2) / 2, y: (w.y1 + w.y2) / 2 });
    if (outsideA && outsideB && outsideMid) {
      dropped.push(w);
      continue;
    }
    indexMap[i] = kept.length;
    kept.push(w);
  }
  return { walls: kept, dropped, indexMap };
}
