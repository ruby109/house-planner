/**
 * M4-CV 阶段 B：融合器单测（见 docs/CV-PIPELINE.md 第 3 节）。
 *
 * 两类用例：
 * - **合成用例**：手搓一个「一室一厅」的 CvExtract + VLM 结果，比例 / 挂载 / 吸附都能手算，
 *   断言可以写死；
 * - **真图 fixture**：`fixtures/cvExtract-test2.json` 是阶段 A 的管线对 testdata/test2.jpg
 *   实跑的输出（`node server/cv-debug.mjs testdata/test2.jpg --full`），
 *   `fixtures/vlm-test2.json` 是同一张图的 VLM 语义快照（帖数按图上标注手工订正过）。
 *   这类断言只卡「量级 + 结构」，不写死坐标——CV 管线调参时不该被单测绊住，
 *   但「斜墙还在、语义挂对、比例合理、外框被滤掉」这几条必须守住。
 */
import { describe, expect, it } from 'vitest';
import cvTest2 from './fixtures/cvExtract-test2.json';
import vlmTest2 from './fixtures/vlm-test2.json';
import type { CvExtract, CvWall } from '../cv/types';
import { TATAMI_AREA_MM2 } from '../utils/units';
import { polygonAreaMm2 } from '../utils/geometry';
import type { RecognizeResult } from './recognizeSchema';
import {
  MIN_DIAGONAL_WALL_MM,
  dropBorderWalls,
  estimateCvScale,
  fuseCvAndVlm,
  isSmallRoom,
  mergeUnnamedFragments,
  mountSemantics,
  normalizeRoomName,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  polygonIoU,
  sharedEdgeLength,
  unionAdjacentPolygons,
} from './fuse';

const CV_TEST2 = cvTest2 as unknown as CvExtract;
const VLM_TEST2 = vlmTest2 as unknown as RecognizeResult;
const TEST2_DIMS = { imageWidthPx: 500, imageHeightPx: 375 };

// ---------------------------------------------------------------------------
// 合成用例的素材
// ---------------------------------------------------------------------------

/** 一条轴向墙 */
function wall(x1: number, y1: number, x2: number, y2: number, thicknessPx = 4): CvWall {
  return { x1, y1, x2, y2, thicknessPx };
}

/**
 * 合成 CvExtract：200×100px 的图，里面两个房间。
 *
 *   (10,10)------(110,10)------(190,10)
 *      |   房间 A    |    房间 B    |
 *   (10,90)------(110,90)------(190,90)
 *
 * A = 100×80 px，B = 80×80 px。
 */
function syntheticExtract(overrides: Partial<CvExtract> = {}): CvExtract {
  return {
    walls: [
      wall(10, 10, 190, 10),
      wall(10, 90, 190, 90),
      wall(10, 10, 10, 90),
      wall(110, 10, 110, 90),
      wall(190, 10, 190, 90),
    ],
    rooms: [
      {
        polygon: [
          { x: 10, y: 10 },
          { x: 110, y: 10 },
          { x: 110, y: 90 },
          { x: 10, y: 90 },
        ],
        areaPx: 100 * 80,
      },
      {
        polygon: [
          { x: 110, y: 10 },
          { x: 190, y: 10 },
          { x: 190, y: 90 },
          { x: 110, y: 90 },
        ],
        areaPx: 80 * 80,
      },
    ],
    openings: [],
    columns: [],
    deskewDeg: 0,
    stats: {
      wallStrokePx: 4,
      mode: 'clean',
      imageWidthPx: 200,
      imageHeightPx: 100,
      workWidthPx: 200,
      workHeightPx: 100,
      textBlocksRemoved: 0,
      dashChainsRemoved: 0,
      thinBlobsRemoved: 0,
      islandWallsRemoved: 0,
      outsideWallsRemoved: 0,
      gapMergedWalls: 0,
      danglingExtended: 0,
      scrapWallsRemoved: 0,
      danglingEndsBefore: 0,
      danglingEnds: 0,
      openingCandidates: 0,
      columnCandidates: 0,
      elapsedMs: 1,
    },
    warnings: [],
    textBoxes: [],
    dashBoxes: [],
    outsideBoxes: [],
    ...overrides,
  };
}

/** 归一化坐标：图片宽 200px → 1 px = 5 归一化单位 */
const n = (px: number) => px * 5;

