/**
 * M5.1 墙网闭合的单测（合成用例，全部能手算）。
 *
 * 换算关系：`pxPerMm = strokePx / 140mm`，所以取 `strokePx = 20` 时
 * 1mm = 1/7 px、250mm ≈ 35.7px、600mm ≈ 85.7px，凑整好写。
 */
import { describe, expect, it } from 'vitest';
import type { CvWall } from './types';
import {
  closeDanglingEnds,
  composeIndexMaps,
  countDanglingEnds,
  findDanglingEnds,
  mergeWallsAcrossGaps,
} from './wallNet';

function wall(x1: number, y1: number, x2: number, y2: number, thicknessPx = 20): CvWall {
  return { x1, y1, x2, y2, thicknessPx };
}

const STROKE = 20;
/** `strokePx / 140mm` */
const PX_PER_MM = STROKE / 140;

describe('mergeWallsAcrossGaps（跨洞合墙）', () => {
  it('门洞两侧的共线墙合成一条连续墙', () => {
    const walls = [wall(0, 0, 100, 0), wall(160, 0, 300, 0)];
    const out = mergeWallsAcrossGaps(walls, [{ a: 0, b: 1 }], { offsetTolPx: 5 });

    expect(out.walls).toHaveLength(1);
    expect(out.mergedCount).toBe(1);
    expect(out.walls[0].x1).toBeCloseTo(0, 6);
    expect(out.walls[0].x2).toBeCloseTo(300, 6);
    expect(out.walls[0].y1).toBeCloseTo(0, 6);
    expect(out.walls[0].y2).toBeCloseTo(0, 6);
    // 两段都要映射到合并后的那一条
    expect(out.indexMap).toEqual([0, 0]);
  });

  it('厚度按长度加权平均', () => {
    const walls = [wall(0, 0, 100, 0, 10), wall(160, 0, 300, 0, 24)];
    const out = mergeWallsAcrossGaps(walls, [{ a: 0, b: 1 }], { offsetTolPx: 5 });
    // (10×100 + 24×140) / 240 = 17.83…
    expect(out.walls[0].thicknessPx).toBeCloseTo((10 * 100 + 24 * 140) / 240, 6);
  });

  it('连着几个洞口的（A—洞—B—洞—C）并成一条', () => {
    const walls = [wall(0, 0, 100, 0), wall(160, 0, 260, 0), wall(320, 0, 400, 0)];
    const out = mergeWallsAcrossGaps(
      walls,
      [
        { a: 0, b: 1 },
        { a: 1, b: 2 },
      ],
      { offsetTolPx: 5 },
    );
    expect(out.walls).toHaveLength(1);
    expect(out.walls[0].x2).toBeCloseTo(400, 6);
    expect(out.indexMap).toEqual([0, 0, 0]);
  });

  it('法向偏得太远的不合（不是同一道墙）', () => {
    const walls = [wall(0, 0, 100, 0), wall(160, 40, 300, 40)];
    const out = mergeWallsAcrossGaps(walls, [{ a: 0, b: 1 }], { offsetTolPx: 5 });
    expect(out.walls).toHaveLength(2);
    expect(out.mergedCount).toBe(0);
  });

  it('垂直的两段不合', () => {
    const walls = [wall(0, 0, 100, 0), wall(120, 0, 120, 100)];
    const out = mergeWallsAcrossGaps(walls, [{ a: 0, b: 1 }], { offsetTolPx: 5 });
    expect(out.walls).toHaveLength(2);
  });

  it('没有配对时原样返回', () => {
    const walls = [wall(0, 0, 100, 0), wall(160, 0, 300, 0)];
    const out = mergeWallsAcrossGaps(walls, [], { offsetTolPx: 5 });
    expect(out.walls).toHaveLength(2);
    expect(out.indexMap).toEqual([0, 1]);
  });

  it('跨洞合墙把两个悬空端点一起消掉', () => {
    const walls = [wall(0, 0, 100, 0), wall(160, 0, 300, 0)];
    expect(countDanglingEnds(walls, 24)).toBe(4);
    const out = mergeWallsAcrossGaps(walls, [{ a: 0, b: 1 }], { offsetTolPx: 5 });
    expect(countDanglingEnds(out.walls, 24)).toBe(2);
  });
});

describe('findDanglingEnds（悬空端点的度量）', () => {
  it('闭合的矩形一个悬空端点都没有', () => {
    const walls = [
      wall(0, 0, 100, 0),
      wall(100, 0, 100, 100),
      wall(100, 100, 0, 100),
      wall(0, 100, 0, 0),
    ];
    expect(findDanglingEnds(walls, 5)).toHaveLength(0);
  });

  it('T 接的那一端不算悬空，另一端算', () => {
    const walls = [wall(0, 0, 0, 100), wall(0, 50, 60, 50)];
    const free = findDanglingEnds(walls, 5);
    // 竖墙两端 + 横墙的右端；横墙左端搭在竖墙上
    expect(free).toHaveLength(3);
    expect(free.some((d) => d.wall === 1 && d.end === 1)).toBe(true);
    expect(free.some((d) => d.wall === 1 && d.end === 0)).toBe(false);
  });
});

