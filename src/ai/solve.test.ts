/**
 * M3 solver 单测（见 docs/AI-RECOGNITION.md 第 4 节）。
 *
 * 覆盖两类断言：
 * 1. 管线每一步的局部行为（正交化 / 聚类吸附 / 共边去重 / 洞口避让 …）；
 * 2. 端到端 fixture 的整体不变量：墙全部正交、端点落在 455 网格、
 *    相邻房间共墙（不重复）、房间面积与帖数误差 <10%、洞口完整落在墙上。
 */
import { describe, expect, it } from 'vitest';
import mockJson from '../../server/fixtures/mock-2ldk.json';
import type { Opening, Wall } from '../model/types';
import { HALF_GRID } from '../model/defaults';
import { polygonAreaMm2, wallLen } from '../utils/geometry';
import { TATAMI_AREA_MM2 } from '../utils/units';
import { RecognizeResultSchema, type RecognizeResult } from './recognizeSchema';
import {
  alignUnderlay,
  applyAxis,
  buildAxisMap,
  buildRooms,
  classifyPolygonEdges,
  convertColumns,
  deriveWalls,
  edgeOrient,
  estimateScale,
  regularizePolygon,
  resolveOpeningOffset,
  snapAxis,
  snapSharedEdges,
  solveRecognizeResult,
  type PlanTransform,
} from './solve';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** ① 手工构造的 2LDK（同时校验 mock fixture 本身没腐坏） */
const mock2ldk: RecognizeResult = RecognizeResultSchema.parse(mockJson);

/**
 * ② 合成 fixture：两个并排的 6 帖房间。
 * 坐标刻意歪斜（±4 单位），共享边两侧也刻意不一致（400 vs 404），
 * 用来检验正交化与共边归并；最后一个洞口远离所有墙，用来检验 warning。
 */
const twoRooms: RecognizeResult = {
  notes: '合成 fixture：两个 6 帖房间并排',
  scale: { method: 'tatami', drawingWidthMm: 7280 },
  rooms: [
    {
      id: 'r1',
      name: '洋室',
      floor: 'flooring',
      tatamiCount: 6,
      polygon: [
        { x: 2, y: 0 },
        { x: 398, y: 4 },
        { x: 403, y: 297 },
        { x: 0, y: 301 },
      ],
    },
    {
      id: 'r2',
      name: '和室',
      floor: 'tatami',
      tatamiCount: 6,
      polygon: [
        { x: 404, y: 3 },
        { x: 802, y: 0 },
        { x: 798, y: 304 },
        { x: 399, y: 296 },
      ],
    },
  ],
  openings: [
    { type: 'sliding_door', roomA: 'r1', roomB: 'r2', x: 400, y: 150 },
    { type: 'window', roomA: 'r1', roomB: 'outside', x: 0, y: 150 },
    { type: 'door', roomA: 'r2', roomB: 'outside', x: 400, y: 1200 },
  ],
  columns: [{ x: 401, y: 300, w: null, h: null }],
};

/**
 * ③ 斜切角 fixture（模拟 testdata/test2.jpg 的塔楼户型）。
 *
 * LDK 是一个右下角被 45° 切掉的矩形，切下来的那个三角形是相邻的サービスバルコニー——
 * 两个房间**共享同一条斜边**。归一化坐标刻意选在 ×9.1 后正好落在 455 网格上的位置，
 * 这样断言里才能把「正交部分仍在网格上」和「斜边角度被保留」分开来看。
 */
const diagonalCut: RecognizeResult = {
  notes: '合成 fixture：45° 切角 + 共享斜边',
  scale: { method: 'tatami', drawingWidthMm: 7280 },
  rooms: [
    {
      id: 'rA',
      name: 'LDK',
      floor: 'flooring',
      // 460000 归一化单位² × 9.1² / 1.6562e6 = 23 帖 ⇒ k 正好是 9.1，
      // 于是 800/600/400/200 这些坐标 ×k 后都落在 455 网格上
      tatamiCount: 23,
      polygon: [
        { x: 0, y: 0 },
        { x: 800, y: 0 },
        { x: 800, y: 400 },
        { x: 600, y: 600 },
        { x: 0, y: 600 },
      ],
    },
    {
      id: 'rB',
      name: 'サービスバルコニー',
      floor: 'tile',
      tatamiCount: null,
      polygon: [
        { x: 800, y: 400 },
        { x: 800, y: 600 },
        { x: 600, y: 600 },
      ],
    },
  ],
  // 洞口正好落在那条斜边的中点上
  openings: [{ type: 'window', roomA: 'rA', roomB: 'rB', x: 700, y: 500 }],
  columns: [],
};

