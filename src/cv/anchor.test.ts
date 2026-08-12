/**
 * M5 标签锚点的单测。
 *
 * 这里唯一真正要守住的是：**锚点必须落在多边形内部**。
 * 一旦圆标画到隔壁房间头上，AI 就会把两个房间的语义答反，
 * 而 M5 的语义挂载完全靠编号，没有第二道防线。
 */
import { describe, expect, it } from 'vitest';
import { pointInPoly, polyBounds, polyCentroid, roomLabelAnchor } from './anchor';
import type { PxPoint } from './types';

const RECT: PxPoint[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 60 },
  { x: 0, y: 60 },
];

/** L 形：重心落在内凹口（房间外面） */
const L_SHAPE: PxPoint[] = [
  { x: 0, y: 0 },
  { x: 30, y: 0 },
  { x: 30, y: 70 },
  { x: 100, y: 70 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

describe('polyBounds', () => {
  it('矩形的包围盒就是它自己', () => {
    expect(polyBounds(RECT)).toEqual({ x0: 0, y0: 0, x1: 100, y1: 60 });
  });
});

describe('roomLabelAnchor', () => {
  it('矩形：锚点就是重心', () => {
    const a = roomLabelAnchor(RECT);
    expect(a.x).toBeCloseTo(50, 6);
    expect(a.y).toBeCloseTo(30, 6);
    expect(a.spanPx).toBeCloseTo(100, 6);
  });

  it('L 形：重心在外面，锚点仍然落在内部', () => {
    const centroid = polyCentroid(L_SHAPE);
    expect(pointInPoly(centroid, L_SHAPE)).toBe(false);

    const a = roomLabelAnchor(L_SHAPE);
    expect(pointInPoly(a, L_SHAPE)).toBe(true);
    // 最宽的一横排在 y > 70 的那一段，宽度 100
    expect(a.spanPx).toBeCloseTo(100, 6);
    expect(a.y).toBeGreaterThan(70);
  });

  it('细长走廊：spanPx 反映它有多窄（调用方据此收缩圆标）', () => {
    const corridor: PxPoint[] = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 12 },
      { x: 0, y: 12 },
    ];
    expect(roomLabelAnchor(corridor).spanPx).toBeCloseTo(200, 6);
  });

  it('退化多边形不炸', () => {
    const a = roomLabelAnchor([{ x: 5, y: 5 }, { x: 9, y: 9 }]);
    expect(Number.isFinite(a.x)).toBe(true);
    expect(Number.isFinite(a.y)).toBe(true);
  });
});
