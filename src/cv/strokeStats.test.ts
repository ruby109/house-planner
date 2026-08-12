import { describe, expect, it } from 'vitest';
import {
  analyzeStroke,
  isTextComponent,
  measureBox,
  otsuSplit,
  pickPlanGroup,
  type ComponentStat,
} from './strokeStats';

function comp(x: number, y: number, w: number, h: number, fill: number, label = 1): ComponentStat {
  const area = Math.round(w * h * fill);
  return { label, x, y, w, h, area, density: area / (w * h) };
}

/** 生成升序的脊线半宽样本：n1 个细的（half1）+ n2 个粗的（half2） */
function halfWidths(n1: number, half1: number, n2: number, half2: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n1; i++) out.push(half1);
  for (let i = 0; i < n2; i++) out.push(half2);
  return out.sort((a, b) => a - b);
}

describe('otsuSplit', () => {
  it('在双峰之间切一刀', () => {
    const split = otsuSplit(halfWidths(200, 1.5, 120, 6));
    expect(split).not.toBeNull();
    expect(split!).toBeGreaterThan(1.5);
    expect(split!).toBeLessThanOrEqual(6);
  });

  it('样本太少返回 null', () => {
    expect(otsuSplit([1, 2, 3])).toBeNull();
  });

  it('两群体量悬殊也能切开', () => {
    const split = otsuSplit(halfWidths(1000, 2, 60, 9));
    expect(split).not.toBeNull();
    expect(split!).toBeGreaterThan(2);
    expect(split!).toBeLessThanOrEqual(9);
  });
});

describe('analyzeStroke', () => {
  it('墙宽取的是粗的那一群的中位数', () => {
    const r = analyzeStroke(halfWidths(300, 1.5, 200, 5));
    expect(r.strokePx).toBeCloseTo(10, 0);
  });

  it('离群的超粗块（装饰条 / 照片）不会把估计拉飞', () => {
    const withOutliers = [...halfWidths(300, 1.5, 200, 5), ...new Array(40).fill(60)].sort((a, b) => a - b);
    const r = analyzeStroke(withOutliers);
    expect(r.strokePx).toBeLessThan(20);
  });

  it('空输入有兜底值', () => {
    expect(analyzeStroke([])).toEqual({ split: null, strokePx: 2 });
  });
});

describe('isTextComponent', () => {
  const params = { maxSizePx: 30, minAreaPx: 6, minDensity: 0.12 };

  it('小而实的块判为文字', () => {
    expect(isTextComponent(comp(10, 10, 14, 16, 0.4), params)).toBe(true);
  });

  it('长条（墙）不是文字', () => {
    expect(isTextComponent(comp(0, 0, 400, 6, 0.9), params)).toBe(false);
  });

  it('太空的小块（细线框）不是文字', () => {
    expect(isTextComponent(comp(0, 0, 20, 20, 0.05), params)).toBe(false);
  });

  it('噪点级面积不算文字（另行处理）', () => {
    expect(isTextComponent(comp(0, 0, 2, 2, 1), params)).toBe(false);
  });
});

describe('pickPlanGroup', () => {
  it('挑「包围盒大、填得最空」的那一团（户型墙网），丢掉实心照片块', () => {
    const plan = [
      comp(600, 20, 380, 700, 0.06, 1), // 墙网：大而空
      comp(620, 60, 60, 40, 0.3, 2), // 挨着墙网的小件
    ];
    const photo = [comp(20, 20, 500, 300, 0.95, 3)]; // 照片：大而实
    const res = pickPlanGroup([...plan, ...photo], 1000, 750, 20);
    expect(res.keep.map((c) => c.label).sort()).toEqual([1, 2]);
    expect(res.dropped).toBe(1);
  });

  it('邻近的连通块会被聚成同一团', () => {
    const res = pickPlanGroup(
      [comp(100, 100, 300, 10, 0.9, 1), comp(100, 130, 300, 300, 0.05, 2)],
      1000,
      1000,
      40,
    );
    expect(res.keep).toHaveLength(2);
    expect(res.dropped).toBe(0);
  });

  it('输入为空时不炸', () => {
    expect(pickPlanGroup([], 100, 100, 5)).toEqual({ keep: [], dropped: 0 });
  });

  it('所有团都太小时全部保留（不敢乱丢）', () => {
    const res = pickPlanGroup([comp(0, 0, 5, 5, 1, 1)], 1000, 1000, 2);
    expect(res.keep).toHaveLength(1);
    expect(res.dropped).toBe(0);
  });
});

describe('measureBox', () => {
  it('返回主墙体块的包围盒并外扩 15%', () => {
    const box = measureBox([comp(100, 100, 400, 400, 0.05, 1)], 1000, 1000);
    expect(box).not.toBeNull();
    expect(box!.x).toBe(40);
    expect(box!.y).toBe(40);
    expect(box!.width).toBe(520);
  });

  it('没有够大的块时返回 null（退回整图量尺）', () => {
    expect(measureBox([comp(0, 0, 20, 20, 0.5, 1)], 1000, 1000)).toBeNull();
  });

  it('外扩后被图幅夹住', () => {
    const box = measureBox([comp(0, 0, 900, 900, 0.05, 1)], 1000, 1000);
    expect(box!.x).toBe(0);
    expect(box!.y).toBe(0);
    expect(box!.width).toBe(1000);
    expect(box!.height).toBe(1000);
  });
});