/** ④ 没有任何帖数标注 → 只能按图纸总宽估比例 */
const noTatami: RecognizeResult = {
  notes: '没有帖数标注',
  scale: { method: 'estimate', drawingWidthMm: 8000 },
  rooms: [
    {
      id: 'a',
      name: '部屋',
      floor: 'other',
      tatamiCount: null,
      polygon: [
        { x: 0, y: 0 },
        { x: 500, y: 0 },
        { x: 500, y: 400 },
        { x: 0, y: 400 },
      ],
    },
  ],
  openings: [],
  columns: [],
};

const IMAGE = { imageWidthPx: 1600, imageHeightPx: 1200 };

// ---------------------------------------------------------------------------
// 断言辅助
// ---------------------------------------------------------------------------

const isOrthogonal = (w: Wall) => w.start.x === w.end.x || w.start.y === w.end.y;
const onGrid = (v: number) => Number.isInteger(v) && v % HALF_GRID === 0;

/** 线段相对水平轴的角度，归一化到 [0, 180) */
function segAngleDeg(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return ((deg % 180) + 180) % 180;
}

function openingFullyOnWall(walls: readonly Wall[], o: Opening): boolean {
  const wall = walls.find((w) => w.id === o.wallId);
  if (!wall) return false;
  const len = wallLen(wall);
  return o.width <= len + 1e-6 && o.offset - o.width / 2 >= -1e-6 && o.offset + o.width / 2 <= len + 1e-6;
}

/** 同一条线上是否存在重叠的两段轴向墙（说明共享边没有去重） */
function hasOverlappingDuplicate(walls: readonly Wall[]): boolean {
  const axis = walls.filter(isOrthogonal);
  for (let i = 0; i < axis.length; i++) {
    for (let j = i + 1; j < axis.length; j++) {
      const a = axis[i];
      const b = axis[j];
      const aH = a.start.y === a.end.y;
      const bH = b.start.y === b.end.y;
      if (aH !== bH) continue;
      const aFixed = aH ? a.start.y : a.start.x;
      const bFixed = bH ? b.start.y : b.start.x;
      if (aFixed !== bFixed) continue;
      const [a0, a1] = aH
        ? [Math.min(a.start.x, a.end.x), Math.max(a.start.x, a.end.x)]
        : [Math.min(a.start.y, a.end.y), Math.max(a.start.y, a.end.y)];
      const [b0, b1] = bH
        ? [Math.min(b.start.x, b.end.x), Math.max(b.start.x, b.end.x)]
        : [Math.min(b.start.y, b.end.y), Math.max(b.start.y, b.end.y)];
      if (Math.min(a1, b1) - Math.max(a0, b0) > 0) return true;
    }
  }
  return false;
}

/** 一个点是否出现在多边形的顶点里 */
function hasVertex(poly: readonly { x: number; y: number }[], p: { x: number; y: number }): boolean {
  return poly.some((q) => q.x === p.x && q.y === p.y);
}

/** 一段线段是否被某道墙完整覆盖 */
function coveredByWall(
  walls: readonly Wall[],
  seg: { orient: 'h' | 'v'; fixed: number; from: number; to: number },
): boolean {
  return walls.some((w) => {
    const horizontal = w.start.y === w.end.y;
    if (horizontal !== (seg.orient === 'h')) return false;
    const fixed = horizontal ? w.start.y : w.start.x;
    if (fixed !== seg.fixed) return false;
    const lo = horizontal ? Math.min(w.start.x, w.end.x) : Math.min(w.start.y, w.end.y);
    const hi = horizontal ? Math.max(w.start.x, w.end.x) : Math.max(w.start.y, w.end.y);
    return lo <= seg.from && hi >= seg.to;
  });
}

// ---------------------------------------------------------------------------
// 1. estimateScale
// ---------------------------------------------------------------------------

