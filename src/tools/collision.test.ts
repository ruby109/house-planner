import { describe, expect, it } from 'vitest';
import type { Furniture, Wall } from '../model/types';
import {
  collidingFurnitureIds,
  furnitureBody,
  rectCollides,
  rectHitsFurniture,
  rectHitsWalls,
  rectPolygon,
  wallPolygon,
} from './collision';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function mkFurniture(
  id: string,
  x: number,
  y: number,
  w: number,
  d: number,
  rotation = 0,
): Furniture {
  return {
    id,
    catalogId: null,
    name: id,
    size: { w, d },
    position: { x, y },
    rotation,
    color: '#cccccc',
    locked: false,
  };
}

function mkWall(id: string, x1: number, y1: number, x2: number, y2: number): Wall {
  return { id, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } };
}

// ---------------------------------------------------------------------------

describe('rectPolygon', () => {
  it('未旋转矩形返回四角（左上→右上→右下→左下）', () => {
    const poly = rectPolygon({ position: { x: 0, y: 0 }, w: 200, d: 100, rotation: 0 });
    expect(poly).toEqual([
      { x: -100, y: -50 },
      { x: 100, y: -50 },
      { x: 100, y: 50 },
      { x: -100, y: 50 },
    ]);
  });

  it('旋转 90° 后宽深互换', () => {
    const poly = rectPolygon({ position: { x: 0, y: 0 }, w: 200, d: 100, rotation: 90 });
    const xs = poly.map((p) => Math.round(p.x));
    const ys = poly.map((p) => Math.round(p.y));
    expect(Math.max(...xs) - Math.min(...xs)).toBe(100);
    expect(Math.max(...ys) - Math.min(...ys)).toBe(200);
  });
});

describe('家具 vs 家具', () => {
  const bed = mkFurniture('f_bed', 0, 0, 1000, 2000);

  it('重叠 → 碰撞', () => {
    const desk = mkFurniture('f_desk', 400, 0, 1000, 600);
    expect(rectHitsFurniture(furnitureBody(desk), [bed])).toBe(true);
  });

  it('分离 → 不碰撞', () => {
    const desk = mkFurniture('f_desk', 2000, 0, 1000, 600);
    expect(rectHitsFurniture(furnitureBody(desk), [bed])).toBe(false);
  });

  it('恰好贴边（仅接触）→ 不碰撞', () => {
    // bed 占 x ∈ [-500, 500]，desk 左边界正好落在 x = 500
    const desk = mkFurniture('f_desk', 1000, 0, 1000, 600);
    expect(rectHitsFurniture(furnitureBody(desk), [bed])).toBe(false);
  });

  it('旋转后才相交的情况能被检出', () => {
    // 竖放时（未旋转）与 bed 分离；旋转 90° 后横跨过去
    const shelf = mkFurniture('f_shelf', 900, 0, 300, 1600, 0);
    expect(rectHitsFurniture(furnitureBody(shelf), [bed])).toBe(false);
    const rotated = { ...shelf, rotation: 90 };
    expect(rectHitsFurniture(furnitureBody(rotated), [bed])).toBe(true);
  });

  it('excludeId 排除自身', () => {
    expect(rectHitsFurniture(furnitureBody(bed), [bed])).toBe(true);
    expect(rectHitsFurniture(furnitureBody(bed), [bed], bed.id)).toBe(false);
  });

  it('空列表不碰撞', () => {
    expect(rectHitsFurniture(furnitureBody(bed), [])).toBe(false);
  });
});

