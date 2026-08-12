import { describe, expect, it } from 'vitest';
import {
  findLoopAt,
  pointInPolygon,
  signedAreaMm2,
  simplifyRing,
  wallLoops,
} from './roomDetect';
import { polygonAreaMm2 } from './geometry';
import { formatArea, formatTatami, mm2ToTatami } from './units';
import type { Pt } from '../model/types';

/** 用 (x,y) 列表拼一圈闭合墙 */
function ring(pts: Pt[]): { start: Pt; end: Pt }[] {
  return pts.map((p, i) => ({ start: p, end: pts[(i + 1) % pts.length] }));
}

const square = (x: number, y: number, w: number, h: number): Pt[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

describe('signedAreaMm2 / simplifyRing', () => {
  it('鞋带公式：屏幕 y 向下时，按 右→下→左→上 的环为正', () => {
    expect(signedAreaMm2(square(0, 0, 100, 100))).toBe(10_000);
    expect(signedAreaMm2(square(0, 0, 100, 100).reverse())).toBe(-10_000);
  });

  it('去掉共线顶点与重复顶点', () => {
    const r = simplifyRing([
      { x: 0, y: 0 },
      { x: 50, y: 0 }, // 共线
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 100, y: 100 }, // 重复
      { x: 0, y: 100 },
    ]);
    expect(r).toHaveLength(4);
    expect(polygonAreaMm2(r)).toBe(10_000);
  });

  it('去掉原路折返的悬挂枝', () => {
    const r = simplifyRing([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: -80 }, // 伸出去
      { x: 100, y: 0 }, // 又原路回来
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ]);
    expect(r).toHaveLength(4);
    expect(polygonAreaMm2(r)).toBe(10_000);
  });
});

describe('pointInPolygon', () => {
  const poly = square(0, 0, 910, 910);
  it('内部为真、外部为假', () => {
    expect(pointInPolygon({ x: 455, y: 455 }, poly)).toBe(true);
    expect(pointInPolygon({ x: -10, y: 455 }, poly)).toBe(false);
    expect(pointInPolygon({ x: 455, y: 2000 }, poly)).toBe(false);
  });
  it('凹多边形（L 形）', () => {
    const l: Pt[] = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 100, y: 100 },
      { x: 100, y: 200 },
      { x: 0, y: 200 },
    ];
    expect(pointInPolygon({ x: 50, y: 150 }, l)).toBe(true);
    expect(pointInPolygon({ x: 150, y: 150 }, l)).toBe(false);
  });
});