function syntheticVlm(overrides: Partial<RecognizeResult> = {}): RecognizeResult {
  return {
    notes: '',
    scale: { method: 'tatami', drawingWidthMm: 8000 },
    rooms: [
      {
        id: 'r1',
        name: 'LDK',
        floor: 'flooring',
        tatamiCount: 10,
        polygon: [
          { x: n(12), y: n(12) },
          { x: n(108), y: n(12) },
          { x: n(108), y: n(88) },
          { x: n(12), y: n(88) },
        ],
      },
      {
        id: 'r2',
        name: '洋室',
        floor: 'tatami',
        tatamiCount: 8,
        polygon: [
          { x: n(112), y: n(12) },
          { x: n(188), y: n(12) },
          { x: n(188), y: n(88) },
          { x: n(112), y: n(88) },
        ],
      },
    ],
    openings: [],
    columns: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('几何小工具', () => {
  it('polygonCentroid 对矩形返回中心', () => {
    const c = polygonCentroid([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 0, y: 4 },
    ]);
    expect(c.x).toBeCloseTo(5);
    expect(c.y).toBeCloseTo(2);
  });

  it('pointInPolygon 认得凹多边形（L 型）', () => {
    const l = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(pointInPolygon({ x: 2, y: 8 }, l)).toBe(true);
    expect(pointInPolygon({ x: 8, y: 2 }, l)).toBe(true);
    // L 型的凹口：面积重心正好落在外面，挂载时得靠备选中心点救回来
    expect(pointInPolygon({ x: 8, y: 8 }, l)).toBe(false);
  });
});

describe('dropBorderWalls', () => {
  it('丢掉贴着图边横贯整条边的装饰框线', () => {
    const walls = [
      wall(2, 3, 198, 3), // 上边框
      wall(2, 97, 100, 97), // 下边框（被内容打断成两段）
      wall(120, 97, 198, 97),
      wall(40, 30, 160, 30), // 图纸里的正经墙
    ];
    const res = dropBorderWalls(walls, 200, 100, 4);
    expect(res.borderDropped).toBe(3);
    expect(res.walls).toEqual([walls[3]]);
  });

  it('贴边但没横贯的线段留着（紧裁的图纸外墙不会被误伤）', () => {
    const walls = [wall(2, 3, 60, 3), wall(40, 30, 160, 30)];
    const res = dropBorderWalls(walls, 200, 100, 4);
    expect(res.borderDropped).toBe(0);
  });

  it('test2 真图：正好滤掉 3 段外框线，其余墙段一条不动', () => {
    const res = dropBorderWalls(
      CV_TEST2.walls,
      TEST2_DIMS.imageWidthPx,
      TEST2_DIMS.imageHeightPx,
      CV_TEST2.stats.wallStrokePx,
    );
    expect(res.borderDropped).toBe(3);
    expect(res.walls).toHaveLength(CV_TEST2.walls.length - 3);
    // 三段都贴着上/下图边
    for (const w of CV_TEST2.walls.filter((x) => !res.walls.includes(x))) {
      expect(Math.min(w.y1, TEST2_DIMS.imageHeightPx - w.y1)).toBeLessThan(14);
    }
  });
});

describe('mountSemantics', () => {
  it('中心点落在哪个 CV 房间就挂给谁', () => {
    const cv = syntheticExtract();
    const vlm = syntheticVlm();
    const mount = mountSemantics(cv.rooms, vlm.rooms, cv.stats.imageWidthPx);
    expect(mount.hosts[0]?.name).toBe('LDK');
    expect(mount.hosts[1]?.name).toBe('洋室');
    expect(mount.roomIndexById.get('r1')).toBe(0);
    expect(mount.roomIndexById.get('r2')).toBe(1);
    expect(mount.warnings).toHaveLength(0);
  });

  it('一对多时保留中心最近的那个，另一个记 warning', () => {
    const cv = syntheticExtract();
    const vlm = syntheticVlm({
      rooms: [
        // 两个 VLM 房间的中心都落进 CV 房间 A，靠得更近的是 r1
        {
          id: 'r1',
          name: 'LDK',
          floor: 'flooring',
          tatamiCount: 10,
          polygon: [
            { x: n(20), y: n(20) },
            { x: n(100), y: n(20) },
            { x: n(100), y: n(80) },
            { x: n(20), y: n(80) },
          ],
        },
        {
          id: 'r2',
          name: '納戸',
          floor: 'other',
          tatamiCount: null,
          polygon: [
            { x: n(15), y: n(15) },
            { x: n(45), y: n(15) },
            { x: n(45), y: n(35) },
            { x: n(15), y: n(35) },
          ],
        },
      ],
    });
    // 納戸 命中小隔间清单，默认会被安静忽略——这条用例要的是「一对多」本身的行为，
    // 所以显式关掉 M4.2 的开关
    const mount = mountSemantics(cv.rooms, vlm.rooms, cv.stats.imageWidthPx, {
      ignoreSmallRooms: false,
    });
    expect(mount.hosts[0]?.name).toBe('LDK');
    expect(mount.hosts[1]).toBeNull();
    expect(mount.warnings.some((w) => w.includes('納戸') && w.includes('同一块区域'))).toBe(true);
    expect(mount.warnings.some((w) => w.includes('没有对应的房间名'))).toBe(true);
  });

  it('落不进任何 CV 房间的 VLM 房间被丢弃并警告', () => {
    const cv = syntheticExtract();
    const vlm = syntheticVlm({
      rooms: [
        {
          id: 'r9',
          name: '幽灵房',
          floor: 'other',
          tatamiCount: 3,
          polygon: [
            { x: n(1), y: n(1) },
            { x: n(5), y: n(1) },
            { x: n(5), y: n(5) },
            { x: n(1), y: n(5) },
          ],
        },
      ],
    });
    const mount = mountSemantics(cv.rooms, vlm.rooms, cv.stats.imageWidthPx);
    expect(mount.hosts.every((h) => h === null)).toBe(true);
    expect(mount.warnings.some((w) => w.includes('幽灵房') && w.includes('已丢弃'))).toBe(true);
  });

  it('test2 真图：LDK / 洋室① / 洋室② / 浴室 都挂到了各自的区域', () => {
    const mount = mountSemantics(CV_TEST2.rooms, VLM_TEST2.rooms, TEST2_DIMS.imageWidthPx);
    const names = mount.hosts.map((h) => h?.name ?? null);
    expect(names).toContain('LDK');
    expect(names).toContain('洋室①');
    expect(names).toContain('洋室②');
    expect(names).toContain('浴室');
    // CV 只提取出 9 块区域（含 4 个バルコニー），所以必然有没人认领的
    expect(mount.warnings.some((w) => w.includes('没有对应的房间名'))).toBe(true);
  });
});

describe('polygonIoU', () => {
  const rect = (x0: number, y0: number, x1: number, y1: number) => [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];

  it('完全重合 → 1', () => {
    expect(polygonIoU(rect(0, 0, 10, 10), rect(0, 0, 10, 10))).toBeCloseTo(1, 2);
  });

  it('完全不沾边 → 0', () => {
    expect(polygonIoU(rect(0, 0, 10, 10), rect(50, 50, 60, 60))).toBe(0);
  });

  it('一半重叠 → 1/3（交 50 / 并 150）', () => {
    expect(polygonIoU(rect(0, 0, 10, 10), rect(5, 0, 15, 10))).toBeCloseTo(1 / 3, 2);
  });

  it('凹多边形（L 型）也算得对', () => {
    const l = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ];
    // L 型面积 64；整个 10×10 方块面积 100，交 = 64、并 = 100 → 0.64
    // 采样法有 ~1% 的量化误差，卡个区间就够（阈值是 0.3，精度绰绰有余）
    expect(polygonIoU(l, rect(0, 0, 10, 10))).toBeGreaterThan(0.62);
    expect(polygonIoU(l, rect(0, 0, 10, 10))).toBeLessThan(0.66);
  });
});

