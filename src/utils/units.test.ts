import { describe, expect, it } from 'vitest';
import {
  MM2_PER_M2,
  TATAMI_AREA_MM2,
  formatArea,
  formatAreaBoth,
  formatInt,
  formatLength,
  formatM,
  formatM2,
  formatMm,
  formatPoint,
  formatSnapStep,
  formatTatami,
  formatZoom,
  m2ToMm2,
  mToMm,
  mm2ToM2,
  mm2ToTatami,
  mmToM,
  tatamiToMm2,
} from './units';

/** 6 帖 = 2730 × 3640 mm */
const SIX_TATAMI_MM2 = 2730 * 3640;

describe('常量', () => {
  it('1 帖 = 910×1820 mm²', () => {
    expect(TATAMI_AREA_MM2).toBe(1_656_200);
  });

  it('1 ㎡ = 1,000,000 mm²', () => {
    expect(MM2_PER_M2).toBe(1_000_000);
  });
});

describe('面积换算', () => {
  it('mm² ↔ ㎡', () => {
    expect(mm2ToM2(1_656_200)).toBeCloseTo(1.6562, 10);
    expect(m2ToMm2(1.6562)).toBeCloseTo(1_656_200, 6);
  });

  it('mm² ↔ 帖', () => {
    expect(mm2ToTatami(TATAMI_AREA_MM2)).toBe(1);
    expect(mm2ToTatami(SIX_TATAMI_MM2)).toBeCloseTo(6, 10);
    expect(tatamiToMm2(6)).toBe(SIX_TATAMI_MM2);
  });

  it('往返换算稳定', () => {
    expect(tatamiToMm2(mm2ToTatami(12345678))).toBeCloseTo(12345678, 6);
    expect(m2ToMm2(mm2ToM2(12345678))).toBeCloseTo(12345678, 6);
  });
});

describe('长度换算', () => {
  it('mm ↔ m', () => {
    expect(mmToM(3640)).toBe(3.64);
    expect(mToMm(3.64)).toBeCloseTo(3640, 6);
  });
});

describe('formatInt', () => {
  it('千分位', () => {
    expect(formatInt(0)).toBe('0');
    expect(formatInt(910)).toBe('910');
    expect(formatInt(1820)).toBe('1,820');
    expect(formatInt(1234567)).toBe('1,234,567');
  });

  it('负数与小数', () => {
    expect(formatInt(-1820)).toBe('-1,820');
    expect(formatInt(1819.6)).toBe('1,820');
  });
});

describe('长度格式化', () => {
  it('formatMm / formatM', () => {
    expect(formatMm(3640)).toBe('3,640 mm');
    expect(formatM(3640)).toBe('3.64 m');
    expect(formatM(3600, 1)).toBe('3.6 m');
  });

  it('formatLength 随显示单位切换', () => {
    expect(formatLength(3640, 'ja')).toBe('3,640 mm');
    expect(formatLength(3640, 'metric')).toBe('3.64 m');
  });
});

describe('面积格式化', () => {
  it('按模数画的 6 帖房间正好显示 6.0 帖', () => {
    expect(formatTatami(SIX_TATAMI_MM2)).toBe('6.0 帖');
  });

  it('formatM2', () => {
    expect(formatM2(SIX_TATAMI_MM2)).toBe('9.94 ㎡');
    expect(formatM2(SIX_TATAMI_MM2, 1)).toBe('9.9 ㎡');
  });

  it('formatArea 随显示单位切换', () => {
    expect(formatArea(SIX_TATAMI_MM2, 'ja')).toBe('6.0 帖');
    expect(formatArea(SIX_TATAMI_MM2, 'metric')).toBe('9.94 ㎡');
  });

  it('formatAreaBoth 主单位在前', () => {
    expect(formatAreaBoth(SIX_TATAMI_MM2, 'ja')).toBe('6.0 帖（9.94 ㎡）');
    expect(formatAreaBoth(SIX_TATAMI_MM2, 'metric')).toBe('9.94 ㎡（6.0 帖）');
  });

  it('零面积', () => {
    expect(formatArea(0, 'ja')).toBe('0.0 帖');
    expect(formatArea(0, 'metric')).toBe('0.00 ㎡');
  });
});

describe('formatPoint', () => {
  it('有坐标时输出千分位', () => {
    expect(formatPoint({ x: 1820, y: -455 })).toBe('X 1,820  Y -455');
  });

  it('无坐标时占位', () => {
    expect(formatPoint(null)).toBe('X —  Y —');
  });
});

describe('formatZoom', () => {
  it('等于基准时为 100%', () => {
    expect(formatZoom(0.05, 0.05)).toBe('100%');
  });

  it('按比例换算', () => {
    expect(formatZoom(0.1, 0.05)).toBe('200%');
    expect(formatZoom(0.025, 0.05)).toBe('50%');
  });

  it('非法输入返回占位', () => {
    expect(formatZoom(0.05, 0)).toBe('—');
    expect(formatZoom(NaN, 0.05)).toBe('—');
  });
});

describe('formatSnapStep', () => {
  it('模数步长有中文说明', () => {
    expect(formatSnapStep(910)).toBe('910（1 间）');
    expect(formatSnapStep(455)).toBe('455（半间）');
    expect(formatSnapStep(100)).toBe('100 mm');
    expect(formatSnapStep(1)).toBe('自由');
  });
});
