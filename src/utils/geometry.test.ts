import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  clamp,
  constrainOrtho,
  distance,
  pointSegProjection,
  polygonAreaMm2,
  polysIntersectSAT,
  rotatedRectCorners,
  segmentPolygon,
  snap,
  snapPt,
  wallDir,
  wallLen,
  wallNormal,
} from './geometry';

describe('snap', () => {
  it('吸附到 910 模数', () => {
    expect(snap(0, 910)).toBe(0);
    expect(snap(400, 910)).toBe(0);
    expect(snap(500, 910)).toBe(910);
    expect(snap(1000, 910)).toBe(910);
    expect(snap(1400, 910)).toBe(1820);
    expect(snap(-500, 910)).toBe(-910);
  });

  it('吸附到 455 半间', () => {
    expect(snap(200, 455)).toBe(0);
    expect(snap(300, 455)).toBe(455);
    expect(snap(700, 455)).toBe(910);
  });

  it('step <= 1 时退化为取整', () => {
    expect(snap(3.6, 1)).toBe(4);
    expect(snap(3.2, 0)).toBe(3);
    expect(snap(-3.6, 1)).toBe(-4);
  });

  it('结果始终是整数', () => {
    for (const step of [910, 455, 100, 1]) {
      expect(Number.isInteger(snap(1234.567, step))).toBe(true);
    }
  });

  it('非法输入返回 0', () => {
    expect(snap(NaN, 455)).toBe(0);
  });

  it('snapPt 逐分量吸附', () => {
    expect(snapPt({ x: 500, y: 1400 }, 910)).toEqual({ x: 910, y: 1820 });
  });
});

describe('distance / wallDir / wallLen / wallNormal', () => {
  it('distance', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('wallLen', () => {
    expect(wallLen({ start: { x: 0, y: 0 }, end: { x: 0, y: 3640 } })).toBe(3640);
  });

  it('wallDir 返回单位向量', () => {
    expect(wallDir({ start: { x: 0, y: 0 }, end: { x: 0, y: 3640 } })).toEqual({ x: 0, y: 1 });
    const d = wallDir({ start: { x: 0, y: 0 }, end: { x: 3, y: 4 } });
    expect(d.x).toBeCloseTo(0.6, 10);
    expect(d.y).toBeCloseTo(0.8, 10);
  });

  it('零长度墙方向为零向量', () => {
    expect(wallDir({ start: { x: 10, y: 10 }, end: { x: 10, y: 10 } })).toEqual({ x: 0, y: 0 });
  });

  it('wallNormal 与方向垂直', () => {
    const seg = { start: { x: 0, y: 0 }, end: { x: 910, y: 455 } };
    const d = wallDir(seg);
    const n = wallNormal(seg);
    expect(d.x * n.x + d.y * n.y).toBeCloseTo(0, 10);
  });
});

describe('pointSegProjection', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 1000, y: 0 };

  it('投影在线段内', () => {
    const r = pointSegProjection({ x: 500, y: 300 }, a, b);
    expect(r.point).toEqual({ x: 500, y: 0 });
    expect(r.t).toBeCloseTo(0.5, 10);
    expect(r.along).toBeCloseTo(500, 10);
    expect(r.distance).toBeCloseTo(300, 10);
  });

  it('超出端点时 clamp', () => {
    const before = pointSegProjection({ x: -400, y: 0 }, a, b);
    expect(before.t).toBe(0);
    expect(before.point).toEqual({ x: 0, y: 0 });
    expect(before.distance).toBeCloseTo(400, 10);

    const after = pointSegProjection({ x: 1400, y: 0 }, a, b);
    expect(after.t).toBe(1);
    expect(after.point).toEqual({ x: 1000, y: 0 });
  });

  it('退化线段返回起点', () => {
    const r = pointSegProjection({ x: 3, y: 4 }, a, a);
    expect(r.point).toEqual({ x: 0, y: 0 });
    expect(r.t).toBe(0);
    expect(r.distance).toBe(5);
  });
});

describe('constrainOrtho', () => {
  const from = { x: 0, y: 0 };

  it('水平位移较大时锁水平', () => {
    expect(constrainOrtho(from, { x: 1000, y: 200 })).toEqual({ x: 1000, y: 0 });
  });

  it('垂直位移较大时锁垂直', () => {
    expect(constrainOrtho(from, { x: 200, y: 1000 })).toEqual({ x: 0, y: 1000 });
  });

  it('free 时原样返回', () => {
    expect(constrainOrtho(from, { x: 200, y: 1000 }, true)).toEqual({ x: 200, y: 1000 });
  });
});