describe('家具 vs 墙', () => {
  // 水平墙，中心线 y = 0，视觉宽度 100mm ⇒ 占据 y ∈ [-50, 50]
  const wall = mkWall('w_1', 0, 0, 4000, 0);

  it('墙按中心线扩成 100mm 宽的矩形', () => {
    const poly = wallPolygon(wall);
    const ys = poly.map((p) => p.y);
    expect(Math.min(...ys)).toBe(-50);
    expect(Math.max(...ys)).toBe(50);
  });

  it('压在墙上 → 碰撞', () => {
    const f = mkFurniture('f_a', 2000, 120, 400, 200); // y ∈ [20, 220]
    expect(rectHitsWalls(furnitureBody(f), [wall])).toBe(true);
  });

  it('离墙有间隙 → 不碰撞', () => {
    const f = mkFurniture('f_a', 2000, 200, 400, 200); // y ∈ [100, 300]
    expect(rectHitsWalls(furnitureBody(f), [wall])).toBe(false);
  });

  it('紧贴墙面（仅接触）→ 不碰撞', () => {
    const f = mkFurniture('f_a', 2000, 150, 400, 200); // y ∈ [50, 250]，边界正好贴墙
    expect(rectHitsWalls(furnitureBody(f), [wall])).toBe(false);
  });

  it('超出墙端点范围 → 不碰撞', () => {
    const f = mkFurniture('f_a', 5000, 0, 400, 200);
    expect(rectHitsWalls(furnitureBody(f), [wall])).toBe(false);
  });

  it('斜墙同样参与检测', () => {
    const diagonal = mkWall('w_2', 0, 0, 2000, 2000);
    const on = mkFurniture('f_on', 1000, 1000, 400, 400);
    const off = mkFurniture('f_off', 1800, 400, 400, 400);
    expect(rectHitsWalls(furnitureBody(on), [diagonal])).toBe(true);
    expect(rectHitsWalls(furnitureBody(off), [diagonal])).toBe(false);
  });

  it('无墙时不碰撞', () => {
    expect(rectHitsWalls(furnitureBody(mkFurniture('f_a', 0, 0, 100, 100)), [])).toBe(false);
  });
});

describe('rectCollides（放置预览用）', () => {
  const wall = mkWall('w_1', 0, 0, 4000, 0);
  const bed = mkFurniture('f_bed', 2000, 1000, 1000, 2000);

  it('与墙或家具任一相交即为碰撞', () => {
    const onWall = { position: { x: 1000, y: 0 }, w: 600, d: 600, rotation: 0 };
    const onBed = { position: { x: 2000, y: 1000 }, w: 600, d: 600, rotation: 0 };
    const free = { position: { x: 3500, y: 3000 }, w: 600, d: 600, rotation: 0 };
    expect(rectCollides(onWall, [wall], [bed])).toBe(true);
    expect(rectCollides(onBed, [wall], [bed])).toBe(true);
    expect(rectCollides(free, [wall], [bed])).toBe(false);
  });
});

describe('collidingFurnitureIds', () => {
  it('互相重叠的两件都被标记，其余不受影响', () => {
    const a = mkFurniture('f_a', 0, 0, 1000, 1000);
    const b = mkFurniture('f_b', 500, 0, 1000, 1000);
    const c = mkFurniture('f_c', 5000, 5000, 1000, 1000);
    const hit = collidingFurnitureIds([a, b, c], []);
    expect(hit).toEqual(new Set(['f_a', 'f_b']));
  });

  it('压在墙上的家具被标记', () => {
    const wall = mkWall('w_1', 0, 0, 4000, 0);
    const on = mkFurniture('f_on', 1000, 0, 600, 600);
    const off = mkFurniture('f_off', 1000, 2000, 600, 600);
    const hit = collidingFurnitureIds([on, off], [wall]);
    expect(hit.has('f_on')).toBe(true);
    expect(hit.has('f_off')).toBe(false);
  });

  it('空文档返回空集合', () => {
    expect(collidingFurnitureIds([], [])).toEqual(new Set());
    expect(collidingFurnitureIds([], [mkWall('w_1', 0, 0, 100, 0)])).toEqual(new Set());
  });

  it('家具数量 100 时仍能在合理时间内算完', () => {
    const list = Array.from({ length: 100 }, (_, i) =>
      mkFurniture(`f_${i}`, (i % 10) * 2000, Math.floor(i / 10) * 2000, 900, 600),
    );
    const t0 = Date.now();
    const hit = collidingFurnitureIds(list, []);
    expect(hit.size).toBe(0);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
