import { describe, expect, it } from 'vitest';
import type { Opening, Wall } from '../model/types';
import {
  arcPoints,
  clampOpeningOffset,
  computeOpeningCandidate,
  constrainWallEnd,
  doorSwingGeometry,
  hasOpeningConflict,
  isZeroLengthSegment,
  nearestWall,
  OPENING_ATTACH_DISTANCE,
  OPENING_DEFAULT_WIDTH,
  openingFits,
  openingSpan,
  openingsOverlap,
  pointAlongWall,
  readableAngleDeg,
  wallAngleDeg,
} from './wallGeometry';

// ---------------------------------------------------------------------------
// 画墙：正交约束
// ---------------------------------------------------------------------------

describe('constrainWallEnd', () => {
  const from = { x: 0, y: 0 };

  it('dx 更大时锁水平（y 取起点）', () => {
    expect(constrainWallEnd(from, { x: 1820, y: 300 })).toEqual({ x: 1820, y: 0 });
    expect(constrainWallEnd(from, { x: -1820, y: 300 })).toEqual({ x: -1820, y: 0 });
  });

  it('dy 更大时锁垂直（x 取起点）', () => {
    expect(constrainWallEnd(from, { x: 300, y: 1820 })).toEqual({ x: 0, y: 1820 });
    expect(constrainWallEnd(from, { x: 300, y: -1820 })).toEqual({ x: 0, y: -1820 });
  });

  it('dx === dy 时取水平（并列时优先 x 轴）', () => {
    expect(constrainWallEnd(from, { x: 910, y: 910 })).toEqual({ x: 910, y: 0 });
  });

  it('free（Shift）时保留自由角度', () => {
    expect(constrainWallEnd(from, { x: 910, y: 455 }, true)).toEqual({ x: 910, y: 455 });
  });

  it('相对非原点起点同样成立', () => {
    expect(constrainWallEnd({ x: 910, y: 455 }, { x: 2730, y: 900 })).toEqual({ x: 2730, y: 455 });
    expect(constrainWallEnd({ x: 910, y: 455 }, { x: 1000, y: 2730 })).toEqual({ x: 910, y: 2730 });
  });

  it('结果一定是整数 mm', () => {
    const p = constrainWallEnd({ x: 0, y: 0 }, { x: 100.4, y: 100.6 }, true);
    expect(Number.isInteger(p.x)).toBe(true);
    expect(Number.isInteger(p.y)).toBe(true);
    expect(p).toEqual({ x: 100, y: 101 });
  });
});