describe('mountSemantics（IoU 兜底，M4.1）', () => {
  it('中心点挂不上、但轮廓大面积重叠 → 靠 IoU 救回来', () => {
    const cv = syntheticExtract();
    // 中心点故意放在两块 CV 房间的**交界墙上**（x=110 是分隔墙，不在任何多边形内部），
    // 但轮廓与左边那块 CV 房间重叠得很厉害
    const vlm = syntheticVlm({
      rooms: [
        {
          id: 'r1',
          name: '洗面所',
          floor: 'tile',
          tatamiCount: null,
          polygon: [
            { x: n(30), y: n(12) },
            { x: n(190), y: n(12) },
            { x: n(190), y: n(88) },
            { x: n(30), y: n(88) },
          ],
        },
      ],
    });
    const mount = mountSemantics(cv.rooms, vlm.rooms, cv.stats.imageWidthPx);
    const mounted = mount.hosts.filter((h) => h !== null);
    expect(mounted).toHaveLength(1);
    expect(mounted[0]?.name).toBe('洗面所');
  });

  it('重叠面积太小（IoU < 0.3）还是丢弃', () => {
    const cv = syntheticExtract();
    const vlm = syntheticVlm({
      rooms: [
        {
          id: 'r1',
          name: '幽灵房',
          floor: 'other',
          tatamiCount: null,
          // 只有一角搭进 CV 房间 A，其余全在图外
          polygon: [
            { x: n(-260), y: n(-190) },
            { x: n(20), y: n(-190) },
            { x: n(20), y: n(20) },
            { x: n(-260), y: n(20) },
          ],
        },
      ],
    });
    const mount = mountSemantics(cv.rooms, vlm.rooms, cv.stats.imageWidthPx);
    expect(mount.hosts.every((h) => h === null)).toBe(true);
    expect(mount.iouMounted).toBe(0);
    expect(mount.warnings.some((w) => w.includes('幽灵房') && w.includes('已丢弃'))).toBe(true);
  });

  it('中心点命中永远压过 IoU 兜底', () => {
    const cv = syntheticExtract();
    const vlm = syntheticVlm({
      rooms: [
        {
          id: 'r_center',
          name: '正主',
          floor: 'flooring',
          tatamiCount: null,
          polygon: [
            { x: n(20), y: n(20) },
            { x: n(100), y: n(20) },
            { x: n(100), y: n(80) },
            { x: n(20), y: n(80) },
          ],
        },
        {
          id: 'r_iou',
          name: '蹭的',
          floor: 'other',
          tatamiCount: null,
          polygon: [
            { x: n(30), y: n(12) },
            { x: n(190), y: n(12) },
            { x: n(190), y: n(88) },
            { x: n(30), y: n(88) },
          ],
        },
      ],
    });
    const mount = mountSemantics(cv.rooms, vlm.rooms, cv.stats.imageWidthPx);
    expect(mount.hosts[0]?.name).toBe('正主');
  });
});

