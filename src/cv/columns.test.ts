/**
 * M5 柱候选的单测（见 docs/CV-PIPELINE.md 第 7 节）。
 */
import { describe, expect, it } from 'vitest';
import { COLUMN_MIN_DENSITY, isColumnShape, pickColumns } from './columns';
import type { ComponentStat } from './strokeStats';
import type { CvWall, TextBox } from './types';

function comp(w: number, h: number, density: number, label = 1): ComponentStat {
  return { label, x: 0, y: 0, w, h, area: Math.round(w * h * density), density };
}

function wall(x1: number, y1: number, x2: number, y2: number): CvWall {
  return { x1, y1, x2, y2, thicknessPx: 10 };
}

describe('isColumnShape', () => {
  const p = { strokePx: 10 };

  it('接近正方形的实心块 → 是', () => {
    expect(isColumnShape(comp(12, 12, 0.95), p)).toBe(true);
    expect(isColumnShape(comp(14, 12, 0.9), p)).toBe(true);
  });

  it('太扁的不是（长条 = 墙 / 尺寸线）', () => {
    expect(isColumnShape(comp(30, 8, 0.95), p)).toBe(false);
  });

  it('太空的不是（线框 / 汉字的笔画）', () => {
    expect(isColumnShape(comp(12, 12, COLUMN_MIN_DENSITY - 0.1), p)).toBe(false);
  });

  it('边长超出 0.5~2× 笔画宽的不是', () => {
    expect(isColumnShape(comp(4, 4, 0.95), p)).toBe(false); // 太小
    expect(isColumnShape(comp(30, 30, 0.95), p)).toBe(false); // 太大
  });
});

describe('pickColumns', () => {
  const walls = [wall(0, 100, 200, 100)];

  function box(x: number, y: number, size = 10): TextBox {
    return { x, y, w: size, h: size };
  }

  it('贴着墙的留下，离墙远的丢掉', () => {
    const out = pickColumns([box(50, 95), box(50, 10)], walls, { strokePx: 10 });
    expect(out).toHaveLength(1);
    expect(out[0].x).toBe(55);
    expect(out[0].y).toBe(100);
  });

  it('中心重合的重复块只留一个', () => {
    const out = pickColumns([box(50, 95), box(51, 96)], walls, { strokePx: 10 });
    expect(out).toHaveLength(1);
  });

  it('没有墙时一个都不出（贴墙判据无从谈起）', () => {
    expect(pickColumns([box(50, 95)], [], { strokePx: 10 })).toEqual([]);
  });

  it('输出的是中心坐标与边长', () => {
    const out = pickColumns([{ x: 40, y: 90, w: 12, h: 14 }], walls, { strokePx: 10 });
    expect(out[0]).toEqual({ x: 46, y: 97, wPx: 12, hPx: 14 });
  });
});
