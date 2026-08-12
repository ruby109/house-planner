import { describe, expect, it } from 'vitest';
import { ANGLE_SNAP_TOL_DEG as SOLVE_TOL } from '../ai/solve';
import {
  ANGLE_SNAP_TOL_DEG,
  angleDiffDeg,
  dropShortSegments,
  joinTJunctions,
  mergeCollinearSegments,
  planBridges,
  projectOnLine,
  quantizeSegment,
  segAngleDeg,
  segLength,
  segOrient,
  snapEndpoints,
  type PxSegment,
} from './geometry';

const MERGE = { angleTolDeg: 4, offsetTolPx: 3, gapTolPx: 10 };

describe('角度基础', () => {
  it('容差常量与 M3.1 求解器同源', () => {
    expect(ANGLE_SNAP_TOL_DEG).toBe(SOLVE_TOL);
  });

  it('segAngleDeg 归一化到 [0,180)，两个走向同角度', () => {
    expect(segAngleDeg({ x1: 0, y1: 0, x2: 10, y2: 0 })).toBeCloseTo(0);
    expect(segAngleDeg({ x1: 10, y1: 0, x2: 0, y2: 0 })).toBeCloseTo(0);
    expect(segAngleDeg({ x1: 0, y1: 0, x2: 0, y2: 10 })).toBeCloseTo(90);
    expect(segAngleDeg({ x1: 0, y1: 10, x2: 0, y2: 0 })).toBeCloseTo(90);
    expect(segAngleDeg({ x1: 0, y1: 0, x2: 10, y2: 10 })).toBeCloseTo(45);
  });

  it('angleDiffDeg 跨 0/180 不出错', () => {
    expect(angleDiffDeg(1, 179)).toBeCloseTo(2);
    expect(angleDiffDeg(179, 1)).toBeCloseTo(2);
    expect(angleDiffDeg(10, 100)).toBeCloseTo(90);
  });

  it('segOrient 只把 ±10° 内的算轴向', () => {
    expect(segOrient({ x1: 0, y1: 0, x2: 100, y2: 8 })).toBe('h'); // 4.6°
    expect(segOrient({ x1: 0, y1: 0, x2: 100, y2: 30 })).toBe('d'); // 16.7°
    expect(segOrient({ x1: 0, y1: 0, x2: 8, y2: 100 })).toBe('v');
    expect(segOrient({ x1: 0, y1: 0, x2: 100, y2: 100 })).toBe('d');
  });
});

describe('quantizeSegment', () => {
  it('近水平段拉平到 y 均值', () => {
    const q = quantizeSegment({ x1: 0, y1: 10, x2: 100, y2: 14 });
    expect(q.y1).toBe(12);
    expect(q.y2).toBe(12);
    expect(q.x1).toBe(0);
    expect(q.x2).toBe(100);
  });

  it('近垂直段拉直到 x 均值', () => {
    const q = quantizeSegment({ x1: 20, y1: 0, x2: 24, y2: 100 });
    expect(q.x1).toBe(22);
    expect(q.x2).toBe(22);
  });

  it('斜墙原样保留（这是 M3.1 的硬约定）', () => {
    const s: PxSegment = { x1: 0, y1: 0, x2: 100, y2: 70 };
    expect(quantizeSegment(s)).toEqual(s);
    expect(segAngleDeg(quantizeSegment(s))).toBeCloseTo(segAngleDeg(s));
  });

  it('刚好卡在容差上仍然吸附', () => {
    const dy = Math.tan((ANGLE_SNAP_TOL_DEG - 0.5) * (Math.PI / 180)) * 100;
    expect(segOrient({ x1: 0, y1: 0, x2: 100, y2: dy })).toBe('h');
  });
});

describe('mergeCollinearSegments', () => {
  it('把同一条线上的碎段接成一条', () => {
    const out = mergeCollinearSegments(
      [
        { x1: 0, y1: 50, x2: 40, y2: 50 },
        { x1: 45, y1: 51, x2: 90, y2: 51 },
        { x1: 92, y1: 50, x2: 140, y2: 50 },
      ],
      MERGE,
    );
    expect(out).toHaveLength(1);
    expect(segLength(out[0])).toBeGreaterThan(135);
  });

  it('缺口大于容差就分成两段', () => {
    const out = mergeCollinearSegments(
      [
        { x1: 0, y1: 50, x2: 40, y2: 50 },
        { x1: 100, y1: 50, x2: 140, y2: 50 },
      ],
      MERGE,
    );
    expect(out).toHaveLength(2);
  });

  it('平行但不同线的段不会被并在一起', () => {
    const out = mergeCollinearSegments(
      [
        { x1: 0, y1: 10, x2: 100, y2: 10 },
        { x1: 0, y1: 60, x2: 100, y2: 60 },
      ],
      MERGE,
    );
    expect(out).toHaveLength(2);
  });

  it('角度差太大不合并', () => {
    const out = mergeCollinearSegments(
      [
        { x1: 0, y1: 0, x2: 100, y2: 0 },
        { x1: 0, y1: 0, x2: 0, y2: 100 },
      ],
      MERGE,
    );
    expect(out).toHaveLength(2);
  });

  it('合并后的斜段保住原角度', () => {
    const out = mergeCollinearSegments(
      [
        { x1: 0, y1: 0, x2: 50, y2: 50 },
        { x1: 52, y1: 52, x2: 100, y2: 100 },
      ],
      MERGE,
    );
    expect(out).toHaveLength(1);
    expect(segAngleDeg(out[0])).toBeCloseTo(45, 1);
  });

  it('结果按长度降序', () => {
    const out = mergeCollinearSegments(
      [
        { x1: 0, y1: 0, x2: 20, y2: 0 },
        { x1: 0, y1: 40, x2: 200, y2: 40 },
      ],
      MERGE,
    );
    expect(segLength(out[0])).toBeGreaterThan(segLength(out[1]));
  });
});

