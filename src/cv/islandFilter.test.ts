/**
 * `islandFilter.ts` 的单测（纯 TS，不碰 opencv）。
 *
 * 场景一律是「一圈粗外墙 + 中间飘着一个细线框（地暖框 / 指北针 / 家具）」，
 * 要求外墙一根不动、细线框整团被摘掉。
 */
import { describe, expect, it } from 'vitest';
import { dropIslandWalls, findWallIslands, segmentDistance } from './islandFilter';
import type { CvWall } from './types';

function w(x1: number, y1: number, x2: number, y2: number, thicknessPx: number): CvWall {
  return { x1, y1, x2, y2, thicknessPx };
}

/** 100×100 的粗外墙一圈（厚 10） */
const OUTER: CvWall[] = [
  w(0, 0, 100, 0, 10),
  w(100, 0, 100, 100, 10),
  w(100, 100, 0, 100, 10),
  w(0, 100, 0, 0, 10),
];

/** 中间一个 40×30 的细线框（厚 2） */
const ISLAND: CvWall[] = [
  w(30, 35, 70, 35, 2),
  w(70, 35, 70, 65, 2),
  w(70, 65, 30, 65, 2),
  w(30, 65, 30, 35, 2),
];

describe('segmentDistance', () => {
  it('相交的两段距离为 0', () => {
    expect(segmentDistance(w(0, 0, 10, 0, 1), w(5, -5, 5, 5, 1))).toBe(0);
  });

  it('平行错开的两段取最近端点距离', () => {
    expect(segmentDistance(w(0, 0, 10, 0, 1), w(0, 4, 10, 4, 1))).toBeCloseTo(4, 6);
  });

  it('延长线相交但线段本身不相交时不算 0', () => {
    expect(segmentDistance(w(0, 0, 10, 0, 1), w(20, -5, 20, 5, 1))).toBeCloseTo(10, 6);
  });
});

describe('findWallIslands', () => {
  it('外墙连成一团、细线框自成一团，按总长度降序', () => {
    const islands = findWallIslands([...OUTER, ...ISLAND], 3);
    expect(islands).toHaveLength(2);
    expect(islands[0].indices).toHaveLength(4);
    expect(islands[0].lengthPx).toBeCloseTo(400, 6);
    expect(islands[1].lengthPx).toBeCloseTo(140, 6);
    expect(islands[1].thicknessPx).toBeCloseTo(2, 6);
  });

  it('容差够大时两团会被判成连通的一团', () => {
    const islands = findWallIslands([w(0, 0, 10, 0, 4), w(14, 0, 24, 0, 4)], 5);
    expect(islands).toHaveLength(1);
  });

  it('厚度按长度加权平均', () => {
    const [island] = findWallIslands([w(0, 0, 30, 0, 2), w(30, 0, 40, 0, 6)], 1);
    expect(island.thicknessPx).toBeCloseTo((30 * 2 + 10 * 6) / 40, 6);
  });
});

describe('dropIslandWalls', () => {
  it('剔掉「不连通 + 在图纸内部 + 比墙细」的孤岛，外墙一根不动', () => {
    const res = dropIslandWalls([...OUTER, ...ISLAND], { touchTolPx: 3 });
    expect(res.walls).toHaveLength(4);
    expect(res.dropped).toHaveLength(4);
    expect(res.islands).toHaveLength(1);
    expect(res.walls.every((wall) => wall.thicknessPx === 10)).toBe(true);
  });

  it('孤岛但**不细**（真的是一段没接上的隔墙）就留着', () => {
    const stub = ISLAND.map((s) => ({ ...s, thicknessPx: 10 }));
    const res = dropIslandWalls([...OUTER, ...stub], { touchTolPx: 3 });
    expect(res.dropped).toHaveLength(0);
    expect(res.walls).toHaveLength(8);
  });

  it('细但**跟主墙网连着**（内隔墙）不受影响', () => {
    const attached = [
      ...OUTER,
      w(50, 0, 50, 60, 2), // 从上外墙长下来的一道细隔墙
    ];
    const res = dropIslandWalls(attached, { touchTolPx: 3 });
    expect(res.dropped).toHaveLength(0);
  });

  it('细 + 不连通，但**落在图纸范围之外**（相邻户型的残线、图例）就留着', () => {
    const outside = [w(120, 40, 160, 40, 2), w(160, 40, 160, 70, 2)];
    const res = dropIslandWalls([...OUTER, ...outside], { touchTolPx: 3 });
    expect(res.dropped).toHaveLength(0);
    expect(res.walls).toHaveLength(6);
  });

  it('落在某个 CV 房间**内部**的孤岛也算「在图纸里」', () => {
    const far = [w(200, 200, 240, 200, 2), w(240, 200, 240, 230, 2)];
    const rooms = [
      {
        polygon: [
          { x: 190, y: 190 },
          { x: 260, y: 190 },
          { x: 260, y: 250 },
          { x: 190, y: 250 },
        ],
        areaPx: 70 * 60,
      },
    ];
    // 不给 rooms：孤岛在主墙网包围盒之外 → 保留
    expect(dropIslandWalls([...OUTER, ...far], { touchTolPx: 3 }).dropped).toHaveLength(0);
    // 给了 rooms：整体落在房间里 → 剔除
    expect(dropIslandWalls([...OUTER, ...far], { touchTolPx: 3, rooms }).dropped).toHaveLength(2);
  });

  it('只有一团（全连通）时原样返回', () => {
    const res = dropIslandWalls(OUTER, { touchTolPx: 3 });
    expect(res.walls).toHaveLength(4);
    expect(res.dropped).toHaveLength(0);
  });

  it('空输入不炸', () => {
    expect(dropIslandWalls([], { touchTolPx: 3 }).walls).toEqual([]);
  });
});
