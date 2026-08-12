/**
 * M5 融合器单测（见 docs/CV-PIPELINE.md 第 7 节）。
 *
 * 两类用例，与 `fuse.test.ts` 一个路子：
 * - **合成用例**：手搓一个「两室」的 CvExtract + 标注，比例 / 洞口 / 柱都能手算；
 * - **真图 fixture**：`fixtures/cvExtract-test2.json`（`node server/cv-debug.mjs
 *   testdata/test2.jpg --full` 实跑出来的），断言只卡「量级 + 结构」。
 *   M5.2 又加了 test5 那一套（`cvExtract-test5.json` + `label-test5.json`，
 *   后者是 2026-08-12 真实调用的标注存档）：它是「吧台把 LDK 切成三块」的验收场景。
 */
import { describe, expect, it } from 'vitest';
import cvTest2 from './fixtures/cvExtract-test2.json';
import cvTest5 from './fixtures/cvExtract-test5.json';
import labelTest5 from './fixtures/label-test5.json';
import type { CvExtract, CvWall } from '../cv/types';
import { pointInPolygon } from './cvGeometry';
import { pointSegDist } from '../cv/wallNet';
import { polygonAreaMm2 } from '../utils/geometry';
import { TATAMI_AREA_MM2 } from '../utils/units';
import type { LabelResult } from './labelSchema';
import {
  FALLBACK_DRAWING_WIDTH_MM,
  MAX_OPENING_MM,
  MIN_OPENING_MM,
  UNNAMED_ROOM,
  estimateLabelScale,
  labelFuse,
  mergeSplitRooms,
  placeCvColumns,
  placeCvOpenings,
} from './labelFuse';
import type { PlanTransform } from './solve';
import type { Pt } from '../model/types';

const CV_TEST2 = cvTest2 as unknown as CvExtract;
const TEST2_DIMS = { imageWidthPx: 500, imageHeightPx: 375 };

// ---------------------------------------------------------------------------
// 合成素材
// ---------------------------------------------------------------------------

function wall(x1: number, y1: number, x2: number, y2: number, thicknessPx = 4): CvWall {
  return { x1, y1, x2, y2, thicknessPx };
}

/**
 * 两个并排的房间（像素）：
 *   左 100×80 px、右 80×80 px，中间一道竖墙 x=110，墙上 y=30~50 开个门洞。
 */