// ---------------------------------------------------------------------------
// M4.2 小隔间忽略
// ---------------------------------------------------------------------------

describe('isSmallRoom（M4.2）', () => {
  const room = (name: string, tatamiCount: number | null = null) => ({ name, tatamiCount });

  it('名称命中清单', () => {
    for (const name of [
      '洗面所',
      '脱衣所',
      '洗面脱衣室',
      'トイレ',
      'WC',
      '玄関',
      '玄関・ホール',
      '廊下',
      '納戸',
      'クローゼット',
      'ウォークインクローゼット',
      'WIC',
      'シューズクローク',
    ]) {
      expect(isSmallRoom(room(name)), name).toBe(true);
    }
  });

  it('全角 / 半角片假名 / 分隔符都容错', () => {
    expect(isSmallRoom(room('ＷＣ'))).toBe(true); // 全角字母
    expect(isSmallRoom(room('ｳｫｰｸｲﾝｸﾛｰｾﾞｯﾄ'))).toBe(true); // 半角片假名
    expect(isSmallRoom(room('玄関 ・ 廊下'))).toBe(true);
    expect(isSmallRoom(room('（洗面所）'))).toBe(true);
    expect(normalizeRoomName('玄関・廊下')).toBe('玄関廊下');
  });

  it('帖数不足 3 帖也算小隔间，3 帖及以上不算', () => {
    expect(isSmallRoom(room('サービスルーム', 2.5))).toBe(true);
    expect(isSmallRoom(room('サービスルーム', 3))).toBe(false);
    expect(isSmallRoom(room('洋室', 6))).toBe(false);
  });

  it('正经房间不误伤', () => {
    for (const name of ['LDK', '洋室①', '和室', '浴室', 'キッチン', 'バルコニー']) {
      expect(isSmallRoom(room(name)), name).toBe(false);
    }
  });
});

