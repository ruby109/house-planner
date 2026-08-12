import { describe, expect, it } from 'vitest';
import { createEmptyDoc } from '../model/defaults';
import { docBounds, docContentPoints } from './docBounds';
import {
  PNG_MAX_LONG_EDGE_PX,
  PNG_MIN_LONG_EDGE_PX,
  PNG_PADDING_MM,
  pixelRatioFor,
  pngFileName,
} from './exportPng';

describe('pixelRatioFor', () => {
  it('小图放大到长边 ≥ 2000px', () => {
    const pr = pixelRatioFor(400, 300);
    expect(400 * pr).toBeGreaterThanOrEqual(PNG_MIN_LONG_EDGE_PX);
    expect(pr).toBe(PNG_MIN_LONG_EDGE_PX / 400);
  });

  it('按长边算，不是按宽度', () => {
    const pr = pixelRatioFor(300, 400);
    expect(400 * pr).toBeCloseTo(PNG_MIN_LONG_EDGE_PX, 6);
  });

  it('已经够大时不缩小（pixelRatio 不低于 1）', () => {
    expect(pixelRatioFor(3000, 1000)).toBe(1);
  });

  it('不超过长边上限', () => {
    const pr = pixelRatioFor(1, 1);
    expect(1 * pr).toBeLessThanOrEqual(PNG_MAX_LONG_EDGE_PX);
  });

  it('非法输入退回 1', () => {
    expect(pixelRatioFor(0, 0)).toBe(1);
    expect(pixelRatioFor(NaN, NaN)).toBe(1);
  });
});

describe('pngFileName', () => {
  it('与 JSON 同名规则，只换后缀', () => {
    expect(pngFileName('我的家', new Date(2026, 7, 11))).toBe('我的家-20260811.png');
  });
});

describe('docBounds', () => {
  it('空文档返回 null', () => {
    expect(docBounds(createEmptyDoc())).toBeNull();
    expect(docContentPoints(createEmptyDoc())).toEqual([]);
  });

  it('墙 + 房间 + 家具都算进包围盒，并带 300mm 边距', () => {
    const doc = createEmptyDoc();
    doc.walls.push({ id: 'w_1', start: { x: 0, y: 0 }, end: { x: 3640, y: 0 } });
    doc.rooms.push({
      id: 'r_1',
      name: '房间',
      floor: 'flooring',
      polygon: [
        { x: 0, y: 0 },
        { x: 3640, y: 0 },
        { x: 3640, y: 2730 },
        { x: 0, y: 2730 },
      ],
    });
    doc.furniture.push({
      id: 'f_1',
      catalogId: null,
      name: '床',
      size: { w: 1000, d: 2000 },
      position: { x: 500, y: 1000 },
      rotation: 0,
      color: '#fff',
      locked: false,
    });

    const b = docBounds(doc, PNG_PADDING_MM);
    expect(b).not.toBeNull();
    // 家具左边缘 500-500 = 0，上下由房间与家具共同决定
    expect(b!.minX).toBe(0 - PNG_PADDING_MM);
    expect(b!.maxX).toBe(3640 + PNG_PADDING_MM);
    expect(b!.minY).toBe(0 - PNG_PADDING_MM);
    expect(b!.maxY).toBe(2730 + PNG_PADDING_MM);
  });

  it('旋转家具按旋转后的四角算', () => {
    const doc = createEmptyDoc();
    doc.furniture.push({
      id: 'f_1',
      catalogId: null,
      name: '桌',
      size: { w: 2000, d: 1000 },
      position: { x: 0, y: 0 },
      rotation: 90,
      color: '#fff',
      locked: false,
    });
    const b = docBounds(doc)!;
    expect(Math.round(b.maxX)).toBe(500);
    expect(Math.round(b.maxY)).toBe(1000);
  });
});
