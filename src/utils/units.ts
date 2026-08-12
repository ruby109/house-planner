/**
 * 单位换算与格式化。
 *
 * 见 docs/ARCHITECTURE.md 第 1 节：
 * - 存储一律 mm 整数；`displayUnit` 只影响格式化，不影响存储。
 * - 面积双单位：畳（帖）与 ㎡。
 */

export type DisplayUnit = 'ja' | 'metric';

/** 1 ㎡ = 1,000,000 mm² */
export const MM2_PER_M2 = 1_000_000;

/**
 * 1 帖 = 910×1820mm = 1,656,200 mm²（≈1.66㎡）。
 *
 * 架构文档写作「1 帖 = 1.62㎡ = 910×1820mm」。二者略有出入：
 * 1.62㎡ 是日本不动产表示规约的下限值，910×1820 才是本项目 910 模数下的
 * 几何真值。这里取几何真值，好处是按模数画出的 6 帖房间正好显示 "6.0 帖"。
 * 参考值 `TATAMI_LEGAL_M2` 一并导出备查。
 */
export const TATAMI_AREA_MM2 = 910 * 1820;
/** 不动产表示规约的 1 帖下限（㎡），仅供参考 */
export const TATAMI_LEGAL_M2 = 1.62;

// ---------------------------------------------------------------------------
// 换算
// ---------------------------------------------------------------------------

export function mm2ToM2(mm2: number): number {
  return mm2 / MM2_PER_M2;
}

export function m2ToMm2(m2: number): number {
  return m2 * MM2_PER_M2;
}

export function mm2ToTatami(mm2: number): number {
  return mm2 / TATAMI_AREA_MM2;
}

export function tatamiToMm2(tatami: number): number {
  return tatami * TATAMI_AREA_MM2;
}

export function mmToM(mm: number): number {
  return mm / 1000;
}

export function mToMm(m: number): number {
  return m * 1000;
}

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

/** 千分位整数，保留负号：1234567 → "1,234,567" */
export function formatInt(v: number): string {
  const n = Math.round(v);
  const sign = n < 0 ? '-' : '';
  return sign + Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 长度 mm，例如 3640 → "3,640 mm" */
export function formatMm(mm: number): string {
  return `${formatInt(mm)} mm`;
}

/** 长度 m，例如 3640 → "3.64 m" */
export function formatM(mm: number, digits = 2): string {
  return `${mmToM(mm).toFixed(digits)} m`;
}

/** 按显示单位格式化长度：ja → mm，metric → m */
export function formatLength(mm: number, unit: DisplayUnit = 'ja'): string {
  return unit === 'ja' ? formatMm(mm) : formatM(mm);
}

/** 面积（畳），例如 9937200 → "6.0 帖" */
export function formatTatami(mm2: number, digits = 1): string {
  return `${mm2ToTatami(mm2).toFixed(digits)} 帖`;
}

/** 面积（㎡），例如 9937200 → "9.94 ㎡" */
export function formatM2(mm2: number, digits = 2): string {
  return `${mm2ToM2(mm2).toFixed(digits)} ㎡`;
}

/** 按显示单位格式化面积 */
export function formatArea(mm2: number, unit: DisplayUnit = 'ja'): string {
  return unit === 'ja' ? formatTatami(mm2) : formatM2(mm2);
}

/** 主单位在前、另一单位在括号内，例如 "6.0 帖（9.94 ㎡）" */
export function formatAreaBoth(mm2: number, unit: DisplayUnit = 'ja'): string {
  return unit === 'ja'
    ? `${formatTatami(mm2)}（${formatM2(mm2)}）`
    : `${formatM2(mm2)}（${formatTatami(mm2)}）`;
}

/** 状态栏指针坐标，例如 "X 1,820  Y -455" */
export function formatPoint(p: { x: number; y: number } | null): string {
  if (!p) return 'X —  Y —';
  return `X ${formatInt(p.x)}  Y ${formatInt(p.y)}`;
}

/**
 * 缩放百分比。`scale` 是 Stage 的 px/mm，`baseScale` 为 100% 对应的 px/mm。
 * 例如 scale = baseScale → "100%"。
 */
export function formatZoom(scale: number, baseScale: number): string {
  if (!Number.isFinite(scale) || !Number.isFinite(baseScale) || baseScale <= 0) return '—';
  return `${Math.round((scale / baseScale) * 100)}%`;
}

/** 吸附步长的人类可读标签 */
export function formatSnapStep(step: number): string {
  if (step === 910) return '910（1 间）';
  if (step === 455) return '455（半间）';
  if (step <= 1) return '自由';
  return `${formatInt(step)} mm`;
}