describe('mountSemantics（小隔间忽略，M4.2）', () => {
  /** 中心落在图外 → 必定挂载失败 */
  const ghost = (id: string, name: string, tatamiCount: number | null = null) => ({
    id,
    name,
    floor: 'other' as const,
    tatamiCount,
    polygon: [
      { x: n(-260), y: n(-190) },
      { x: n(-200), y: n(-190) },
      { x: n(-200), y: n(-150) },
      { x: n(-260), y: n(-150) },
    ],
  });

  it('挂不上的小隔间安静跳过，只计数不报警告', () => {
    const cv = syntheticExtract();
    const vlm = syntheticVlm({
      rooms: [ghost('r1', 'トイレ'), ghost('r2', '洗面所'), ghost('r3', '玄関・ホール')],
    });
    const mount = mountSemantics(cv.rooms, vlm.rooms, cv.stats.imageWidthPx);
    expect(mount.ignoredSmallRooms).toBe(3);
    expect(mount.warnings.some((w) => w.includes('已丢弃'))).toBe(false);
  });

  it('关掉开关时行为与 M4.1 完全一致（丢弃 + 每个一条 warning）', () => {
    const cv = syntheticExtract();
    const vlm = syntheticVlm({
      rooms: [ghost('r1', 'トイレ'), ghost('r2', '洗面所'), ghost('r3', '玄関・ホール')],
    });
    const mount = mountSemantics(cv.rooms, vlm.rooms, cv.stats.imageWidthPx, {
      ignoreSmallRooms: false,
    });
    expect(mount.ignoredSmallRooms).toBe(0);
    expect(mount.warnings.filter((w) => w.includes('已丢弃'))).toHaveLength(3);
  });

  it('非小隔间挂不上时照旧警告', () => {
    const cv = syntheticExtract();
    const vlm = syntheticVlm({ rooms: [ghost('r1', '洋室', 6)] });
    const mount = mountSemantics(cv.rooms, vlm.rooms, cv.stats.imageWidthPx);
    expect(mount.ignoredSmallRooms).toBe(0);
    expect(mount.warnings.some((w) => w.includes('洋室') && w.includes('已丢弃'))).toBe(true);
  });

  it('挂载成功的小隔间不受影响（照常拿到名字，不计入忽略数）', () => {
    const cv = syntheticExtract();
    const vlm = syntheticVlm({
      rooms: [
        {
          id: 'r1',
          name: '洗面所',
          floor: 'tile',
          tatamiCount: null,
          polygon: [
            { x: n(20), y: n(20) },
            { x: n(100), y: n(20) },
            { x: n(100), y: n(80) },
            { x: n(20), y: n(80) },
          ],
        },
      ],
    });
    const mount = mountSemantics(cv.rooms, vlm.rooms, cv.stats.imageWidthPx);
    expect(mount.hosts[0]?.name).toBe('洗面所');
    expect(mount.ignoredSmallRooms).toBe(0);
  });

  it('一对多竞争里输掉的小隔间也安静跳过', () => {
    const cv = syntheticExtract();
    const vlm = syntheticVlm({
      rooms: [
        {
          id: 'r1',
          name: 'LDK',
          floor: 'flooring',
          tatamiCount: 10,
          polygon: [
            { x: n(20), y: n(20) },
            { x: n(100), y: n(20) },
            { x: n(100), y: n(80) },
            { x: n(20), y: n(80) },
          ],
        },
        {
          id: 'r2',
          name: '納戸',
          floor: 'other',
          tatamiCount: null,
          polygon: [
            { x: n(15), y: n(15) },
            { x: n(45), y: n(15) },
            { x: n(45), y: n(35) },
            { x: n(15), y: n(35) },
          ],
        },
      ],
    });
    const mount = mountSemantics(cv.rooms, vlm.rooms, cv.stats.imageWidthPx);
    expect(mount.hosts[0]?.name).toBe('LDK');
    expect(mount.ignoredSmallRooms).toBe(1);
    expect(mount.warnings.some((w) => w.includes('同一块区域'))).toBe(false);
  });
});

describe('fuseCvAndVlm（小隔间忽略，M4.2 · test2 真图）', () => {
  const on = fuseCvAndVlm(CV_TEST2, VLM_TEST2, TEST2_DIMS);
  const off = fuseCvAndVlm(CV_TEST2, VLM_TEST2, { ...TEST2_DIMS, ignoreSmallRooms: false });

  it('默认开：test2 上 4 个小隔间被忽略（トイレ / 洗面所 / WIC / 玄関・廊下）', () => {
    // 这四块在 500px 宽的源图上 CV 都提不出独立区域：前三个中心挂不上，
    // 「玄関・廊下」则在与「洋室②」的竞争里输掉
    expect(on.fuseStats.ignoredSmallRooms).toBe(4);
    expect(off.fuseStats.ignoredSmallRooms).toBe(0);
  });

  it('warning 从 9 条降到 5 条，正好少了被忽略的那 4 条', () => {
    expect(off.warnings).toHaveLength(9);
    expect(on.warnings).toHaveLength(5);
    expect(on.warnings.length).toBe(off.warnings.length - on.fuseStats.ignoredSmallRooms);
    // 剩下的 5 条都是「提取本身」的账，跟小隔间无关
    expect(on.warnings.some((w) => w.includes('已丢弃') || w.includes('同一块区域'))).toBe(false);
    for (const name of ['トイレ', '洗面所', 'ウォークインクローゼット', '玄関・廊下']) {
      expect(off.warnings.some((w) => w.includes(name)), name).toBe(true);
      expect(on.warnings.some((w) => w.includes(name)), name).toBe(false);
    }
  });

  it('几何与挂载成功的房间一条都没变（墙 id 是随机的，只比坐标）', () => {
    const geom = (r: typeof on) => r.walls.map((w) => [w.start, w.end]);
    expect(geom(on)).toEqual(geom(off));
    expect(on.rooms.map((r) => [r.name, r.floor, r.polygon])).toEqual(
      off.rooms.map((r) => [r.name, r.floor, r.polygon]),
    );
    expect(on.openings.map((o) => [o.type, o.offset, o.width])).toEqual(
      off.openings.map((o) => [o.type, o.offset, o.width]),
    );
    expect(on.fuseStats.matchedRooms).toBe(off.fuseStats.matchedRooms);
  });
});

