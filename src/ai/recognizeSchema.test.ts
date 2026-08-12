/**
 * 归一化坐标两道防线的单测。
 *
 * 背景（2026-08-11 踩到的真实 bug）：对 338×723 的竖长条間取り图跑识别时，
 * 模型忽略「两轴各自独立归一化」的约定，改用**等比归一化**（两轴共用一个比例尺），
 * 于是 y 冲到 1210，`recognizeResultIssues()` 两次全挂、整次识别失败。
 *
 * 防线一是 prompt（`server/prompt.mjs`，没法单测）；
 * 防线二就是这里的 `fixAxisNormalization()`——单轴线性缩放、信息无损，直接压回 0~1000。
 * 另外 `applyImageAspect()` 负责「模型坐标系 → 内部坐标系」的那一次换算。
 */
import { describe, expect, it } from 'vitest';
import {
  NORM_RESCALE_MAX,
  applyImageAspect,
  fixAxisNormalization,
  recognizeResultIssues,
  type RecognizeResult,
} from './recognizeSchema';

// ---------------------------------------------------------------------------
// fixture 构造器
// ---------------------------------------------------------------------------

/** 一个最小可用的结果：一个矩形房间 + 一个洞口 + 一根柱 */
function makeResult(rect: { x0: number; y0: number; x1: number; y1: number }): RecognizeResult {
  return {
    notes: 'test',
    scale: { method: 'tatami', drawingWidthMm: 8000 },
    rooms: [
      {
        id: 'r1',
        name: '洋室',
        floor: 'flooring',
        tatamiCount: 6,
        polygon: [
          { x: rect.x0, y: rect.y0 },
          { x: rect.x1, y: rect.y0 },
          { x: rect.x1, y: rect.y1 },
          { x: rect.x0, y: rect.y1 },
        ],
      },
    ],
    openings: [{ type: 'door', roomA: 'r1', roomB: 'outside', x: rect.x1, y: rect.y1 }],
    columns: [{ x: rect.x1, y: rect.y1, w: 20, h: 30 }],
  };
}

const maxOf = (r: RecognizeResult) => ({
  x: Math.max(...r.rooms[0].polygon.map((p) => p.x)),
  y: Math.max(...r.rooms[0].polygon.map((p) => p.y)),
});

// ---------------------------------------------------------------------------
// fixAxisNormalization
// ---------------------------------------------------------------------------