function makeExtract(overrides: Partial<CvExtract> = {}): CvExtract {
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
    openings: [{ x1: 110, y1: 30, x2: 110, y2: 50, exterior: false, onWallIndex: 3 }],
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
      openingCandidates: 1,
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

/** `sameRoomAs` 绝大多数用例都是 null，这里补默认值让用例写得干净些 */
type PartialLabelRoom = Omit<LabelResult['rooms'][number], 'sameRoomAs'> & { sameRoomAs?: number | null };

function labels(rooms: readonly PartialLabelRoom[]): LabelResult {
  return { notes: '', rooms: rooms.map((r) => ({ sameRoomAs: null, ...r })) };
}

const TWO_ROOMS = labels([
  { index: 1, name: 'LDK', floor: 'flooring', tatamiCount: 8 },
  { index: 2, name: '洋室', floor: 'tatami', tatamiCount: 6.4 },
]);

const DIMS = { imageWidthPx: 200, imageHeightPx: 100 };

function rectPx(x0: number, y0: number, x1: number, y1: number) {
  return {
    polygon: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
    areaPx: (x1 - x0) * (y1 - y0),
  };
}

/** 两块区域中间隔着一整条墙带（x=110 那道墙两侧都是同一间房）→ M5.2 该摘该拼 */
const SPLIT_BY_COUNTER = makeExtract({
  rooms: [rectPx(10, 10, 100, 90), rectPx(120, 10, 190, 90)],
  openings: [],
});

/** 同样的墙带，但右侧下半截是**另一间房**：那是真墙，摘了就是把两间屋打通 */
const SPLIT_BY_REAL_WALL = makeExtract({
  rooms: [rectPx(10, 10, 100, 90), rectPx(120, 10, 190, 45), rectPx(120, 55, 190, 90)],
  openings: [],
});

// ---------------------------------------------------------------------------
// 比例
// ---------------------------------------------------------------------------

describe('estimateLabelScale', () => {
  it('按「编号对应的帖数 ÷ 像素面积」定比例', () => {
    // Σ帖 = 14.4，Σ面积 = 8000+6400 = 14400 px² → k = sqrt(14.4×1.6562e6 / 14400)
    const scale = estimateLabelScale(makeExtract(), TWO_ROOMS, 200);
    expect(scale.basis).toBe('tatami');
    expect(scale.pairs).toBe(2);
    expect(scale.mmPerPx).toBeCloseTo(Math.sqrt((14.4 * TATAMI_AREA_MM2) / 14400), 6);
  });

  it('编号对不上的标注不参与（挂到 3 号，但只有两块区域）', () => {
    const scale = estimateLabelScale(
      makeExtract(),
      labels([{ index: 3, name: 'LDK', floor: 'flooring', tatamiCount: 8 }]),
      200,
    );
    expect(scale.basis).toBe('assumed_width');
  });

  it('被切开的房间（sameRoomAs）帖数只算一次、面积按整组求和', () => {
    // 两块其实是同一个 14.4 帖的房间：帖数算一次、面积 8000+6400 一起用
    const scale = estimateLabelScale(
      makeExtract(),
      labels([
        { index: 1, name: 'LDK', floor: 'flooring', tatamiCount: 14.4 },
        { index: 2, name: 'LDK', floor: 'flooring', tatamiCount: 14.4, sameRoomAs: 1 },
      ]),
      200,
    );
    expect(scale.pairs).toBe(1);
    expect(scale.mmPerPx).toBeCloseTo(Math.sqrt((14.4 * TATAMI_AREA_MM2) / 14400), 6);
  });

  it('不归组时同一个帖数会被算两遍（这正是要避免的失真）', () => {
    const grouped = estimateLabelScale(
      makeExtract(),
      labels([
        { index: 1, name: 'LDK', floor: 'flooring', tatamiCount: 14.4 },
        { index: 2, name: 'LDK', floor: 'flooring', tatamiCount: 14.4, sameRoomAs: 1 },
      ]),
      200,
    );
    const notGrouped = estimateLabelScale(
      makeExtract(),
      labels([
        { index: 1, name: 'LDK', floor: 'flooring', tatamiCount: 14.4 },
        { index: 2, name: '洋室', floor: 'flooring', tatamiCount: 14.4 },
      ]),
      200,
    );
    // 帖数翻倍 → 比例大 √2 倍 → 面积大一倍
    expect(notGrouped.mmPerPx / grouped.mmPerPx).toBeCloseTo(Math.SQRT2, 3);
  });

  it('一个帖数都没有 → 按 9100mm 图宽假设 + 明确警告', () => {
    const scale = estimateLabelScale(
      makeExtract(),
      labels([{ index: 1, name: 'LDK', floor: 'flooring', tatamiCount: null }]),
      200,
    );
    expect(scale.basis).toBe('assumed_width');
    expect(scale.mmPerPx).toBeCloseTo(FALLBACK_DRAWING_WIDTH_MM / 200, 6);
    expect(scale.warnings.join()).toContain('底图标定');
  });
});

// ---------------------------------------------------------------------------
// 洞口
// ---------------------------------------------------------------------------

describe('placeCvOpenings', () => {
  const walls = [{ id: 'w1', start: { x: 0, y: 0 }, end: { x: 10000, y: 0 } }];

  /** 恒等变换（空的 AxisMap = 原样透传），让像素数值可以直接当 mm 读 */
  function tf(k: number): PlanTransform {
    return {
      k,
      xMap: { entries: [], tolerance: 0 },
      yMap: { entries: [], tolerance: 0 },
      translation: { x: 0, y: 0 },
    };
  }

  it('内墙缺口 → 门（带 swing），外墙缺口 → 窗', () => {
    const out = placeCvOpenings(
      [
        { x1: 1000, y1: 0, x2: 1900, y2: 0, exterior: false },
        { x1: 4000, y1: 0, x2: 5600, y2: 0, exterior: true },
      ],
      walls,
      1,
      tf(1),
    );
    expect(out.openings.map((o) => o.type)).toEqual(['door', 'window']);
    expect(out.openings[0].swing).toBeDefined();
    expect(out.openings[1].swing).toBeUndefined();
  });

  it('宽度取缺口实测值', () => {
    const out = placeCvOpenings(
      [{ x1: 1000, y1: 0, x2: 1900, y2: 0, exterior: false }],
      walls,
      1,
      tf(1),
    );
    expect(out.openings[0].width).toBe(900);
  });

  it(`宽度 < ${MIN_OPENING_MM}mm 或 > ${MAX_OPENING_MM}mm 的丢掉`, () => {
    const out = placeCvOpenings(
      [
        { x1: 1000, y1: 0, x2: 1400, y2: 0, exterior: false }, // 400mm
        { x1: 2000, y1: 0, x2: 5000, y2: 0, exterior: false }, // 3000mm
      ],
      walls,
      1,
      tf(1),
    );
    expect(out.openings).toHaveLength(0);
    expect(out.widthDropped).toBe(2);
  });

  it('比例换算之后才判宽度（px 一样、mm/px 不同 → 结论不同）', () => {
    const candidate = [{ x1: 10, y1: 0, x2: 19, y2: 0, exterior: false }];
    expect(placeCvOpenings(candidate, walls, 100, tf(100)).openings).toHaveLength(1);
    expect(placeCvOpenings(candidate, walls, 10, tf(10)).openings).toHaveLength(0);
  });

  it('离所有墙都太远的缺口丢掉', () => {
    const out = placeCvOpenings(
      [{ x1: 1000, y1: 9000, x2: 1900, y2: 9000, exterior: false }],
      walls,
      1,
      tf(1),
    );
    expect(out.openings).toHaveLength(0);
    expect(out.orphanDropped).toBe(1);
  });

  it('同一道墙上重叠的洞口会被挪开或丢弃，不会叠在一起', () => {
    const out = placeCvOpenings(
      [
        { x1: 1000, y1: 0, x2: 1900, y2: 0, exterior: false },
        { x1: 1050, y1: 0, x2: 1950, y2: 0, exterior: false },
      ],
      walls,
      1,
      tf(1),
    );
    const spans = out.openings.map((o) => [o.offset, o.offset + o.width]);
    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < spans.length; j++) {
        expect(spans[i][1] <= spans[j][0] || spans[j][1] <= spans[i][0]).toBe(true);
      }
    }
  });

  it('洞口坐标走的是与墙同一条轴映射（不是简单的 ×k + 平移）', () => {
    // xMap 把 1000mm 附近整体挪到 2000mm；洞口必须跟着挪，否则会挂到别处或挂不上
    const shifted: PlanTransform = {
      k: 1,
      xMap: { entries: [{ from: 1450, to: 2450 }], tolerance: 2000 },
      yMap: { entries: [], tolerance: 0 },
      translation: { x: 0, y: 0 },
    };
    const out = placeCvOpenings(
      [{ x1: 1000, y1: 0, x2: 1900, y2: 0, exterior: false }],
      walls,
      1,
      shifted,
    );
    expect(out.openings).toHaveLength(1);
    // 中心 1450 → 2450，洞口按宽度 900 居中放置 → offset ≈ 2000
    expect(out.openings[0].offset).toBeCloseTo(2000, 0);
  });
});

