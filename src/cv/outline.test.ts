/**
 * M5.1 建筑轮廓外剔除的单测（合成用例）。
 *
 * 画布 200×200，建筑 = (20,20)–(120,120) 的方框；
 * 「指北针」放在 (160,160) 附近，离建筑远远的。
 */
import { describe, expect, it } from 'vitest';
import { buildBuildingOutline, dropOutsideWalls } from './outline';
import type { CvRoom, CvWall } from './types';

function wall(x1: number, y1: number, x2: number, y2: number, thicknessPx = 4): CvWall {
  return { x1, y1, x2, y2, thicknessPx };
}

/** 建筑外墙（闭合方框） */
const BUILDING: CvWall[] = [
  wall(20, 20, 120, 20),
  wall(120, 20, 120, 120),
  wall(120, 120, 20, 120),
  wall(20, 120, 20, 20),
];

const ROOM: CvRoom = {
  polygon: [
    { x: 22, y: 22 },
    { x: 118, y: 22 },
    { x: 118, y: 118 },
    { x: 22, y: 118 },
  ],
  areaPx: 96 * 96,
};

const OPTS = { width: 200, height: 200, marginPx: 4, cellPx: 2 };

describe('buildBuildingOutline', () => {
  it('墙网围出来的整块面都算建筑内部（房间提不出来也一样）', () => {
    const outline = buildBuildingOutline([], BUILDING, OPTS)!;
    expect(outline).not.toBeNull();
    // 屋里（哪怕 CV 一块房间都没分出来）
    expect(outline.contains({ x: 70, y: 70 })).toBe(true);
    // 墙上
    expect(outline.contains({ x: 20, y: 70 })).toBe(true);
    // 屋外
    expect(outline.contains({ x: 170, y: 170 })).toBe(false);
  });

  it('向外扩 marginPx：墙外一点点还算建筑，远处不算', () => {
    const outline = buildBuildingOutline([], BUILDING, OPTS)!;
    expect(outline.contains({ x: 17, y: 70 })).toBe(true); // 墙外 3px < margin 4
    expect(outline.contains({ x: 5, y: 70 })).toBe(false); // 墙外 15px
  });

  it('房间和墙都没有 → null（没依据就不剔除）', () => {
    expect(buildBuildingOutline([], [], OPTS)).toBeNull();
  });

  it('墙网没围严实时靠房间兜底', () => {
    // 只给一段孤零零的墙，围不出面；房间多边形补上
    const outline = buildBuildingOutline([ROOM], [wall(20, 20, 120, 20)], OPTS)!;
    expect(outline.contains({ x: 70, y: 70 })).toBe(true);
    expect(outline.contains({ x: 170, y: 170 })).toBe(false);
  });

  it('门洞用 sealSegments 封上，洪水填充才不会灌进屋里', () => {
    // 右墙留一个 30px 的大口子
    const leaky: CvWall[] = [
      wall(20, 20, 120, 20),
      wall(120, 20, 120, 55),
      wall(120, 85, 120, 120),
      wall(120, 120, 20, 120),
      wall(20, 120, 20, 20),
    ];
    const open = buildBuildingOutline([], leaky, OPTS)!;
    expect(open.contains({ x: 70, y: 70 })).toBe(false); // 漏了，整屋算外部

    const sealed = buildBuildingOutline([], leaky, {
      ...OPTS,
      sealSegments: [{ x1: 120, y1: 55, x2: 120, y2: 85 }],
    })!;
    expect(sealed.contains({ x: 70, y: 70 })).toBe(true);
  });
});

describe('dropOutsideWalls', () => {
  it('指北针（两端都在轮廓外）被剔除，真墙一段不少', () => {
    const compass = wall(160, 160, 180, 180);
    const partition = wall(70, 20, 70, 120);
    const walls = [...BUILDING, partition, compass];

    const outline = buildBuildingOutline([ROOM], BUILDING, OPTS);
    const out = dropOutsideWalls(walls, outline);

    expect(out.dropped).toHaveLength(1);
    expect(out.dropped[0]).toEqual(compass);
    expect(out.walls).toHaveLength(5);
    expect(out.indexMap).toEqual([0, 1, 2, 3, 4, -1]);
  });

  it('CV 认不出的小隔间（房间并集里的空洞）里的内墙不会被误杀', () => {
    // 建筑里挖出一小块「洗面所」：房间多边形只覆盖左半边，右半边一块区域没房间
    const halfRoom: CvRoom = {
      polygon: [
        { x: 22, y: 22 },
        { x: 60, y: 22 },
        { x: 60, y: 118 },
        { x: 22, y: 118 },
      ],
      areaPx: 38 * 96,
    };
    const pocketWall = wall(80, 40, 110, 40);
    const outline = buildBuildingOutline([halfRoom], BUILDING, OPTS);
    const out = dropOutsideWalls([...BUILDING, pocketWall], outline);
    expect(out.dropped).toHaveLength(0);
  });

  it('横穿建筑、两头都伸到外面的墙保留（中点在里面）', () => {
    const crossing = wall(-20, 70, 220, 70);
    const outline = buildBuildingOutline([ROOM], BUILDING, OPTS);
    const out = dropOutsideWalls([...BUILDING, crossing], outline);
    expect(out.dropped).toHaveLength(0);
  });

  it('没有轮廓时原样返回', () => {
    const out = dropOutsideWalls(BUILDING, null);
    expect(out.walls).toHaveLength(4);
    expect(out.dropped).toHaveLength(0);
    expect(out.indexMap).toEqual([0, 1, 2, 3]);
  });
});