describe('wallLoops', () => {
  it('单个矩形房间：只出 1 个内部面，面积正确', () => {
    const loops = wallLoops(ring(square(0, 0, 3640, 2730)));
    expect(loops).toHaveLength(1);
    expect(loops[0].areaMm2).toBe(3640 * 2730);
    expect(loops[0].polygon).toHaveLength(4);
  });

  it('顶点顺序反过来画也一样（外轮廓不会被当成房间）', () => {
    const loops = wallLoops(ring(square(0, 0, 3640, 2730).reverse()));
    expect(loops).toHaveLength(1);
    expect(loops[0].areaMm2).toBe(3640 * 2730);
  });

  it('中间加一道隔墙 → 两个房间', () => {
    const walls = [
      ...ring(square(0, 0, 3640, 1820)),
      // 竖向隔墙，端点落在上下外墙的内部（T 型接点）
      { start: { x: 1820, y: 0 }, end: { x: 1820, y: 1820 } },
    ];
    const loops = wallLoops(walls);
    expect(loops).toHaveLength(2);
    expect(loops.map((l) => l.areaMm2)).toEqual([1820 * 1820, 1820 * 1820]);
  });

  it('隔墙不到顶（有缺口）→ 仍是一个大房间', () => {
    const walls = [
      ...ring(square(0, 0, 3640, 1820)),
      { start: { x: 1820, y: 0 }, end: { x: 1820, y: 1000 } },
    ];
    const loops = wallLoops(walls);
    expect(loops).toHaveLength(1);
    expect(loops[0].areaMm2).toBe(3640 * 1820);
    // 悬挂的隔墙被 simplifyRing 消掉，轮廓仍是 4 个角
    expect(loops[0].polygon).toHaveLength(4);
  });

  it('墙不闭合（缺一条边）→ 没有房间', () => {
    const walls = ring(square(0, 0, 3640, 1820)).slice(0, 3);
    expect(wallLoops(walls)).toEqual([]);
  });

  it('十字交叉的四段长墙 → 中间切出 4 个格子', () => {
    const walls = [
      ...ring(square(0, 0, 1820, 1820)),
      // 两条穿过整个矩形的墙，交点需要被打断
      { start: { x: 910, y: 0 }, end: { x: 910, y: 1820 } },
      { start: { x: 0, y: 910 }, end: { x: 1820, y: 910 } },
    ];
    const loops = wallLoops(walls);
    expect(loops).toHaveLength(4);
    for (const l of loops) expect(l.areaMm2).toBe(910 * 910);
  });

  it('L 形房间（6 条墙）', () => {
    const pts: Pt[] = [
      { x: 0, y: 0 },
      { x: 3640, y: 0 },
      { x: 3640, y: 1820 },
      { x: 1820, y: 1820 },
      { x: 1820, y: 3640 },
      { x: 0, y: 3640 },
    ];
    const loops = wallLoops(ring(pts));
    expect(loops).toHaveLength(1);
    expect(loops[0].polygon).toHaveLength(6);
    expect(loops[0].areaMm2).toBe(polygonAreaMm2(pts));
  });

  it('两个互不相连的矩形 → 两个房间', () => {
    const loops = wallLoops([...ring(square(0, 0, 910, 910)), ...ring(square(5000, 0, 1820, 910))]);
    expect(loops).toHaveLength(2);
    expect(loops.map((l) => l.areaMm2)).toEqual([910 * 910, 1820 * 910]);
  });
});

describe('findLoopAt', () => {
  const walls = [
    ...ring(square(0, 0, 3640, 1820)),
    { start: { x: 1820, y: 0 }, end: { x: 1820, y: 1820 } },
  ];

  it('命中点所在的那一间', () => {
    const left = findLoopAt(walls, { x: 900, y: 900 });
    expect(left?.polygon.map((p) => p.x).sort((a, b) => a - b)).toEqual([0, 0, 1820, 1820]);
    const right = findLoopAt(walls, { x: 2700, y: 900 });
    expect(right?.polygon.map((p) => p.x).sort((a, b) => a - b)).toEqual([
      1820, 1820, 3640, 3640,
    ]);
  });

  it('点在墙外返回 null', () => {
    expect(findLoopAt(walls, { x: -500, y: 900 })).toBeNull();
    expect(findLoopAt([], { x: 0, y: 0 })).toBeNull();
  });

  it('嵌套时取最小的那一个', () => {
    const nested = [...ring(square(0, 0, 9100, 9100)), ...ring(square(1000, 1000, 1820, 1820))];
    const hit = findLoopAt(nested, { x: 1500, y: 1500 });
    expect(hit?.areaMm2).toBe(1820 * 1820);
  });
});

describe('房间面积的畳数显示', () => {
  it('按 910 模数画出的 6 帖（2730×3640）正好是 6.0 帖', () => {
    const loops = wallLoops(ring(square(0, 0, 2730, 3640)));
    expect(loops).toHaveLength(1);
    expect(mm2ToTatami(loops[0].areaMm2)).toBeCloseTo(6, 10);
    expect(formatTatami(loops[0].areaMm2)).toBe('6.0 帖');
    expect(formatArea(loops[0].areaMm2, 'metric')).toBe('9.94 ㎡');
  });

  it('4.5 帖（2730×2730）', () => {
    const loops = wallLoops(ring(square(0, 0, 2730, 2730)));
    expect(formatTatami(loops[0].areaMm2)).toBe('4.5 帖');
  });
});
