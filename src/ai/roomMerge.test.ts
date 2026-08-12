/**
 * M5.2 单测：假隔断判定 + 栅格拼合（见 docs/CV-PIPELINE.md 第 10 节）。
 *
 * 全部是手搓的 mm 几何，数值都能手算：
 * - 两块 3000×3000 的碎块，中间隔一条 500mm 的墙带，墙心在 x=3250；
 * - 墙厚按 140mm 给，探针起点 = 0.8×140+50 = 162mm，往外每 25mm 一步，最远 910mm。
 */
import { describe, expect, it } from 'vitest';
import { polygonAreaMm2 } from '../utils/geometry';
import type { Pt } from '../model/types';
import { findFakePartitions, rasterMergePolygons, type Seg } from './roomMerge';

const THICKNESS = 140;

function rect(x0: number, y0: number, x1: number, y1: number): Pt[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

/** 左块 / 右块 / 夹在中间那条 500mm 墙带里的墙段 */
const LEFT = rect(0, 0, 3000, 3000);
const RIGHT = rect(3500, 0, 6500, 3000);
const COUNTER: Seg = { x1: 3250, y1: 500, x2: 3250, y2: 2500 };

describe('findFakePartitions', () => {
  it('两侧都是同组碎块 → 判为假隔断，摘掉并扫出桥接带', () => {
    const out = findFakePartitions([COUNTER], [LEFT, RIGHT], [], { thicknessMm: THICKNESS });
    expect(out.blocked).toBe(false);
    expect(out.removed).toEqual([0]);
    expect(out.bridges.length).toBeGreaterThan(0);
    // 桥接带必须真的跨过那条 500mm 的缝
    const xs = out.bridges.flat().map((p) => p.x);
    expect(Math.min(...xs)).toBeLessThan(3000);
    expect(Math.max(...xs)).toBeGreaterThan(3500);
  });

  it('桥接带会沿墙往两头长（CV 只提出中间一小截也能补满整条缝）', () => {
    const short: Seg = { x1: 3250, y1: 1300, x2: 3250, y2: 1700 };
    const out = findFakePartitions([short], [LEFT, RIGHT], [], { thicknessMm: THICKNESS });
    expect(out.removed).toEqual([0]);
    const ys = out.bridges.flat().map((p) => p.y);
    // 原墙段只有 400mm 长，桥要长到两块碎块的上下边界附近
    expect(Math.min(...ys)).toBeLessThan(400);
    expect(Math.max(...ys)).toBeGreaterThan(2600);
  });

  it('一侧是组外房间 → 真墙：不摘，整组放弃拼合', () => {
    const rightTop = rect(3500, 0, 6500, 1500);
    const otherRoom = rect(3500, 1500, 6500, 3000);
    const out = findFakePartitions([COUNTER], [LEFT, rightTop], [otherRoom], {
      thicknessMm: THICKNESS,
    });
    expect(out.blocked).toBe(true);
    expect(out.removed).toEqual([]);
  });

  it('一侧是室外（探不到任何房间）→ 真墙：不摘，整组放弃拼合', () => {
    // 右块只覆盖上半截，墙的下半截右边什么都没有
    const rightTop = rect(3500, 0, 6500, 1500);
    const out = findFakePartitions([COUNTER], [LEFT, rightTop], [], { thicknessMm: THICKNESS });
    expect(out.blocked).toBe(true);
    expect(out.removed).toEqual([]);
  });

  it('组的外墙（一侧本组、一侧室外）既不摘也不阻断拼合', () => {
    const exterior: Seg = { x1: 0, y1: 0, x2: 0, y2: 3000 };
    const out = findFakePartitions([exterior], [LEFT, RIGHT], [], { thicknessMm: THICKNESS });
    expect(out.blocked).toBe(false);
    expect(out.removed).toEqual([]);
  });

  it('房间内部的墙（两侧是同一块碎块）不算候选，不摘', () => {
    const inner: Seg = { x1: 500, y1: 1500, x2: 2500, y2: 1500 };
    const out = findFakePartitions([inner], [LEFT, RIGHT], [], { thicknessMm: THICKNESS });
    expect(out.removed).toEqual([]);
    expect(out.blocked).toBe(false);
  });

  it('太短的线段（< 300mm）不参与判定', () => {
    const tiny: Seg = { x1: 3250, y1: 1450, x2: 3250, y2: 1550 };
    const out = findFakePartitions([tiny], [LEFT, RIGHT], [], { thicknessMm: THICKNESS });
    expect(out.removed).toEqual([]);
  });
});

describe('rasterMergePolygons', () => {
  it('两块矩形 + 桥 → 一个完整的大矩形', () => {
    const bridge = rect(2900, 0, 3600, 3000);
    const out = rasterMergePolygons([LEFT, RIGHT, bridge]);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(4);
    expect(polygonAreaMm2(out!)).toBeCloseTo(6500 * 3000, -4);
  });

  it('假隔断判定扫出来的桥真的能把两块拼上（端到端）', () => {
    const fake = findFakePartitions([COUNTER], [LEFT, RIGHT], [], { thicknessMm: THICKNESS });
    const out = rasterMergePolygons([LEFT, RIGHT, ...fake.bridges]);
    expect(out).not.toBeNull();
    const area = polygonAreaMm2(out!);
    // 两块 9e6 + 中间 500×3000 的缝 = 19.5e6，栅格量化允许 ±5%
    expect(area).toBeGreaterThan(19.5e6 * 0.95);
    expect(area).toBeLessThan(19.5e6 * 1.05);
  });

  it('L 型（两块重叠的矩形）拼出 6 个顶点', () => {
    const out = rasterMergePolygons([rect(0, 0, 3000, 1000), rect(0, 0, 1000, 3000)]);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(6);
    expect(polygonAreaMm2(out!)).toBeCloseTo(3000 * 1000 + 1000 * 2000, -4);
  });

  it('三块串联（A—桥—B—桥—C）拼成一条', () => {
    const out = rasterMergePolygons([
      rect(0, 0, 1000, 1000),
      rect(1500, 0, 2500, 1000),
      rect(3000, 0, 4000, 1000),
      rect(1000, 0, 1500, 1000),
      rect(2500, 0, 3000, 1000),
    ]);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(4);
    expect(polygonAreaMm2(out!)).toBeCloseTo(4000 * 1000, -4);
  });

  it('桥断开时不硬拼，返回 null', () => {
    const out = rasterMergePolygons([rect(0, 0, 1000, 1000), rect(3000, 0, 4000, 1000)]);
    expect(out).toBeNull();
  });

  it('少一座桥（三块只搭上一座）也返回 null', () => {
    const out = rasterMergePolygons([
      rect(0, 0, 1000, 1000),
      rect(1500, 0, 2500, 1000),
      rect(3000, 0, 4000, 1000),
      rect(1000, 0, 1500, 1000),
    ]);
    expect(out).toBeNull();
  });

  it('内部空洞会被填掉（房间轮廓只能是一个环）', () => {
    // 一个 3000×3000 的框，中间 1000×1000 是空的
    const out = rasterMergePolygons([
      rect(0, 0, 3000, 1000),
      rect(0, 2000, 3000, 3000),
      rect(0, 0, 1000, 3000),
      rect(2000, 0, 3000, 3000),
    ]);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(4);
    expect(polygonAreaMm2(out!)).toBeCloseTo(3000 * 3000, -4);
  });

  it('斜边不会被栅格化成一串台阶', () => {
    const triangle: Pt[] = [
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
      { x: 4000, y: 3000 },
    ];
    const out = rasterMergePolygons([triangle, rect(0, 0, 500, 500)]);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(6);
  });

  it('只有一块时原样返回（不走栅格，坐标一个不动）', () => {
    const out = rasterMergePolygons([LEFT]);
    expect(out).toEqual(LEFT);
  });
});
