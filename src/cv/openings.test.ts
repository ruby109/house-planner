/**
 * M5 洞口候选的单测（见 docs/CV-PIPELINE.md 第 7 节）。
 *
 * 全是手搓的小场景，每条断言都能在纸上画出来。
 */
import { describe, expect, it } from 'vitest';
import type { PxBridge } from './geometry';
import { planBridges } from './geometry';
import { buildOpenings, isExteriorGap, pointInPolygon, wallBounds } from './openings';
import type { CvRoom, CvWall } from './types';

function wall(x1: number, y1: number, x2: number, y2: number, thicknessPx = 4): CvWall {
  return { x1, y1, x2, y2, thicknessPx };
}

function bridge(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  kind: 'gap' | 'ray' = 'gap',
  a = 0,
  b = 1,
): PxBridge {
  return { x1, y1, x2, y2, kind, a, b };
}

function rect(x0: number, y0: number, x1: number, y1: number): CvRoom {
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

describe('pointInPolygon', () => {
  it('内部为真、外部为假', () => {
    const poly = rect(0, 0, 10, 10).polygon;
    expect(pointInPolygon({ x: 5, y: 5 }, poly)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, poly)).toBe(false);
  });
});

describe('wallBounds', () => {
  it('取所有端点的包围盒', () => {
    expect(wallBounds([wall(10, 20, 50, 20), wall(50, 20, 50, 80)])).toEqual({
      x0: 10,
      y0: 20,
      x1: 50,
      y1: 80,
    });
  });

  it('没有墙时返回 null', () => {
    expect(wallBounds([])).toBeNull();
  });
});

describe('isExteriorGap', () => {
  const bounds = { x0: 0, y0: 0, x1: 100, y1: 100 };

  it('贴着图纸外轮廓 → 外墙', () => {
    // y=0 这条边上的缺口
    expect(isExteriorGap({ x1: 40, y1: 0, x2: 60, y2: 0 }, [], 5, bounds, 6)).toBe(true);
  });

  it('房间中间的缺口，两侧都在房间里 → 内墙', () => {
    const rooms = [rect(5, 5, 50, 95), rect(50, 5, 95, 95)];
    // x=50 的竖墙上开个口，法向两侧分别落在两个房间里
    expect(isExteriorGap({ x1: 50, y1: 40, x2: 50, y2: 60 }, rooms, 8, bounds, 6)).toBe(false);
  });

  it('一侧是 CV 没分出来的小间（不在任何房间里）→ 仍判内墙', () => {
    // 只有左边一块房间；右边是提不出轮廓的洗面所。门比窗多，判错要选代价小的一边。
    const rooms = [rect(5, 5, 50, 95)];
    expect(isExteriorGap({ x1: 50, y1: 40, x2: 50, y2: 60 }, rooms, 8, bounds, 6)).toBe(false);
  });

  it('两侧都不在任何房间里 → 外墙', () => {
    const rooms = [rect(5, 5, 20, 20)];
    expect(isExteriorGap({ x1: 50, y1: 40, x2: 50, y2: 60 }, rooms, 8, bounds, 6)).toBe(true);
  });

  it('没有房间信息时一律外墙', () => {
    expect(isExteriorGap({ x1: 50, y1: 40, x2: 50, y2: 60 }, [], 8, null, 6)).toBe(true);
  });
});

describe('buildOpenings', () => {
  const walls = [wall(0, 0, 100, 0), wall(0, 50, 100, 50)];

  it('只收共线缺口，射线补线不算洞口', () => {
    const out = buildOpenings(
      [bridge(40, 50, 60, 50, 'gap'), bridge(20, 20, 20, 50, 'ray')],
      walls,
      { strokePx: 4 },
    );
    expect(out).toHaveLength(1);
    expect(out[0].x1).toBe(40);
    expect(out[0].x2).toBe(60);
  });

  it('归属墙取两侧更长的那一条', () => {
    const mixed = [wall(0, 0, 10, 0), wall(20, 0, 100, 0)];
    const out = buildOpenings([bridge(10, 0, 20, 0, 'gap', 0, 1)], mixed, { strokePx: 4 });
    expect(out[0].onWallIndex).toBe(1);
  });

  it('同一个口子出现两次时只保留一条', () => {
    const out = buildOpenings(
      [bridge(40, 50, 60, 50, 'gap', 0, 1), bridge(40.5, 50, 60.5, 50, 'gap', 0, 1)],
      walls,
      { strokePx: 4 },
    );
    expect(out).toHaveLength(1);
  });

  it('落在柱上的缺口丢掉（柱把墙断开了，不是洞口）', () => {
    const out = buildOpenings([bridge(40, 50, 60, 50, 'gap')], walls, {
      strokePx: 4,
      columns: [{ x: 50, y: 50, wPx: 20, hPx: 20 }],
    });
    expect(out).toHaveLength(0);
  });

  it('太短的缺口丢掉', () => {
    const out = buildOpenings([bridge(50, 50, 50.5, 50, 'gap')], walls, { strokePx: 8 });
    expect(out).toHaveLength(0);
  });

  it('按长度降序返回', () => {
    const out = buildOpenings(
      [bridge(10, 50, 20, 50, 'gap'), bridge(40, 50, 80, 50, 'gap')],
      walls,
      { strokePx: 2 },
    );
    expect(out[0].x2 - out[0].x1).toBe(40);
    expect(out[1].x2 - out[1].x1).toBe(10);
  });

  it('端到端：planBridges 的门洞会变成一个洞口候选', () => {
    // 一道被门洞切开的横墙 + 上下两块房间
    const gapped = [wall(0, 50, 40, 50), wall(60, 50, 100, 50)];
    const bridges = planBridges(gapped, 40, 4);
    const gaps = bridges.filter((b) => b.kind === 'gap');
    expect(gaps.length).toBeGreaterThan(0);

    const out = buildOpenings(bridges, gapped, {
      strokePx: 4,
      rooms: [rect(0, 0, 100, 50), rect(0, 50, 100, 100)],
    });
    expect(out).toHaveLength(1);
    expect(Math.hypot(out[0].x2 - out[0].x1, out[0].y2 - out[0].y1)).toBeCloseTo(20, 5);
  });
});