// ---------------------------------------------------------------------------
// 柱
// ---------------------------------------------------------------------------

describe('placeCvColumns', () => {
  function tf(k: number, translation = { x: 0, y: 0 }): PlanTransform {
    return {
      k,
      xMap: { entries: [], tolerance: 0 },
      yMap: { entries: [], tolerance: 0 },
      translation,
    };
  }

  it('像素中心 ×比例 + 平移 → 吸附 100mm', () => {
    const out = placeCvColumns([{ x: 10, y: 20, wPx: 3, hPx: 3 }], 30, tf(30, { x: 5, y: 5 }));
    expect(out[0].position).toEqual({ x: 300, y: 600 });
    expect(out[0].width).toBe(90);
    expect(out[0].kind).toBe('column');
  });

  it('尺寸夹到合理区间（50~1200mm）', () => {
    const tiny = placeCvColumns([{ x: 0, y: 0, wPx: 0.1, hPx: 0.1 }], 1, tf(1));
    expect(tiny[0].width).toBe(50);
    const huge = placeCvColumns([{ x: 0, y: 0, wPx: 100, hPx: 100 }], 100, tf(100));
    expect(huge[0].width).toBe(1200);
  });
});

// ---------------------------------------------------------------------------
// 碎块拼回
// ---------------------------------------------------------------------------