describe('isZeroLengthSegment', () => {
  it('同点为零长度', () => {
    expect(isZeroLengthSegment({ x: 910, y: 0 }, { x: 910, y: 0 })).toBe(true);
  });
  it('不同点不是零长度', () => {
    expect(isZeroLengthSegment({ x: 910, y: 0 }, { x: 910, y: 1 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 开口：clamp
// ---------------------------------------------------------------------------

describe('openingFits / clampOpeningOffset', () => {
  it('墙比洞口短时判定放不下', () => {
    expect(openingFits(1690, 910)).toBe(false);
    expect(openingFits(910, 910)).toBe(true);
    expect(openingFits(780, 3640)).toBe(true);
  });

  it('把中心 clamp 到 [w/2, L-w/2]，保证洞口完全落在墙内', () => {
    // L=3640, w=780 → [390, 3250]
    expect(clampOpeningOffset(0, 780, 3640)).toBe(390);
    expect(clampOpeningOffset(100, 780, 3640)).toBe(390);
    expect(clampOpeningOffset(1820, 780, 3640)).toBe(1820);
    expect(clampOpeningOffset(3640, 780, 3640)).toBe(3250);
    expect(clampOpeningOffset(99999, 780, 3640)).toBe(3250);
  });

  it('clamp 后洞口两端都在墙段内', () => {
    const L = 2730;
    const w = 1690;
    for (const raw of [-500, 0, 400, 1365, 2600, 5000]) {
      const off = clampOpeningOffset(raw, w, L);
      const span = openingSpan(off, w);
      expect(span.from).toBeGreaterThanOrEqual(0);
      expect(span.to).toBeLessThanOrEqual(L);
    }
  });

  it('墙放不下时退化为墙中点', () => {
    expect(clampOpeningOffset(0, 1690, 910)).toBe(455);
    expect(clampOpeningOffset(9999, 1690, 910)).toBe(455);
  });

  it('结果是整数', () => {
    expect(Number.isInteger(clampOpeningOffset(0, 781, 3000))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 开口：重叠
// ---------------------------------------------------------------------------

describe('openingsOverlap', () => {
  it('中心距小于半宽之和 → 重叠', () => {
    expect(openingsOverlap(1000, 800, 1200, 800)).toBe(true);
    expect(openingsOverlap(1000, 800, 1000, 800)).toBe(true);
  });

  it('恰好首尾相接不算重叠', () => {
    expect(openingsOverlap(1000, 800, 1800, 800)).toBe(false);
  });

  it('完全分离不重叠', () => {
    expect(openingsOverlap(1000, 800, 3000, 800)).toBe(false);
  });

  it('与顺序无关', () => {
    expect(openingsOverlap(3000, 800, 1000, 800)).toBe(false);
    expect(openingsOverlap(1200, 800, 1000, 800)).toBe(true);
  });
});

describe('hasOpeningConflict', () => {
  const openings: Opening[] = [
    { id: 'o_1', wallId: 'w_1', type: 'door', offset: 1000, width: 780 },
    { id: 'o_2', wallId: 'w_2', type: 'window', offset: 1000, width: 1690 },
  ];

  it('只和同一面墙上的开口比较', () => {
    expect(hasOpeningConflict(openings, 'w_1', 1000, 780)).toBe(true);
    expect(hasOpeningConflict(openings, 'w_3', 1000, 780)).toBe(false);
  });

  it('错开足够距离不冲突', () => {
    expect(hasOpeningConflict(openings, 'w_1', 1780, 780)).toBe(false);
    expect(hasOpeningConflict(openings, 'w_1', 1700, 780)).toBe(true);
  });

  it('excludeId 忽略自身（拖动已存在的开口）', () => {
    expect(hasOpeningConflict(openings, 'w_1', 1010, 780, 'o_1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 最近墙 / 候选
// ---------------------------------------------------------------------------

const wallH: Wall = { id: 'w_h', start: { x: 0, y: 0 }, end: { x: 3640, y: 0 } };
const wallV: Wall = { id: 'w_v', start: { x: 0, y: 0 }, end: { x: 0, y: 2730 } };
const wallShort: Wall = { id: 'w_s', start: { x: 0, y: 5000 }, end: { x: 500, y: 5000 } };

describe('nearestWall', () => {
  it('返回距离最近的墙及沿墙距离', () => {
    const hit = nearestWall([wallH, wallV], { x: 1820, y: 200 });
    expect(hit?.wall.id).toBe('w_h');
    expect(hit?.along).toBeCloseTo(1820);
    expect(hit?.distance).toBeCloseTo(200);
  });

  it('超出阈值返回 null', () => {
    expect(nearestWall([wallH], { x: 1820, y: OPENING_ATTACH_DISTANCE + 1 })).toBeNull();
    expect(nearestWall([wallH], { x: 1820, y: OPENING_ATTACH_DISTANCE })).not.toBeNull();
  });

  it('忽略零长度墙', () => {
    const degenerate: Wall = { id: 'w_0', start: { x: 10, y: 10 }, end: { x: 10, y: 10 } };
    expect(nearestWall([degenerate], { x: 10, y: 10 })).toBeNull();
  });

  it('空数组返回 null', () => {
    expect(nearestWall([], { x: 0, y: 0 })).toBeNull();
  });
});

describe('pointAlongWall / wallAngleDeg', () => {
  it('沿墙距离换算成世界坐标', () => {
    expect(pointAlongWall(wallH, 910)).toEqual({ x: 910, y: 0 });
    expect(pointAlongWall(wallV, 910)).toEqual({ x: 0, y: 910 });
  });

  it('墙方向角', () => {
    expect(wallAngleDeg(wallH)).toBeCloseTo(0);
    expect(wallAngleDeg(wallV)).toBeCloseTo(90);
    expect(wallAngleDeg({ start: { x: 0, y: 0 }, end: { x: -100, y: 0 } })).toBeCloseTo(180);
  });
});

describe('readableAngleDeg', () => {
  it('归一化到 (-90, 90]，保证文字不倒着显示', () => {
    expect(readableAngleDeg(0)).toBe(0);
    expect(readableAngleDeg(45)).toBe(45);
    expect(readableAngleDeg(90)).toBe(90);
    expect(readableAngleDeg(180)).toBe(0);
    expect(readableAngleDeg(135)).toBe(-45);
    expect(readableAngleDeg(-135)).toBe(45);
    expect(readableAngleDeg(270)).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// 开き戸符号：四种 swing
// ---------------------------------------------------------------------------

describe('doorSwingGeometry', () => {
  const W = 800;
  const half = W / 2;

  /** 把角度化到 [0,360) 便于比较 */
  const norm = (d: number) => ((d % 360) + 360) % 360;
  /** 弧上某角度对应的局部点 */
  const at = (hingeX: number, deg: number) => ({
    x: hingeX + W * Math.cos((deg * Math.PI) / 180),
    y: W * Math.sin((deg * Math.PI) / 180),
  });

  it('铰链位置由 left/right 决定', () => {
    expect(doorSwingGeometry(W, 'in_left').hingeX).toBe(-half);
    expect(doorSwingGeometry(W, 'out_left').hingeX).toBe(-half);
    expect(doorSwingGeometry(W, 'in_right').hingeX).toBe(half);
    expect(doorSwingGeometry(W, 'out_right').hingeX).toBe(half);
  });

  it('开启侧由 in/out 决定（+y = 室内）', () => {
    expect(doorSwingGeometry(W, 'in_left').side).toBe(1);
    expect(doorSwingGeometry(W, 'in_right').side).toBe(1);
    expect(doorSwingGeometry(W, 'out_left').side).toBe(-1);
    expect(doorSwingGeometry(W, 'out_right').side).toBe(-1);
  });

  it('门板端点在铰链正对的开启侧、长度等于洞口宽', () => {
    for (const s of ['in_left', 'in_right', 'out_left', 'out_right'] as const) {
      const g = doorSwingGeometry(W, s);
      expect(g.leafTip.x).toBe(g.hingeX);
      expect(Math.abs(g.leafTip.y)).toBe(W);
      expect(Math.sign(g.leafTip.y)).toBe(g.side);
    }
  });

  it('弧恒为 90°，且两端分别落在门板端点与另一侧门框上', () => {
    for (const s of ['in_left', 'in_right', 'out_left', 'out_right'] as const) {
      const g = doorSwingGeometry(W, s);
      expect(g.arcTo - g.arcFrom).toBe(90);

      const other = { x: -g.hingeX, y: 0 };
      const ends = [at(g.hingeX, g.arcFrom), at(g.hingeX, g.arcTo)];
      // 一端是门板端点，另一端是另一侧门框（顺序取决于旋转方向）
      const hitsTip = ends.some((p) => Math.abs(p.x - g.leafTip.x) < 1e-6 && Math.abs(p.y - g.leafTip.y) < 1e-6);
      const hitsOther = ends.some((p) => Math.abs(p.x - other.x) < 1e-6 && Math.abs(p.y - other.y) < 1e-6);
      expect(hitsTip).toBe(true);
      expect(hitsOther).toBe(true);
    }
  });

  it('四种 swing 的弧起始角互不相同', () => {
    const angles = (['in_left', 'in_right', 'out_left', 'out_right'] as const).map((s) =>
      norm(doorSwingGeometry(W, s).arcFrom),
    );
    expect(new Set(angles).size).toBe(4);
  });

  it('未指定 swing 时按 in_left 处理', () => {
    expect(doorSwingGeometry(W)).toEqual(doorSwingGeometry(W, 'in_left'));
  });
});

describe('arcPoints', () => {
  it('首尾点落在圆弧两端，长度为 steps+1 个点', () => {
    const pts = arcPoints(100, 0, 50, 0, 90, 4);
    expect(pts).toHaveLength((4 + 1) * 2);
    expect(pts[0]).toBeCloseTo(150);
    expect(pts[1]).toBeCloseTo(0);
    expect(pts[pts.length - 2]).toBeCloseTo(100);
    expect(pts[pts.length - 1]).toBeCloseTo(50);
  });
});

describe('computeOpeningCandidate', () => {
  it('命中墙时给出 clamp 后的合法候选', () => {
    const c = computeOpeningCandidate([wallH], [], { x: 0, y: 100 }, OPENING_DEFAULT_WIDTH.door);
    expect(c).not.toBeNull();
    expect(c?.wallId).toBe('w_h');
    expect(c?.width).toBe(780);
    expect(c?.offset).toBe(390); // clamp 到最左合法位置
    expect(c?.valid).toBe(true);
  });

  it('离墙太远返回 null', () => {
    expect(computeOpeningCandidate([wallH], [], { x: 1820, y: 900 }, 780)).toBeNull();
  });

  it('墙比洞口短 → valid=false', () => {
    const c = computeOpeningCandidate([wallShort], [], { x: 250, y: 5000 }, 780);
    expect(c?.valid).toBe(false);
  });

  it('与已有开口重叠 → valid=false', () => {
    const existing: Opening[] = [
      { id: 'o_1', wallId: 'w_h', type: 'door', offset: 1820, width: 780 },
    ];
    const overlap = computeOpeningCandidate([wallH], existing, { x: 1900, y: 0 }, 780);
    expect(overlap?.valid).toBe(false);

    const apart = computeOpeningCandidate([wallH], existing, { x: 3200, y: 0 }, 780);
    expect(apart?.valid).toBe(true);
  });

  it('默认宽度符合规格', () => {
    expect(OPENING_DEFAULT_WIDTH).toEqual({
      door: 780,
      sliding_door: 1690,
      window: 1690,
      opening: 910,
    });
  });
});