describe('rotatedRectCorners', () => {
  it('未旋转时按 左上→右上→右下→左下 输出', () => {
    expect(rotatedRectCorners({ x: 0, y: 0 }, 2000, 1000, 0)).toEqual([
      { x: -1000, y: -500 },
      { x: 1000, y: -500 },
      { x: 1000, y: 500 },
      { x: -1000, y: 500 },
    ]);
  });

  it('旋转 90 度后长宽互换', () => {
    const c = rotatedRectCorners({ x: 0, y: 0 }, 2000, 1000, 90);
    const b = boundsOf(c)!;
    expect(b.maxX - b.minX).toBeCloseTo(1000, 6);
    expect(b.maxY - b.minY).toBeCloseTo(2000, 6);
  });

  it('保持中心不变', () => {
    const center = { x: 1820, y: 910 };
    const c = rotatedRectCorners(center, 970, 1950, 37);
    const cx = c.reduce((s, p) => s + p.x, 0) / 4;
    const cy = c.reduce((s, p) => s + p.y, 0) / 4;
    expect(cx).toBeCloseTo(center.x, 6);
    expect(cy).toBeCloseTo(center.y, 6);
  });

  it('面积与 w×d 一致', () => {
    expect(polygonAreaMm2(rotatedRectCorners({ x: 5, y: 7 }, 970, 1950, 23))).toBeCloseTo(
      970 * 1950,
      3,
    );
  });
});

describe('segmentPolygon', () => {
  it('水平线段扩成矩形', () => {
    const poly = segmentPolygon({ x: 0, y: 0 }, { x: 1000, y: 0 }, 100);
    expect(polygonAreaMm2(poly)).toBeCloseTo(1000 * 100, 6);
    const b = boundsOf(poly)!;
    expect(b.minY).toBeCloseTo(-50, 6);
    expect(b.maxY).toBeCloseTo(50, 6);
  });
});

describe('polysIntersectSAT', () => {
  const rect = (cx: number, cy: number, w: number, d: number, deg = 0) =>
    rotatedRectCorners({ x: cx, y: cy }, w, d, deg);

  it('重叠 → true', () => {
    expect(polysIntersectSAT(rect(0, 0, 1000, 1000), rect(500, 500, 1000, 1000))).toBe(true);
  });

  it('包含 → true', () => {
    expect(polysIntersectSAT(rect(0, 0, 2000, 2000), rect(0, 0, 500, 500))).toBe(true);
  });

  it('分离 → false', () => {
    expect(polysIntersectSAT(rect(0, 0, 1000, 1000), rect(2000, 0, 1000, 1000))).toBe(false);
  });

  it('恰好相接（紧靠摆放）→ false', () => {
    expect(polysIntersectSAT(rect(0, 0, 1000, 1000), rect(1000, 0, 1000, 1000))).toBe(false);
  });

  it('旋转后相交可被检出', () => {
    expect(polysIntersectSAT(rect(0, 0, 1000, 200), rect(0, 0, 200, 1000, 0))).toBe(true);
    expect(polysIntersectSAT(rect(0, 0, 1400, 100), rect(600, 0, 100, 1400, 45))).toBe(true);
    // 同一根斜置长条挪远后不再相交
    expect(polysIntersectSAT(rect(0, 0, 1400, 100), rect(2400, 0, 100, 1400, 45))).toBe(false);
  });

  it('退化多边形 → false', () => {
    expect(polysIntersectSAT([{ x: 0, y: 0 }], rect(0, 0, 100, 100))).toBe(false);
  });
});

describe('polygonAreaMm2', () => {
  it('一帖（910×1820）', () => {
    expect(
      polygonAreaMm2([
        { x: 0, y: 0 },
        { x: 910, y: 0 },
        { x: 910, y: 1820 },
        { x: 0, y: 1820 },
      ]),
    ).toBe(910 * 1820);
  });

  it('与绕向无关', () => {
    const poly = [
      { x: 0, y: 0 },
      { x: 910, y: 0 },
      { x: 910, y: 1820 },
      { x: 0, y: 1820 },
    ];
    expect(polygonAreaMm2([...poly].reverse())).toBe(polygonAreaMm2(poly));
  });

  it('L 形房间', () => {
    // 3640×3640 的正方形挖掉右下 1820×1820
    expect(
      polygonAreaMm2([
        { x: 0, y: 0 },
        { x: 3640, y: 0 },
        { x: 3640, y: 1820 },
        { x: 1820, y: 1820 },
        { x: 1820, y: 3640 },
        { x: 0, y: 3640 },
      ]),
    ).toBe(3640 * 3640 - 1820 * 1820);
  });

  it('少于 3 点返回 0', () => {
    expect(polygonAreaMm2([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(0);
  });
});

describe('boundsOf / clamp', () => {
  it('boundsOf', () => {
    expect(
      boundsOf([
        { x: -100, y: 50 },
        { x: 200, y: -30 },
      ]),
    ).toEqual({ minX: -100, minY: -30, maxX: 200, maxY: 50 });
  });

  it('空集合返回 null', () => {
    expect(boundsOf([])).toBeNull();
  });

  it('clamp', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
  });
});