describe('mergeSplitRooms', () => {
  /** 两块并排的矩形，共享 x=100 那条边 */
  const LEFT: Pt[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 80 },
    { x: 0, y: 80 },
  ];
  const RIGHT: Pt[] = [
    { x: 100, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 80 },
    { x: 100, y: 80 },
  ];

  it('同组的相邻块拼成一个多边形', () => {
    const out = mergeSplitRooms([LEFT, RIGHT], [0, 1], new Map([[1, 1], [2, 1]]));
    expect(out.rooms).toHaveLength(1);
    expect(out.mergedPieces).toBe(1);
    expect(out.rooms[0].cvIndex).toBe(0);
    expect(polygonAreaMm2(out.rooms[0].polygon)).toBeCloseTo(200 * 80, 6);
  });

  it('不同组的块各自成房间', () => {
    const out = mergeSplitRooms([LEFT, RIGHT], [0, 1], new Map([[1, 1], [2, 2]]));
    expect(out.rooms).toHaveLength(2);
    expect(out.mergedPieces).toBe(0);
  });

  it('同组但拼不上（不相邻）时原样保留两块', () => {
    const far: Pt[] = [
      { x: 500, y: 0 },
      { x: 600, y: 0 },
      { x: 600, y: 80 },
      { x: 500, y: 80 },
    ];
    const out = mergeSplitRooms([LEFT, far], [0, 1], new Map([[1, 1], [2, 1]]));
    expect(out.rooms).toHaveLength(2);
    expect(out.mergedPieces).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 端到端（合成）
// ---------------------------------------------------------------------------

describe('labelFuse（合成用例）', () => {
  it('按编号挂语义：1 号是 LDK，2 号是洋室', () => {
    const out = labelFuse(makeExtract(), TWO_ROOMS, DIMS);
    expect(out.rooms.map((r) => r.name)).toEqual(['LDK', '洋室']);
    expect(out.rooms.map((r) => r.floor)).toEqual(['flooring', 'tatami']);
    expect(out.labelStats.namedRooms).toBe(2);
  });

  it('AI 漏答的编号显示成「房间」并报警告', () => {
    const out = labelFuse(
      makeExtract(),
      labels([{ index: 1, name: 'LDK', floor: 'flooring', tatamiCount: 8 }]),
      DIMS,
    );
    expect(out.rooms[1].name).toBe(UNNAMED_ROOM);
    expect(out.warnings.join()).toContain('没能认出房间名');
  });

  it('面积与帖数标注自洽（比例本来就是这么定出来的）', () => {
    const out = labelFuse(makeExtract(), TWO_ROOMS, DIMS);
    const ldk = polygonAreaMm2(out.rooms[0].polygon) / TATAMI_AREA_MM2;
    expect(ldk).toBeGreaterThan(8 * 0.75);
    expect(ldk).toBeLessThan(8 * 1.25);
    expect(out.areaMismatchRoomIds).toEqual([]);
  });

  it('CV 洞口候选变成门（内墙）', () => {
    const out = labelFuse(makeExtract(), TWO_ROOMS, DIMS);
    expect(out.openings).toHaveLength(1);
    expect(out.openings[0].type).toBe('door');
    expect(out.labelStats.openingCandidates).toBe(1);
    expect(out.labelStats.openingsPlaced).toBe(1);
  });

  it('CV 柱候选变成 structure', () => {
    const out = labelFuse(
      makeExtract({ columns: [{ x: 110, y: 70, wPx: 5, hPx: 5 }] }),
      TWO_ROOMS,
      DIMS,
    );
    expect(out.structures).toHaveLength(1);
    expect(out.structures[0].kind).toBe('column');
  });

  it('墙全部来自 CV，且都落在 (0,0) 之后（做过平移）', () => {
    const out = labelFuse(makeExtract(), TWO_ROOMS, DIMS);
    expect(out.walls.length).toBeGreaterThanOrEqual(4);
    for (const w of out.walls) {
      expect(Math.min(w.start.x, w.end.x)).toBeGreaterThanOrEqual(0);
      expect(Math.min(w.start.y, w.end.y)).toBeGreaterThanOrEqual(0);
    }
  });

  it('underlay 的比例 = mm/px，rotation = deskew', () => {
    const out = labelFuse(makeExtract({ deskewDeg: 1.5 }), TWO_ROOMS, DIMS);
    expect(out.underlay.mmPerPixel).toBeCloseTo(out.mmPerUnit, 9);
    expect(out.underlay.rotation).toBe(1.5);
    expect(out.warnings.join()).toContain('倾斜校正');
  });

  it('端到端：sameRoomAs 的两块会拼成一个房间', () => {
    const out = labelFuse(
      makeExtract(),
      labels([
        { index: 1, name: 'LDK', floor: 'flooring', tatamiCount: 14.4 },
        { index: 2, name: 'LDK', floor: 'flooring', tatamiCount: 14.4, sameRoomAs: 1 },
      ]),
      DIMS,
    );
    expect(out.rooms).toHaveLength(1);
    expect(out.rooms[0].name).toBe('LDK');
    expect(out.labelStats.mergedPieces).toBe(1);
    // 拼回去之后面积应当与 14.4 帖标注对得上
    const tatami = polygonAreaMm2(out.rooms[0].polygon) / TATAMI_AREA_MM2;
    expect(tatami).toBeGreaterThan(14.4 * 0.8);
    expect(tatami).toBeLessThan(14.4 * 1.2);
  });

  it('M5.2：中间隔着一道吧台墙的两块，摘墙 + 栅格拼合成一间', () => {
    // 两块 CV 区域之间是一整条墙带（没有共享边，`unionAdjacentPolygons` 拼不出单个环）；
    // M5.2 靠法向探针认出「两侧都是本组碎块」，把那道墙摘掉再用栅格搭桥。
    const out = labelFuse(
      SPLIT_BY_COUNTER,
      labels([
        { index: 1, name: 'LDK', floor: 'flooring', tatamiCount: 14.4 },
        { index: 2, name: 'LDK', floor: 'flooring', tatamiCount: 14.4, sameRoomAs: 1 },
      ]),
      DIMS,
    );
    expect(out.rooms).toHaveLength(1);
    expect(out.rooms[0].name).toBe('LDK');
    expect(out.labelStats.mergedPieces).toBe(1);
    expect(out.labelStats.fakePartitionsRemoved).toBeGreaterThan(0);
    expect(out.warnings.join()).toContain('已摘除');
    // 摘掉的那道墙不应该还留在成果里
    expect(out.walls.some((w) => w.start.x === w.end.x && w.start.x > 3000 && w.start.x < 6000)).toBe(
      false,
    );
    const tatami = polygonAreaMm2(out.rooms[0].polygon) / TATAMI_AREA_MM2;
    expect(tatami).toBeGreaterThan(14.4 * 0.75);
    expect(tatami).toBeLessThan(14.4 * 1.25);
  });

  it('M5.2：碎块之间是真墙（另一侧还有别的房间）时不摘，保留分块并清掉帖数', () => {
    const out = labelFuse(
      SPLIT_BY_REAL_WALL,
      labels([
        { index: 1, name: 'LDK', floor: 'flooring', tatamiCount: 14.4 },
        { index: 2, name: 'LDK', floor: 'flooring', tatamiCount: 14.4, sameRoomAs: 1 },
        { index: 3, name: '洋室', floor: 'tatami', tatamiCount: 4.5 },
      ]),
      DIMS,
    );
    expect(out.rooms).toHaveLength(3);
    expect(out.labelStats.mergedPieces).toBe(0);
    expect(out.labelStats.fakePartitionsRemoved).toBe(0);
    expect(out.warnings.join()).toContain('存在共享墙');
    // 关键：没有「面积与标注偏差」的警报，取而代之的是一条说明
    expect(out.areaMismatchRoomIds).toEqual([]);
    expect(out.warnings.join()).toContain('半截隔断');
  });

  it('AI 一条标注都没给也不炸（全是「房间」+ 兜底比例）', () => {
    const out = labelFuse(makeExtract(), labels([]), DIMS);
    expect(out.rooms).toHaveLength(2);
    expect(out.rooms.every((r) => r.name === UNNAMED_ROOM)).toBe(true);
    expect(out.labelStats.scaleBasis).toBe('assumed_width');
  });
});

// ---------------------------------------------------------------------------
// 端到端（test2 真图 fixture）
// ---------------------------------------------------------------------------

describe('labelFuse（test2 真图 fixture）', () => {
  /** 按 test2 图上的实际标注（洋室① 7.0 / 洋室② 5.6 / LDK 15.5）手工对上 CV 的区域编号 */
  const TEST2_LABELS: LabelResult = labels([
    { index: 1, name: 'リビング・ダイニング・キッチン', floor: 'flooring', tatamiCount: 15.5 },
    { index: 2, name: '洋室(1)', floor: 'flooring', tatamiCount: 7 },
    { index: 3, name: '洋室(2)', floor: 'flooring', tatamiCount: 5.6 },
    { index: 4, name: 'バルコニー', floor: 'tile', tatamiCount: null },
    { index: 5, name: 'サービスバルコニー', floor: 'tile', tatamiCount: null },
    { index: 6, name: 'ウォークインクローゼット', floor: 'flooring', tatamiCount: null },
  ]);

  it('fixture 自身是完整的 M5 提取结果', () => {
    expect(CV_TEST2.walls.length).toBeGreaterThan(50);
    expect(CV_TEST2.rooms.length).toBeGreaterThanOrEqual(6);
    expect(Array.isArray(CV_TEST2.openings)).toBe(true);
    expect(Array.isArray(CV_TEST2.columns)).toBe(true);
  });

  it('比例由帖数标注定出，落在合理量级（1px ≈ 30~40mm）', () => {
    const out = labelFuse(CV_TEST2, TEST2_LABELS, TEST2_DIMS);
    expect(out.labelStats.scaleBasis).toBe('tatami');
    expect(out.mmPerUnit).toBeGreaterThan(25);
    expect(out.mmPerUnit).toBeLessThan(45);
  });

  it('图片外框被滤掉，斜墙还在', () => {
    const out = labelFuse(CV_TEST2, TEST2_LABELS, TEST2_DIMS);
    expect(out.labelStats.borderWallsDropped).toBeGreaterThan(0);
    const diagonals = out.walls.filter((w) => w.start.x !== w.end.x && w.start.y !== w.end.y);
    expect(diagonals.length).toBeGreaterThan(0);
  });

  it('LDK 的面积与 15.5 帖标注对得上（±25%）', () => {
    const out = labelFuse(CV_TEST2, TEST2_LABELS, TEST2_DIMS);
    const ldk = out.rooms.find((r) => r.name.includes('リビング'));
    expect(ldk).toBeDefined();
    const tatami = polygonAreaMm2(ldk!.polygon) / TATAMI_AREA_MM2;
    expect(tatami).toBeGreaterThan(15.5 * 0.75);
    expect(tatami).toBeLessThan(15.5 * 1.25);
  });

  it('洞口候选大部分能落进墙里', () => {
    const out = labelFuse(CV_TEST2, TEST2_LABELS, TEST2_DIMS);
    expect(out.labelStats.openingCandidates).toBeGreaterThan(0);
    expect(out.labelStats.openingsPlaced).toBeGreaterThan(0);
    for (const o of out.openings) {
      expect(o.width).toBeGreaterThanOrEqual(MIN_OPENING_MM);
      expect(o.width).toBeLessThanOrEqual(MAX_OPENING_MM);
      expect(out.walls.some((w) => w.id === o.wallId)).toBe(true);
    }
  });

  it('每块 CV 区域都成为一个房间（test2 没有 sameRoomAs 组，编号一一对应）', () => {
    const out = labelFuse(CV_TEST2, TEST2_LABELS, TEST2_DIMS);
    expect(out.rooms.length).toBe(CV_TEST2.rooms.length);
  });

  it('M5.2 对没有 sameRoomAs 组的图零改动（test2 回归）', () => {
    const out = labelFuse(CV_TEST2, TEST2_LABELS, TEST2_DIMS);
    expect(out.labelStats.fakePartitionsRemoved).toBe(0);
    expect(out.labelStats.mergedPieces).toBe(0);
    expect(out.labelStats.danglingEndsAfterMerge).toBeUndefined();
    expect(out.warnings.join()).not.toContain('已摘除');
  });
});

// ---------------------------------------------------------------------------
// 端到端（test5 真图 fixture）：M5.2 的验收场景
// ---------------------------------------------------------------------------

describe('labelFuse（test5 真图 fixture · M5.2 碎块拼合）', () => {
  const CV_TEST5 = cvTest5 as unknown as CvExtract;
  const TEST5_LABELS = labelTest5 as unknown as LabelResult;
  const TEST5_DIMS = { imageWidthPx: 500, imageHeightPx: 375 };
  /** 同一份标注，但把 sameRoomAs 全抹掉 —— 拿来当「不拼合」的基线 */
  const TEST5_UNGROUPED: LabelResult = {
    notes: TEST5_LABELS.notes,
    rooms: TEST5_LABELS.rooms.map((r) => ({ ...r, sameRoomAs: null })),
  };

  it('fixture 自身：13 块区域，AI 把它们归成了 4 个组', () => {
    expect(CV_TEST5.rooms).toHaveLength(13);
    expect(TEST5_LABELS.rooms.filter((r) => r.sameRoomAs !== null)).toHaveLength(5);
  });

  it('三块 LDK 合并成**一个**房间（M5.2 的核心验收）', () => {
    const before = labelFuse(CV_TEST5, TEST5_UNGROUPED, TEST5_DIMS);
    const after = labelFuse(CV_TEST5, TEST5_LABELS, TEST5_DIMS);
    expect(before.rooms.filter((r) => r.name === 'LDK')).toHaveLength(3);
    expect(after.rooms.filter((r) => r.name === 'LDK')).toHaveLength(1);
  });

  it('拼回来的 LDK 面积与 18.4 帖标注对得上（±25%）', () => {
    const out = labelFuse(CV_TEST5, TEST5_LABELS, TEST5_DIMS);
    const ldk = out.rooms.find((r) => r.name === 'LDK')!;
    const tatami = polygonAreaMm2(ldk.polygon) / TATAMI_AREA_MM2;
    expect(tatami).toBeGreaterThan(18.4 * 0.75);
    expect(tatami).toBeLessThan(18.4 * 1.25);
    // 拼出来的是一个规规矩矩的直角多边形，不是几十级台阶
    expect(ldk.polygon.length).toBeLessThanOrEqual(20);
  });

  it('摘掉了吧台隔断，而且没留下新的悬空线头', () => {
    const out = labelFuse(CV_TEST5, TEST5_LABELS, TEST5_DIMS);
    expect(out.labelStats.fakePartitionsRemoved).toBeGreaterThan(0);
    expect(out.labelStats.danglingEndsAfterMerge).toBeLessThanOrEqual(
      out.labelStats.danglingEndsBeforeMerge!,
    );
    expect(out.warnings.join()).not.toContain('多出了');
  });

  it('拼回来的 LDK 中间不再横着一道墙', () => {
    const out = labelFuse(CV_TEST5, TEST5_LABELS, TEST5_DIMS);
    const ldk = out.rooms.find((r) => r.name === 'LDK')!;
    // 「在房间里」= 落在多边形内且离每条边都超过 300mm（外墙本来就压在边界上，不算）
    const inside = out.walls.filter((w) => {
      const mid = { x: (w.start.x + w.end.x) / 2, y: (w.start.y + w.end.y) / 2 };
      if (!pointInPolygon(mid, ldk.polygon)) return false;
      return ldk.polygon.every((p, i) => {
        const q = ldk.polygon[(i + 1) % ldk.polygon.length];
        return pointSegDist(mid, { x1: p.x, y1: p.y, x2: q.x, y2: q.y }) > 300;
      });
    });
    expect(inside).toEqual([]);
  });

  it('探到共享墙的组（バルコニー）保留分块，不硬拼', () => {
    const out = labelFuse(CV_TEST5, TEST5_LABELS, TEST5_DIMS);
    expect(out.warnings.join()).toContain('存在共享墙');
    expect(out.rooms.filter((r) => r.name === 'バルコニー')).toHaveLength(2);
  });

  it('其余房间不受影响（帖数与 M5.1 的实测存档逐个对得上）', () => {
    // 数字来自 M5.1 的真实调用存档（testdata/results/2026-08-11T17-53-51）：
    // 这几间不在任何 sameRoomAs 组里，M5.2 一个坐标都不该动。
    const expected: Record<string, number> = { 洗面所: 2.1, 玄関: 1.0, ポーチ: 1.0, トイレ: 1.3 };
    const out = labelFuse(CV_TEST5, TEST5_LABELS, TEST5_DIMS);
    for (const [name, tatami] of Object.entries(expected)) {
      const room = out.rooms.find((r) => r.name === name);
      expect(room, name).toBeDefined();
      const actual = polygonAreaMm2(room!.polygon) / TATAMI_AREA_MM2;
      expect(Math.abs(actual - tatami), `${name} ${actual.toFixed(2)}帖`).toBeLessThan(0.1);
    }
    // 面积存疑的房间一个都不该冒出来
    expect(out.areaMismatchRoomIds).toEqual([]);
  });
});