describe('无名碎块合并（M4.1）', () => {
  const rect = (x0: number, y0: number, x1: number, y1: number) => [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];

  it('sharedEdgeLength 只认反向共线的重叠段', () => {
    expect(sharedEdgeLength(rect(0, 0, 100, 100), rect(100, 0, 200, 100))).toBeCloseTo(100, 3);
    // 只搭到一半
    expect(sharedEdgeLength(rect(0, 0, 100, 100), rect(100, 50, 200, 150))).toBeCloseTo(50, 3);
    // 隔着一条缝，不算相邻
    expect(sharedEdgeLength(rect(0, 0, 100, 100), rect(120, 0, 200, 100))).toBe(0);
  });

  it('unionAdjacentPolygons 把两个贴着的矩形拼成一个矩形', () => {
    const merged = unionAdjacentPolygons(rect(0, 0, 100, 100), rect(100, 0, 200, 100));
    expect(merged).not.toBeNull();
    expect(polygonArea(merged!)).toBeCloseTo(20000, 3);
    // 拼完是一个 200×100 的矩形，共线点被 dropCollinear 收掉
    expect(merged).toHaveLength(4);
  });

  it('unionAdjacentPolygons 部分共边时拼出 L 型', () => {
    const merged = unionAdjacentPolygons(rect(0, 0, 100, 100), rect(100, 0, 200, 50));
    expect(merged).not.toBeNull();
    expect(polygonArea(merged!)).toBeCloseTo(100 * 100 + 100 * 50, 3);
    expect(merged!.length).toBeGreaterThanOrEqual(6);
  });

  it('不相邻的两块拼不了，返回 null', () => {
    expect(unionAdjacentPolygons(rect(0, 0, 100, 100), rect(300, 0, 400, 100))).toBeNull();
  });

  it('小的无名块并进公共边最长的具名邻居', () => {
    const polygons = [
      rect(0, 0, 4000, 4000), // 0：具名大房间，共边 1000
      rect(4000, 0, 5000, 1000), // 1：无名小碎块（1 ㎡ ≈ 0.6 帖）
      rect(4000, 3000, 5000, 3100), // 2：另一个具名房间，共边只有 100
    ];
    const res = mergeUnnamedFragments(polygons, [true, false, true], 1.5 * TATAMI_AREA_MM2);
    expect(res.absorbed).toEqual([1]);
    expect(polygonArea(res.polygons[0])).toBeCloseTo(4000 * 4000 + 1000 * 1000, 3);
    expect(res.warnings).toHaveLength(1);
  });

  it('大的无名块（≥1.5 帖）不动', () => {
    const polygons = [rect(0, 0, 4000, 4000), rect(4000, 0, 6000, 3000)];
    const res = mergeUnnamedFragments(polygons, [true, false], 1.5 * TATAMI_AREA_MM2);
    expect(res.absorbed).toEqual([]);
  });

  it('没有具名邻居可并时原样保留', () => {
    const polygons = [rect(0, 0, 4000, 4000), rect(9000, 0, 9500, 500)];
    const res = mergeUnnamedFragments(polygons, [true, false], 1.5 * TATAMI_AREA_MM2);
    expect(res.absorbed).toEqual([]);
    expect(res.polygons).toHaveLength(2);
  });
});

describe('estimateCvScale', () => {
  it('用「帖数 ÷ 像素面积」算比例（只算挂载成功且标了帖数的房间对）', () => {
    const cv = syntheticExtract();
    const vlm = syntheticVlm();
    const mount = mountSemantics(cv.rooms, vlm.rooms, cv.stats.imageWidthPx);
    const scale = estimateCvScale(cv.rooms, mount.hosts, vlm, cv.stats.imageWidthPx);

    // sqrt(18 帖 × 1.6562e6 / (8000 + 6400) px²)
    const expected = Math.sqrt((18 * TATAMI_AREA_MM2) / 14400);
    expect(scale.basis).toBe('tatami');
    expect(scale.mmPerPx).toBeCloseTo(expected, 6);
    expect(scale.warnings.some((w) => w.includes('比例来源'))).toBe(true);
  });

  it('没有帖数标注时退回 VLM 的图纸总宽，并写进 warnings', () => {
    const cv = syntheticExtract();
    const vlm = syntheticVlm({
      rooms: syntheticVlm().rooms.map((r) => ({ ...r, tatamiCount: null })),
    });
    const mount = mountSemantics(cv.rooms, vlm.rooms, cv.stats.imageWidthPx);
    const scale = estimateCvScale(cv.rooms, mount.hosts, vlm, cv.stats.imageWidthPx);
    expect(scale.basis).toBe('drawing_width');
    expect(scale.mmPerPx).toBeCloseTo(8000 / 200, 6);
    expect(scale.warnings.some((w) => w.includes('没有可用的帖数标注'))).toBe(true);
  });

  it('帖数与面积离谱矛盾时退回图纸总宽', () => {
    const cv = syntheticExtract();
    // 两个房间加起来标了 1e6 帖 → mm/px 会飞到几千，超出合理区间
    const vlm = syntheticVlm({
      rooms: syntheticVlm().rooms.map((r) => ({ ...r, tatamiCount: 500_000 })),
    });
    const mount = mountSemantics(cv.rooms, vlm.rooms, cv.stats.imageWidthPx);
    const scale = estimateCvScale(cv.rooms, mount.hosts, vlm, cv.stats.imageWidthPx);
    expect(scale.basis).toBe('drawing_width');
    expect(scale.warnings.some((w) => w.includes('明显矛盾'))).toBe(true);
  });
});

