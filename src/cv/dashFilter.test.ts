/**
 * `dashFilter.ts` 的单测（纯 TS，不碰 opencv）。
 *
 * 两把刀分开测：
 * - `findDashChains`：共线 + 等间距 + 重复 ≥3 的聚类；
 * - `pickThinComponents`：闭运算之后按厚度摘掉整块细线框。
 */
import { describe, expect, it } from 'vitest';
import { findDashChains, pickThinComponents, type ThinComponentStat } from './dashFilter';
import type { ComponentStat } from './strokeStats';

/** 造一个连通块：左上角 (x,y)、尺寸 w×h，面积按实心算 */
function comp(label: number, x: number, y: number, w: number, h: number): ComponentStat {
  return { label, x, y, w, h, area: w * h, density: 1 };
}

/** 沿 x 轴排一串虚线杠：起点 x0、步长 step、共 n 个，每杠 6×2 */
function dashRow(startLabel: number, x0: number, y: number, step: number, n: number, jitter = 0): ComponentStat[] {
  const out: ComponentStat[] = [];
  for (let i = 0; i < n; i++) {
    const dy = jitter === 0 ? 0 : (i % 2 === 0 ? jitter : -jitter);
    out.push(comp(startLabel + i, x0 + i * step, y + dy, 6, 2));
  }
  return out;
}

const STROKE = 10;

describe('findDashChains', () => {
  it('把等间距重复 5 个的横向虚线整链找出来', () => {
    const chains = findDashChains(dashRow(1, 100, 200, 14, 5), { strokePx: STROKE });
    expect(chains).toHaveLength(1);
    expect(chains[0].labels.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(chains[0].spacingPx).toBeCloseTo(14, 5);
    expect(chains[0].angleDeg).toBeCloseTo(0, 5);
  });

  it('只有 2 个不成链（最少 3 个）', () => {
    expect(findDashChains(dashRow(1, 100, 200, 14, 2), { strokePx: STROKE })).toHaveLength(0);
  });

  it('链的包围盒罩住所有杠，可以直接拿去画黄框', () => {
    const [chain] = findDashChains(dashRow(1, 100, 200, 14, 4), { strokePx: STROKE });
    expect(chain.box).toEqual({ x: 100, y: 200, w: 6 + 3 * 14, h: 2 });
  });

  it('吃得下 JPEG 压缩造成的 ±1px 抖动', () => {
    const chains = findDashChains(dashRow(1, 100, 200, 14, 5, 1), { strokePx: STROKE });
    expect(chains).toHaveLength(1);
    expect(chains[0].labels).toHaveLength(5);
  });

  it('竖排虚线同样能找出来，角度记 90°', () => {
    const comps: ComponentStat[] = [];
    for (let i = 0; i < 4; i++) comps.push(comp(i + 1, 300, 100 + i * 16, 2, 6));
    const [chain] = findDashChains(comps, { strokePx: STROKE });
    expect(chain.labels).toHaveLength(4);
    expect(chain.angleDeg).toBeCloseTo(90, 5);
  });

  it('间距忽大忽小的一排（不是虚线，是散落的家具符号）不成链', () => {
    const comps = [comp(1, 100, 200, 6, 2), comp(2, 118, 200, 6, 2), comp(3, 190, 200, 6, 2), comp(4, 210, 200, 6, 2)];
    // 18 / 72 / 20 —— 步长差了 3 倍，点名点不到
    expect(findDashChains(comps, { strokePx: STROKE })).toHaveLength(0);
  });

  it('墙那么粗、那么长的块根本进不了候选', () => {
    const comps: ComponentStat[] = [];
    for (let i = 0; i < 5; i++) comps.push(comp(i + 1, 100 + i * 60, 200, 50, 12));
    expect(findDashChains(comps, { strokePx: STROKE })).toHaveLength(0);
  });

  it('两条互不相干的虚线链分别成链，不会串味', () => {
    const chains = findDashChains(
      [...dashRow(1, 100, 200, 14, 4), ...dashRow(11, 100, 400, 14, 4)],
      { strokePx: STROKE },
    );
    expect(chains).toHaveLength(2);
    const ys = chains.map((c) => c.box.y).sort((a, b) => a - b);
    expect(ys).toEqual([200, 400]);
  });

  it('间隔超过 maxSpacing 的不算一条链', () => {
    const chains = findDashChains(dashRow(1, 100, 200, 200, 5), { strokePx: STROKE });
    expect(chains).toHaveLength(0);
  });

  it('同一批输入跑两遍结果完全一致（顺序无关）', () => {
    const comps = dashRow(1, 100, 200, 14, 5);
    const a = findDashChains(comps, { strokePx: STROKE });
    const b = findDashChains([...comps].reverse(), { strokePx: STROKE });
    expect(b.map((c) => c.labels.slice().sort())).toEqual(a.map((c) => c.labels.slice().sort()));
  });
});

describe('pickThinComponents', () => {
  const thin = (label: number, w: number, h: number, thicknessPx: number): ThinComponentStat => ({
    ...comp(label, 0, 0, w, h),
    thicknessPx,
  });

  it('摘掉「整块都比墙细」的大线框（地暖框 / 家具轮廓）', () => {
    const picked = pickThinComponents([thin(1, 200, 150, 4)], { strokePx: 20 });
    expect(picked.map((c) => c.label)).toEqual([1]);
  });

  it('闭运算之后已经填成实心带的真墙一根不动', () => {
    expect(pickThinComponents([thin(1, 200, 150, 18)], { strokePx: 20 })).toHaveLength(0);
  });

  it('长边太短的块不参与判定（交给碎块过滤）', () => {
    expect(pickThinComponents([thin(1, 20, 6, 3)], { strokePx: 20 })).toHaveLength(0);
  });

  it('阈值随墙笔画宽走，不写死像素', () => {
    const c = thin(1, 200, 150, 7);
    expect(pickThinComponents([c], { strokePx: 20 })).toHaveLength(1); // 7 < 0.6×20
    expect(pickThinComponents([c], { strokePx: 10 })).toHaveLength(0); // 7 > 0.6×10
  });

  it('thinRatio 可调', () => {
    const c = thin(1, 200, 150, 13);
    expect(pickThinComponents([c], { strokePx: 20 })).toHaveLength(0); // 13 > 0.6×20
    expect(pickThinComponents([c], { strokePx: 20, thinRatio: 0.8 })).toHaveLength(1); // 13 < 0.8×20
  });
});