describe('snapEndpoints', () => {
  it('把差一点的直角角点拉到交点上，且两条墙都不歪', () => {
    const out = snapEndpoints(
      [
        { x1: 0, y1: 0, x2: 100, y2: 0 },
        { x1: 103, y1: 2, x2: 103, y2: 80 },
      ],
      8,
    );
    // 水平段仍然严格水平、垂直段仍然严格垂直
    expect(out[0].y1).toBeCloseTo(out[0].y2);
    expect(out[1].x1).toBeCloseTo(out[1].x2);
    // 端点重合了
    expect(Math.hypot(out[0].x2 - out[1].x1, out[0].y2 - out[1].y1)).toBeLessThan(1e-6);
  });

  it('离得远的端点不动', () => {
    const input: PxSegment[] = [
      { x1: 0, y1: 0, x2: 100, y2: 0 },
      { x1: 300, y1: 0, x2: 300, y2: 80 },
    ];
    expect(snapEndpoints(input, 8)).toEqual(input);
  });

  it('不改变任何线段的角度', () => {
    const input: PxSegment[] = [
      { x1: 0, y1: 0, x2: 100, y2: 60 },
      { x1: 102, y1: 62, x2: 102, y2: 160 },
    ];
    const out = snapEndpoints(input, 8);
    expect(segAngleDeg(out[0])).toBeCloseTo(segAngleDeg(input[0]), 6);
    expect(segAngleDeg(out[1])).toBeCloseTo(segAngleDeg(input[1]), 6);
  });
});

describe('joinTJunctions', () => {
  it('把没画到头的隔墙延长到主墙上', () => {
    const out = joinTJunctions(
      [
        { x1: 0, y1: 0, x2: 200, y2: 0 },
        { x1: 100, y1: 6, x2: 100, y2: 90 },
      ],
      10,
    );
    expect(out[1].y1).toBeCloseTo(0);
    expect(out[1].x1).toBeCloseTo(100);
    expect(out[1].x2).toBeCloseTo(100); // 还是垂直的
  });

  it('近乎平行的两条线不当 T 接点处理', () => {
    const input: PxSegment[] = [
      { x1: 0, y1: 0, x2: 200, y2: 0 },
      { x1: 100, y1: 5, x2: 300, y2: 5 },
    ];
    expect(joinTJunctions(input, 10)).toEqual(input);
  });
});

describe('dropShortSegments', () => {
  it('按长度过滤', () => {
    const out = dropShortSegments(
      [
        { x1: 0, y1: 0, x2: 5, y2: 0 },
        { x1: 0, y1: 0, x2: 50, y2: 0 },
      ],
      10,
    );
    expect(out).toHaveLength(1);
    expect(segLength(out[0])).toBe(50);
  });
});

describe('projectOnLine', () => {
  it('投到线段所在的无限直线上', () => {
    const p = projectOnLine({ x: 50, y: 30 }, { x1: 0, y1: 0, x2: 10, y2: 0 });
    expect(p.x).toBeCloseTo(50);
    expect(p.y).toBeCloseTo(0);
  });
});

describe('planBridges', () => {
  const wall = (x1: number, y1: number, x2: number, y2: number): PxSegment & { thicknessPx: number } => ({
    x1,
    y1,
    x2,
    y2,
    thicknessPx: 4,
  });

  it('共线的门洞缺口会被架桥补上', () => {
    const bridges = planBridges([wall(0, 0, 100, 0), wall(160, 0, 300, 0)], 100, 4);
    expect(bridges.length).toBeGreaterThanOrEqual(1);
    const b = bridges[0];
    expect(Math.min(b.x1, b.x2)).toBeCloseTo(100);
    expect(Math.max(b.x1, b.x2)).toBeCloseTo(160);
  });

  it('缺口超过一个门宽就不补（那是房间开口，不是门）', () => {
    const bridges = planBridges([wall(0, 0, 100, 0), wall(400, 0, 500, 0)], 100, 4);
    expect(bridges.filter((b) => Math.abs(b.x1 - b.x2) > 200)).toHaveLength(0);
  });

  it('悬空端点会沿自身方向延长到撞上的墙', () => {
    const bridges = planBridges([wall(0, 0, 200, 0), wall(100, 40, 100, 200)], 100, 4);
    const up = bridges.find((b) => Math.abs(b.x1 - 100) < 1 && Math.abs(b.x2 - 100) < 1);
    expect(up).toBeDefined();
    expect(Math.min(up!.y1, up!.y2)).toBeCloseTo(0);
  });

  it('已经接上的端点不重复补线', () => {
    const bridges = planBridges([wall(0, 0, 200, 0), wall(100, 0, 100, 200)], 100, 4);
    expect(bridges).toHaveLength(0);
  });
});