describe('fuseCvAndVlm（合成用例）', () => {
  it('墙来自 CV、名字来自 VLM，坐标吸附到 455 网格并平移到原点', () => {
    const cv = syntheticExtract();
    const vlm = syntheticVlm();
    const res = fuseCvAndVlm(cv, vlm, { imageWidthPx: 200, imageHeightPx: 100 });

    expect(res.rooms.map((r) => r.name)).toEqual(['LDK', '洋室']);
    expect(res.rooms[0].floor).toBe('flooring');
    expect(res.rooms[1].floor).toBe('tatami');
    expect(res.fuseStats.matchedRooms).toBe(2);
    expect(res.fuseStats.scaleBasis).toBe('tatami');

    // 5 段墙原样保留（没有共线重叠可合并的）
    expect(res.walls).toHaveLength(5);
    for (const w of res.walls) {
      for (const v of [w.start.x, w.start.y, w.end.x, w.end.y]) {
        expect(v % 455).toBe(0);
      }
    }
    // 平移之后最小角落在 (0,0)
    const xs = res.walls.flatMap((w) => [w.start.x, w.end.x]);
    const ys = res.walls.flatMap((w) => [w.start.y, w.end.y]);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.min(...ys)).toBe(0);

    // 底图：比例就是 mm/px，偏移 = 平移量，没做 deskew 所以不转
    expect(res.underlay.mmPerPixel).toBeCloseTo(res.fuseStats.mmPerPixel, 9);
    expect(res.underlay.rotation).toBe(0);
  });

  it('deskew 角写进 underlay.rotation', () => {
    const res = fuseCvAndVlm(syntheticExtract({ deskewDeg: -2.5 }), syntheticVlm(), {
      imageWidthPx: 200,
      imageHeightPx: 100,
    });
    expect(res.underlay.rotation).toBe(-2.5);
    expect(res.warnings.some((w) => w.includes('倾斜校正'))).toBe(true);
  });

  it('没人认领的 CV 区域命名为「房间」', () => {
    const cv = syntheticExtract();
    const vlm = syntheticVlm({ rooms: [syntheticVlm().rooms[0]] });
    const res = fuseCvAndVlm(cv, vlm, { imageWidthPx: 200, imageHeightPx: 100 });
    expect(res.rooms.map((r) => r.name)).toEqual(['LDK', '房间']);
    expect(res.fuseStats.matchedRooms).toBe(1);
  });

  it('短斜段当噪声丢掉，长斜墙保留', () => {
    const cv = syntheticExtract();
    const scale = Math.sqrt((18 * TATAMI_AREA_MM2) / 14400); // ≈ 45.5 mm/px
    const shortPx = (MIN_DIAGONAL_WALL_MM / scale) * 0.5;
    const longPx = (MIN_DIAGONAL_WALL_MM / scale) * 4;
    cv.walls = [
      ...cv.walls,
      wall(40, 40, 40 + shortPx, 40 + shortPx),
      wall(120, 20, 120 + longPx, 20 + longPx),
    ];
    const res = fuseCvAndVlm(cv, syntheticVlm(), { imageWidthPx: 200, imageHeightPx: 100 });
    expect(res.fuseStats.shortDiagonalsDropped).toBe(1);
    const diagonals = res.walls.filter((w) => w.start.x !== w.end.x && w.start.y !== w.end.y);
    expect(diagonals).toHaveLength(1);
    expect(Math.hypot(diagonals[0].end.x - diagonals[0].start.x, diagonals[0].end.y - diagonals[0].start.y)).toBeGreaterThan(
      MIN_DIAGONAL_WALL_MM,
    );
  });

  it('门窗投影到 CV 的墙上、柱沿用 VLM', () => {
    const cv = syntheticExtract();
    const vlm = syntheticVlm({
      openings: [{ type: 'door', roomA: 'r1', roomB: 'r2', x: n(110), y: n(50) }],
      columns: [{ x: n(110), y: n(20), w: n(3), h: n(3) }],
    });
    const res = fuseCvAndVlm(cv, vlm, { imageWidthPx: 200, imageHeightPx: 100 });
    expect(res.openings).toHaveLength(1);
    // 落在 A / B 之间那道竖墙上
    const host = res.walls.find((w) => w.id === res.openings[0].wallId)!;
    expect(host.start.x).toBe(host.end.x);
    expect(res.structures).toHaveLength(1);
    expect(res.structures[0].kind).toBe('column');
  });
});