describe('estimateScale', () => {
  it('有帖数标注时按帖数面积反推 k', () => {
    const { k, basis, warnings } = estimateScale(twoRooms);
    // 两个 6 帖房间，各 ≈400×300 归一化单位 → k ≈ sqrt(12×1.6562e6 / 240000) = 9.1
    expect(basis).toBe('tatami');
    expect(k).toBeCloseTo(9.1, 1);
    expect(warnings).toHaveLength(0);
  });

  it('没有帖数标注时退回图纸总宽，并给出 warning', () => {
    const { k, basis, warnings } = estimateScale(noTatami);
    expect(basis).toBe('drawing_width');
    expect(k).toBeCloseTo(8, 6);
    expect(warnings.join()).toContain('帖数');
  });

  it('帖数与面积严重矛盾时改用图纸总宽', () => {
    const broken: RecognizeResult = {
      ...noTatami,
      scale: { method: 'tatami', drawingWidthMm: 8000 },
      rooms: [{ ...noTatami.rooms[0], tatamiCount: 100000 }],
    };
    const { basis, warnings } = estimateScale(broken);
    expect(basis).toBe('drawing_width');
    expect(warnings.join()).toContain('矛盾');
  });
});

// ---------------------------------------------------------------------------
// 2. rectilinearize
// ---------------------------------------------------------------------------

describe('edgeOrient', () => {
  it('与 0°/90° 偏差 ≤10° 的边判为轴对齐，其余是斜边', () => {
    expect(edgeOrient(100, 0)).toBe('h');
    expect(edgeOrient(100, 17)).toBe('h'); // 9.6°
    expect(edgeOrient(0, 100)).toBe('v');
    expect(edgeOrient(-17, 100)).toBe('v');
    expect(edgeOrient(100, 100)).toBe('d'); // 45°
    expect(edgeOrient(100, -30)).toBe('d'); // 16.7°
  });
});