describe('closeDanglingEnds（悬空端点闭合）', () => {
  const opts = { strokePx: STROKE, pxPerMm: PX_PER_MM };

  it('差一点没接上的端点延伸到交点（T 接）', () => {
    // 吸附容差 24px，搜索半径 max(1.5×20, 250mm≈35.7) = 35.7px；缺口 30px 正好在中间
    const walls = [wall(100, 0, 100, 200), wall(0, 100, 70, 100)];
    const out = closeDanglingEnds(walls, opts);

    expect(out.extended).toBe(1);
    expect(out.walls[1].x2).toBeCloseTo(100, 6);
    expect(out.walls[1].y2).toBeCloseTo(100, 6);
    expect(out.danglingBefore).toBeGreaterThan(out.danglingAfter);
  });

  it('超出搜索半径的不动（不许把墙拉飞）', () => {
    // 缺口 60px，远超搜索半径 35.7px；线段本身 140px（够长，不会当碎屑丢掉）
    const walls = [wall(100, 0, 100, 200), wall(-100, 100, 40, 100)];
    const out = closeDanglingEnds(walls, opts);
    expect(out.extended).toBe(0);
    expect(out.walls[1].x2).toBeCloseTo(40, 6);
  });

  it('两端都悬空 + 短于 600mm 的碎屑丢掉', () => {
    // 600mm ≈ 85.7px，这段 50px
    const walls = [wall(0, 0, 200, 0), wall(0, 500, 50, 500)];
    const out = closeDanglingEnds(walls, opts);
    expect(out.dropped).toHaveLength(1);
    expect(out.walls).toHaveLength(1);
    expect(out.indexMap).toEqual([0, -1]);
  });

  it('阳台矮墙那种「够长的自由端」保留下来并计进 danglingAfter', () => {
    // 200px ≈ 1400mm，远超 600mm 的碎屑线
    const walls = [wall(0, 0, 200, 0), wall(0, 500, 200, 500)];
    const out = closeDanglingEnds(walls, opts);
    expect(out.dropped).toHaveLength(0);
    expect(out.walls).toHaveLength(2);
    expect(out.danglingAfter).toBe(4);
  });

  it('一端接住了就不算碎屑（哪怕很短）', () => {
    const walls = [wall(0, 0, 200, 0), wall(100, 0, 100, 40)];
    const out = closeDanglingEnds(walls, opts);
    expect(out.dropped).toHaveLength(0);
    expect(out.walls).toHaveLength(2);
  });

  it('平行的墙不会被硬接（没有可靠交点）', () => {
    const walls = [wall(0, 0, 100, 0), wall(130, 0, 230, 0)];
    const out = closeDanglingEnds(walls, { ...opts, scrapMaxMm: 0 });
    expect(out.extended).toBe(0);
    expect(out.walls[0].x2).toBeCloseTo(100, 6);
  });

  it('闭合的矩形原样不动', () => {
    const walls = [
      wall(0, 0, 200, 0),
      wall(200, 0, 200, 200),
      wall(200, 200, 0, 200),
      wall(0, 200, 0, 0),
    ];
    const out = closeDanglingEnds(walls, opts);
    expect(out.extended).toBe(0);
    expect(out.dropped).toHaveLength(0);
    expect(out.danglingAfter).toBe(0);
  });
});

describe('closeDanglingEnds 是域无关的（mm 域也成立）', () => {
  /**
   * M5.2 的 `src/ai/wallRepair.ts` 在 **mm 域**复用同一套判据：坐标是 mm、
   * `strokePx` 传墙厚 mm、`pxPerMm` 传 1。这里验证「同一个几何按 px / mm 两套
   * 单位各跑一遍，结论一致」——把 px 用例整体放大 `1/PX_PER_MM` 倍就是 mm 用例。
   */
  const K = 1 / PX_PER_MM; // px → mm

  it('px 域与 mm 域给出同一个 T 接结果', () => {
    const px = [wall(0, 0, 100, 0), wall(120, -50, 120, 50)];
    const mm = px.map((w) =>
      wall(w.x1 * K, w.y1 * K, w.x2 * K, w.y2 * K, w.thicknessPx * K),
    );

    const outPx = closeDanglingEnds(px, { strokePx: STROKE, pxPerMm: PX_PER_MM });
    const outMm = closeDanglingEnds(mm, { strokePx: STROKE * K, pxPerMm: 1 });

    expect(outPx.extended).toBe(outMm.extended);
    expect(outPx.walls).toHaveLength(outMm.walls.length);
    expect(outMm.walls[0].x2 / K).toBeCloseTo(outPx.walls[0].x2, 6);
    expect(outPx.danglingAfter).toBe(outMm.danglingAfter);
  });

  it('mm 域的碎屑判据同样按 600mm 走', () => {
    // 一段 400mm 的孤立短墙：两端都自由且短于 600mm → 碎屑
    const scrap = [wall(0, 0, 400, 0, 140), wall(5000, 0, 9000, 0, 140)];
    const out = closeDanglingEnds(scrap, { strokePx: 140, pxPerMm: 1 });
    expect(out.dropped).toHaveLength(1);
    expect(out.walls).toHaveLength(1);
  });
});

describe('composeIndexMaps', () => {
  it('两级映射复合，丢掉的一直是 -1', () => {
    // 第一步：3 段里第 1 段被剔除 → [0, -1, 1]
    // 第二步：剩下两段合并成一条 → [0, 0]
    expect(composeIndexMaps([0, -1, 1], [0, 0])).toEqual([0, -1, 0]);
  });

  it('第二级里越界的按丢弃处理', () => {
    expect(composeIndexMaps([0, 5], [0])).toEqual([0, -1]);
  });
});