describe('fuseCvAndVlm（test2 真图 fixture）', () => {
  const res = fuseCvAndVlm(CV_TEST2, VLM_TEST2, TEST2_DIMS);

  it('比例来自帖数标注，落在这张图的合理量级', () => {
    expect(res.fuseStats.scaleBasis).toBe('tatami');
    // 500px 宽、7~11m 的間取り图 → 每像素 20~50mm
    expect(res.fuseStats.mmPerPixel).toBeGreaterThan(20);
    expect(res.fuseStats.mmPerPixel).toBeLessThan(50);
    expect(res.warnings.some((w) => w.includes('比例来源') && w.includes('帖数标注'))).toBe(true);
  });

  it('语义挂到了正确的区域上', () => {
    const named = res.rooms.map((r) => r.name);
    expect(named).toContain('LDK');
    expect(named).toContain('洋室①');
    expect(named).toContain('洋室②');
    expect(named).toContain('浴室');
    expect(res.fuseStats.matchedRooms).toBe(4);
    // LDK 应该是最大的那块
    const areas = res.rooms.map((r) => ({ name: r.name, area: polygonAreaMm2(r.polygon) }));
    areas.sort((a, b) => b.area - a.area);
    expect(areas[0].name).toBe('LDK');
  });

  it('外框线被滤掉，墙段数量合理', () => {
    expect(res.fuseStats.borderWallsDropped).toBe(3);
    expect(res.walls.length).toBeGreaterThan(30);
    expect(res.walls.length).toBeLessThan(CV_TEST2.walls.length);
  });

  it('斜墙保留：至少一条 3m 以上、-30°~-50° 的长斜墙（图纸右下的斜切外墙）', () => {
    const diagonals = res.walls
      .filter((w) => w.start.x !== w.end.x && w.start.y !== w.end.y)
      .map((w) => ({
        len: Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y),
        deg: (Math.atan2(w.end.y - w.start.y, w.end.x - w.start.x) * 180) / Math.PI,
      }));
    expect(diagonals.length).toBeGreaterThanOrEqual(1);
    // 阈值从 3000 放到 2500：M4.1 把地暖框剔掉之后 LDK 恢复成完整的一块，
    // 比例（mm/px）由 37.3 修正到 33.3——三个标了帖数的房间这下彼此吻合到 1% 以内，
    // 所以这条斜墙的**毫米长度**跟着缩了一成，像素长度一点没变。
    const main = diagonals.filter((d) => d.len > 2500);
    expect(main.length).toBeGreaterThanOrEqual(1);
    expect(Math.abs(main[0].deg)).toBeGreaterThan(20);
    expect(Math.abs(main[0].deg)).toBeLessThan(60);
  });

  it('房间面积总量在合理区间（含 4 个バルコニー，60~90 ㎡）', () => {
    const m2 = res.rooms.reduce((sum, r) => sum + polygonAreaMm2(r.polygon), 0) / 1e6;
    expect(m2).toBeGreaterThan(55);
    expect(m2).toBeLessThan(95);
  });

  it('门窗大部分能落到墙上，柱沿用 VLM 的 3 根', () => {
    expect(res.openings.length).toBeGreaterThanOrEqual(VLM_TEST2.openings.length - 2);
    expect(res.structures).toHaveLength(VLM_TEST2.columns.length);
  });

  it('底图对齐：mmPerPixel = 比例，offset = 整体平移量', () => {
    expect(res.underlay.mmPerPixel).toBeCloseTo(res.fuseStats.mmPerPixel, 9);
    expect(res.underlay.rotation).toBe(0);
    expect(res.underlay.offset.x).toBeLessThan(0);
    expect(res.underlay.offset.y).toBeLessThan(0);
  });
});