describe('regularizePolygon', () => {
  it('把歪斜的四边形归到水平/垂直，并取端点均值', () => {
    const poly = regularizePolygon(twoRooms.rooms[0].polygon, 1);
    expect(poly).toHaveLength(4);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const axisAligned = Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.y - b.y) < 1e-9;
      expect(axisAligned).toBe(true);
    }
    // 顶边 y 取 (0+4)/2 = 2；左边 x 取 (2+0)/2 = 1
    expect(poly[0].y).toBeCloseTo(2, 6);
    expect(poly[0].x).toBeCloseTo(1, 6);
  });

  it('45° 斜边被如实保留，两侧的正交边照常轴对齐', () => {
    const poly = regularizePolygon(diagonalCut.rooms[0].polygon, 1);
    expect(poly).toHaveLength(5);
    expect(classifyPolygonEdges(poly)).toEqual(['h', 'v', 'd', 'h', 'v']);
    // 斜边角度原样保留
    expect(segAngleDeg(poly[2], poly[3])).toBeCloseTo(135, 6);
  });

  it('顶点不足时返回空数组', () => {
    expect(regularizePolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }], 1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. buildAxisMap / applyAxis / snapAxis
// ---------------------------------------------------------------------------

describe('buildAxisMap', () => {
  it('容差内的坐标归并为一条线并吸附到 455 网格', () => {
    const map = buildAxisMap([0, 20, 3600, 3660, 3700], 300, HALF_GRID);
    expect(map.entries).toHaveLength(2);
    expect(map.entries[0].to).toBe(0);
    expect(map.entries[1].to).toBe(3640);
  });

  it('吸附后强制严格递增，避免两条墙被压成同一条', () => {
    const map = buildAxisMap([0, 100, 500, 600], 150, HALF_GRID);
    const tos = map.entries.map((e) => e.to);
    expect(tos).toEqual([...tos].sort((a, b) => a - b));
    expect(new Set(tos).size).toBe(tos.length);
  });

  it('snapAxis 让容差内的顶点落到同一个值，applyAxis 对中间值线性插值', () => {
    const map = buildAxisMap([0, 3600, 3700], 300, HALF_GRID);
    expect(snapAxis(map, 3600)).toBe(snapAxis(map, 3700));
    const mid = applyAxis(map, 1825);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(3640);
  });
});

describe('snapSharedEdges', () => {
  it('把相邻房间的共享边归并到同一坐标，并平移到原点', () => {
    const polys = [
      regularizePolygon(twoRooms.rooms[0].polygon, 9.1),
      regularizePolygon(twoRooms.rooms[1].polygon, 9.1),
    ];
    const snapped = snapSharedEdges(polys);
    const allX = snapped.polygons.flat().map((p) => p.x);
    const allY = snapped.polygons.flat().map((p) => p.y);
    expect(Math.min(...allX)).toBe(0);
    expect(Math.min(...allY)).toBe(0);
    expect([...new Set(allX)].sort((a, b) => a - b)).toEqual([0, 3640, 7280]);
    expect([...new Set(allY)].sort((a, b) => a - b)).toEqual([0, 2730]);
  });
});

// ---------------------------------------------------------------------------
// 4. deriveWalls
// ---------------------------------------------------------------------------

describe('deriveWalls', () => {
  it('共享边只生成一段墙，同线相接的段会合并', () => {
    const walls = deriveWalls([
      [
        { x: 0, y: 0 },
        { x: 3640, y: 0 },
        { x: 3640, y: 2730 },
        { x: 0, y: 2730 },
      ],
      [
        { x: 3640, y: 0 },
        { x: 7280, y: 0 },
        { x: 7280, y: 2730 },
        { x: 3640, y: 2730 },
      ],
    ]);
    // 上下两条通长墙 + 三条竖墙
    expect(walls).toHaveLength(5);
    expect(hasOverlappingDuplicate(walls)).toBe(false);
    expect(coveredByWall(walls, { orient: 'h', fixed: 0, from: 0, to: 7280 })).toBe(true);
    expect(coveredByWall(walls, { orient: 'v', fixed: 3640, from: 0, to: 2730 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5~8. 洞口 / 柱 / 底图
// ---------------------------------------------------------------------------

describe('resolveOpeningOffset', () => {
  it('与已有洞口冲突时向两侧挪开', () => {
    const placed: Opening[] = [
      { id: 'o_1', wallId: 'w_1', type: 'door', offset: 1000, width: 780 },
    ];
    const offset = resolveOpeningOffset(placed, 'w_1', 1000, 780, 5000);
    expect(offset).not.toBeNull();
    expect(Math.abs(offset! - 1000)).toBeGreaterThanOrEqual(780);
  });

  it('挪不开时返回 null', () => {
    const placed: Opening[] = [
      { id: 'o_1', wallId: 'w_1', type: 'door', offset: 455, width: 900 },
    ];
    expect(resolveOpeningOffset(placed, 'w_1', 455, 900, 910)).toBeNull();
  });
});

describe('convertColumns', () => {
  const transform: PlanTransform = {
    k: 10,
    xMap: { entries: [], tolerance: 300 },
    yMap: { entries: [], tolerance: 300 },
    translation: { x: 0, y: 0 },
  };

  it('w/h 为 null 时用 105×105，坐标吸附 100mm', () => {
    const [c] = convertColumns([{ x: 41.7, y: 60.2, w: null, h: null }], transform);
    expect(c.kind).toBe('column');
    expect(c.width).toBe(105);
    expect(c.depth).toBe(105);
    expect(c.position).toEqual({ x: 400, y: 600 });
  });

  it('给了归一化尺寸时按 k 换算', () => {
    const [c] = convertColumns([{ x: 0, y: 0, w: 14, h: 12 }], transform);
    expect(c.width).toBe(140);
    expect(c.depth).toBe(120);
  });
});

describe('alignUnderlay', () => {
  it('mmPerPixel = k × 1000 / 图片像素宽，offset 取平移量', () => {
    const u = alignUnderlay(9.1, 1600, { x: -123.4, y: 55.6 });
    expect(u.mmPerPixel).toBeCloseTo(5.6875, 6);
    expect(u.offset).toEqual({ x: -123, y: 56 });
  });
});

// ---------------------------------------------------------------------------
// 端到端
// ---------------------------------------------------------------------------

describe('solveRecognizeResult — 合成 fixture', () => {
  const solved = solveRecognizeResult(twoRooms, IMAGE);

  it('墙全部正交且端点落在 455 网格', () => {
    expect(solved.walls.length).toBeGreaterThan(0);
    for (const w of solved.walls) {
      expect(isOrthogonal(w)).toBe(true);
      expect(onGrid(w.start.x)).toBe(true);
      expect(onGrid(w.start.y)).toBe(true);
      expect(onGrid(w.end.x)).toBe(true);
      expect(onGrid(w.end.y)).toBe(true);
    }
  });

  it('相邻房间共墙：共享边只出现一次', () => {
    expect(hasOverlappingDuplicate(solved.walls)).toBe(false);
    expect(coveredByWall(solved.walls, { orient: 'v', fixed: 3640, from: 0, to: 2730 })).toBe(true);
    expect(solved.walls).toHaveLength(5);
  });

  it('房间面积与帖数标注误差 <10%', () => {
    for (let i = 0; i < solved.rooms.length; i++) {
      const target = twoRooms.rooms[i].tatamiCount! * TATAMI_AREA_MM2;
      const actual = polygonAreaMm2(solved.rooms[i].polygon);
      expect(Math.abs(actual - target) / target).toBeLessThan(0.1);
    }
  });

  it('洞口完整落在墙上，够不着墙的被丢弃并记 warning', () => {
    expect(solved.openings).toHaveLength(2);
    for (const o of solved.openings) expect(openingFullyOnWall(solved.walls, o)).toBe(true);
    expect(solved.warnings.some((w) => w.includes('离最近的墙太远'))).toBe(true);
  });

  it('柱转成 structure，且只有 column', () => {
    expect(solved.structures).toHaveLength(1);
    expect(solved.structures[0].kind).toBe('column');
  });
});

// ---------------------------------------------------------------------------
// M3.1：斜墙全链路
// ---------------------------------------------------------------------------

describe('solveRecognizeResult — 45° 切角 fixture', () => {
  const solved = solveRecognizeResult(diagonalCut, IMAGE);
  const diagonals = solved.walls.filter((w) => !isOrthogonal(w));
  const axis = solved.walls.filter(isOrthogonal);

  it('斜边没有被正交化：房间多边形保留 5 个顶点，其中一条边是斜的', () => {
    const ldk = solved.rooms[0];
    expect(ldk.polygon).toHaveLength(5);
    expect(classifyPolygonEdges(ldk.polygon).filter((k) => k === 'd')).toHaveLength(1);
  });

  it('斜边角度保留（与输入的 45° 偏差 <2°）', () => {
    expect(diagonals).toHaveLength(1);
    const angle = segAngleDeg(diagonals[0].start, diagonals[0].end);
    expect(Math.abs(angle - 135)).toBeLessThan(2);
  });

  it('相邻房间共享的斜边只出一段墙', () => {
    // 外轮廓 4 段正交墙 + 1 段斜墙；两个房间共用的那条斜边没有重复
    expect(solved.walls).toHaveLength(5);
    expect(diagonals).toHaveLength(1);
    expect(hasOverlappingDuplicate(solved.walls)).toBe(false);
    // 两个房间给出的斜边端点必须**完全一致**，否则会拼出两段几乎重合的墙
    const [ldk, balcony] = solved.rooms.map((r) => r.polygon);
    for (const end of [diagonals[0].start, diagonals[0].end]) {
      expect(hasVertex(ldk, end)).toBe(true);
      expect(hasVertex(balcony, end)).toBe(true);
    }
  });

  it('正交部分仍落在 455 网格上', () => {
    for (const w of axis) {
      // 轴向墙的固定坐标必须在网格上
      expect(onGrid(w.start.y === w.end.y ? w.start.y : w.start.x)).toBe(true);
    }
    // 纯正交的那几个顶点也在网格上
    for (const p of solved.rooms[0].polygon) {
      const isDiagonalEnd = !onGrid(p.x) || !onGrid(p.y);
      if (!isDiagonalEnd) {
        expect(onGrid(p.x)).toBe(true);
        expect(onGrid(p.y)).toBe(true);
      }
    }
    expect(solved.rooms[0].polygon).toContainEqual({ x: 0, y: 0 });
    expect(solved.rooms[0].polygon).toContainEqual({ x: 7280, y: 0 });
  });

  it('斜边上的洞口能正确落到那段斜墙上', () => {
    expect(solved.openings).toHaveLength(1);
    expect(solved.openings[0].wallId).toBe(diagonals[0].id);
    expect(openingFullyOnWall(solved.walls, solved.openings[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M3.1：帖数一致性校验
// ---------------------------------------------------------------------------

describe('buildRooms 的帖数一致性校验', () => {
  /** 3640×2730 = 6 帖的矩形 */
  const polygon = [
    { x: 0, y: 0 },
    { x: 3640, y: 0 },
    { x: 3640, y: 2730 },
    { x: 0, y: 2730 },
  ];
  const room = (tatamiCount: number | null) => ({
    id: 'r1',
    name: '洋室',
    floor: 'flooring' as const,
    tatamiCount,
    polygon: [],
  });

  it('面积与标注一致时不报 warning', () => {
    const built = buildRooms([room(6)], [polygon]);
    expect(built.warnings).toHaveLength(0);
    expect(built.mismatchedRoomIds).toHaveLength(0);
  });

  it('偏差 >25% 时报 warning，并把房间 id 交给 UI 高亮', () => {
    // 真值 6 帖，图上标 3 帖 → 偏差 100%
    const built = buildRooms([room(3)], [polygon]);
    expect(built.warnings).toHaveLength(1);
    expect(built.warnings[0]).toContain('洋室');
    expect(built.warnings[0]).toContain('偏差');
    expect(built.mismatchedRoomIds).toEqual([built.rooms[0].id]);
  });

  it('没有帖数标注时跳过校验', () => {
    expect(buildRooms([room(null)], [polygon]).warnings).toHaveLength(0);
  });
});

describe('solveRecognizeResult — mock 2LDK fixture', () => {
  const solved = solveRecognizeResult(mock2ldk, { imageWidthPx: 1200, imageHeightPx: 900 });

  it('5 个房间全部保留，多边形顶点都在 455 网格上', () => {
    expect(solved.rooms).toHaveLength(5);
    expect(solved.rooms.map((r) => r.name)).toEqual(['洋室', '洋室', '玄関', 'LDK', '浴室']);
    for (const room of solved.rooms) {
      expect(room.polygon.length).toBeGreaterThanOrEqual(4);
      for (const p of room.polygon) {
        expect(onGrid(p.x)).toBe(true);
        expect(onGrid(p.y)).toBe(true);
      }
    }
  });

  it('墙正交、无重复，且相邻房间共墙', () => {
    for (const w of solved.walls) expect(isOrthogonal(w)).toBe(true);
    expect(hasOverlappingDuplicate(solved.walls)).toBe(false);
    // 两间洋室之间的那道墙
    const between = solved.rooms[0].polygon.map((p) => p.y).sort((a, b) => b - a)[0];
    expect(solved.walls.some((w) => w.start.y === between && w.end.y === between)).toBe(true);
  });

  it('标了帖数的房间面积误差 <10%', () => {
    for (let i = 0; i < mock2ldk.rooms.length; i++) {
      const tatami = mock2ldk.rooms[i].tatamiCount;
      if (tatami === null) continue;
      const actual = polygonAreaMm2(solved.rooms[i].polygon);
      const target = tatami * TATAMI_AREA_MM2;
      expect(Math.abs(actual - target) / target).toBeLessThan(0.1);
    }
  });

  it('所有洞口都完整落在墙上，没有被丢弃', () => {
    expect(solved.openings).toHaveLength(mock2ldk.openings.length);
    for (const o of solved.openings) expect(openingFullyOnWall(solved.walls, o)).toBe(true);
    expect(solved.warnings).toHaveLength(0);
  });

  it('底图比例与偏移能把原图对齐到生成的平面图上', () => {
    // 建筑总宽 ≈ 8800mm（fixture 的 drawingWidthMm），底图整幅宽 = 1000 单位
    expect(solved.underlay.mmPerPixel * 1200).toBeGreaterThan(8000);
    expect(solved.underlay.mmPerPixel * 1200).toBeLessThan(12000);
    expect(Number.isInteger(solved.underlay.offset.x)).toBe(true);
    expect(Number.isInteger(solved.underlay.offset.y)).toBe(true);
  });

  it('柱按图上尺寸换算，落在 100mm 网格', () => {
    expect(solved.structures).toHaveLength(2);
    for (const s of solved.structures) {
      expect(s.position.x % 100).toBe(0);
      expect(s.position.y % 100).toBe(0);
      expect(s.width).toBeGreaterThanOrEqual(50);
    }
  });
});