describe('fixAxisNormalization', () => {
  it('正常范围内的坐标一动不动（连对象引用都不换）', () => {
    const input = makeResult({ x0: 40, y0: 60, x1: 960, y1: 1000 });
    const fixed = fixAxisNormalization(input);
    expect(fixed.result).toBe(input);
    expect(fixed.factors).toEqual({ x: 1, y: 1 });
    expect(fixed.warnings).toEqual([]);
    expect(recognizeResultIssues(fixed.result)).toEqual([]);
  });

  it('竖图：y 轴等比归一化溢出 → 按 1000/max 压回，x 轴不受影响', () => {
    // 338×723 的竖图，模型把 y 按图宽的比例尺算了 → ymax 1210
    const input = makeResult({ x0: 50, y0: 100, x1: 908, y1: 1210 });
    const fixed = fixAxisNormalization(input);

    expect(fixed.factors.x).toBe(1);
    expect(fixed.factors.y).toBeCloseTo(1000 / 1210, 9);
    expect(maxOf(fixed.result)).toEqual({ x: 908, y: 1000 });
    // 相对关系不变：原来 y0/y1 = 100/1210
    expect(fixed.result.rooms[0].polygon[0].y).toBeCloseTo((100 / 1210) * 1000, 3);
    expect(fixed.warnings).toHaveLength(1);
    expect(fixed.warnings[0]).toContain('模型坐标归一化已自动修正');
    expect(fixed.warnings[0]).toContain('y 轴');
    // 修正之后必须能通过校验——这正是这道防线存在的意义
    expect(recognizeResultIssues(fixed.result)).toEqual([]);
  });

  it('横图：x 轴溢出同样能修，且 openings / columns 同步缩放', () => {
    const input = makeResult({ x0: 200, y0: 10, x1: 2000, y1: 500 });
    const fixed = fixAxisNormalization(input);

    expect(fixed.factors.x).toBeCloseTo(0.5, 9);
    expect(fixed.factors.y).toBe(1);
    expect(maxOf(fixed.result)).toEqual({ x: 1000, y: 500 });
    expect(fixed.result.openings[0].x).toBe(1000);
    expect(fixed.result.openings[0].y).toBe(500);
    expect(fixed.result.columns[0].x).toBe(1000);
    // columns 的 w 跟 x 轴、h 跟 y 轴
    expect(fixed.result.columns[0].w).toBe(10);
    expect(fixed.result.columns[0].h).toBe(30);
    expect(fixed.warnings[0]).toContain('x 轴');
    expect(recognizeResultIssues(fixed.result)).toEqual([]);
  });

  it('两轴同时溢出 → 各自独立修正，warning 里两轴都提到', () => {
    const input = makeResult({ x0: 0, y0: 0, x1: 1500, y1: 2500 });
    const fixed = fixAxisNormalization(input);
    expect(fixed.factors.x).toBeCloseTo(1000 / 1500, 9);
    expect(fixed.factors.y).toBeCloseTo(1000 / 2500, 9);
    expect(maxOf(fixed.result)).toEqual({ x: 1000, y: 1000 });
    expect(fixed.warnings[0]).toContain('x 轴');
    expect(fixed.warnings[0]).toContain('y 轴');
  });

  it('溢出超过 NORM_RESCALE_MAX（多半是像素坐标）→ 不修，照旧报校验错误', () => {
    const input = makeResult({ x0: 0, y0: 0, x1: 338, y1: NORM_RESCALE_MAX + 1 });
    const fixed = fixAxisNormalization(input);
    expect(fixed.result).toBe(input);
    expect(fixed.warnings).toEqual([]);
    expect(recognizeResultIssues(fixed.result).join('；')).toContain('超出');
  });

  it('负数越界不在修正范围内，照旧报校验错误', () => {
    const input = makeResult({ x0: -400, y0: 0, x1: 900, y1: 900 });
    const fixed = fixAxisNormalization(input);
    expect(fixed.warnings).toEqual([]);
    expect(recognizeResultIssues(fixed.result).join('；')).toContain('超出');
  });

  it('刚好 1000 不触发（边界是开区间）', () => {
    const input = makeResult({ x0: 0, y0: 0, x1: 1000, y1: 1000 });
    expect(fixAxisNormalization(input).result).toBe(input);
  });

  it('是纯函数：不改动入参', () => {
    const input = makeResult({ x0: 0, y0: 0, x1: 900, y1: 1800 });
    const snapshot = JSON.parse(JSON.stringify(input));
    fixAxisNormalization(input);
    expect(input).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// applyImageAspect
// ---------------------------------------------------------------------------

describe('applyImageAspect', () => {
  it('竖图：y 按 图高/图宽 拉开，x 原样（内部坐标系两轴同一比例尺）', () => {
    const input = makeResult({ x0: 0, y0: 0, x1: 1000, y1: 1000 });
    const out = applyImageAspect(input, 338, 723);
    const ratio = 723 / 338;

    expect(out.rooms[0].polygon[1].x).toBe(1000);
    expect(out.rooms[0].polygon[2].y).toBeCloseTo(1000 * ratio, 2);
    expect(out.openings[0].y).toBeCloseTo(1000 * ratio, 2);
    expect(out.columns[0].y).toBeCloseTo(1000 * ratio, 2);
    expect(out.columns[0].h).toBeCloseTo(30 * ratio, 2);
    expect(out.columns[0].w).toBe(20);
  });

  it('转换后 归一化→像素 能还原原始像素位置', () => {
    // 像素 (85, 578) 在 338×723 的图上 → 模型坐标 (251.5, 799.4)
    const input = makeResult({ x0: 0, y0: 0, x1: (85 / 338) * 1000, y1: (578 / 723) * 1000 });
    const out = applyImageAspect(input, 338, 723);
    // 内部坐标系：两轴都按图宽还原
    const px = (v: number) => (v / 1000) * 338;
    expect(px(out.rooms[0].polygon[1].x)).toBeCloseTo(85, 2);
    expect(px(out.rooms[0].polygon[2].y)).toBeCloseTo(578, 2);
  });

  it('横图：y 被压缩', () => {
    const out = applyImageAspect(makeResult({ x0: 0, y0: 0, x1: 1000, y1: 1000 }), 500, 375);
    expect(out.rooms[0].polygon[2].y).toBeCloseTo(750, 6);
  });

  it('正方形 / 尺寸非法时原样返回', () => {
    const input = makeResult({ x0: 0, y0: 0, x1: 1000, y1: 1000 });
    expect(applyImageAspect(input, 600, 600)).toBe(input);
    expect(applyImageAspect(input, 0, 723)).toBe(input);
    expect(applyImageAspect(input, 338, 0)).toBe(input);
  });
});
