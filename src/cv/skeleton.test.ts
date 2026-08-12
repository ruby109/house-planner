import { describe, expect, it } from 'vitest';
import { pruneSpurs, zhangSuenThin } from './skeleton';

/** 用字符画铺一张 mask（'#' = 前景），方便肉眼核对 */
function maskFrom(rows: string[]): { mask: Uint8Array; width: number; height: number } {
  const height = rows.length;
  const width = rows[0].length;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) mask[y * width + x] = rows[y][x] === '#' ? 255 : 0;
  }
  return { mask, width, height };
}

function render(mask: Uint8Array, width: number, height: number): string[] {
  const out: string[] = [];
  for (let y = 0; y < height; y++) {
    let line = '';
    for (let x = 0; x < width; x++) line += mask[y * width + x] ? '#' : '.';
    out.push(line);
  }
  return out;
}

function countOn(mask: Uint8Array): number {
  let n = 0;
  for (const v of mask) if (v) n++;
  return n;
}

/** 每一列里的前景像素个数 */
function columnCounts(mask: Uint8Array, width: number, height: number): number[] {
  const out: number[] = [];
  for (let x = 0; x < width; x++) {
    let n = 0;
    for (let y = 0; y < height; y++) if (mask[y * width + x]) n++;
    out.push(n);
  }
  return out;
}

describe('zhangSuenThin', () => {
  it('把粗横条细成 1px 中心线', () => {
    const { mask, width, height } = maskFrom([
      '..........',
      '..........',
      '.########.',
      '.########.',
      '.########.',
      '.########.',
      '.########.',
      '..........',
    ]);
    const thin = zhangSuenThin(mask, width, height);
    // 每一列最多剩 1 个像素（细成一条线了）
    for (const c of columnCounts(thin, width, height)) expect(c).toBeLessThanOrEqual(1);
    expect(countOn(thin)).toBeGreaterThan(0);
    expect(countOn(thin)).toBeLessThan(countOn(mask) / 3);
  });

  it('已经是 1px 的线不动它', () => {
    const { mask, width, height } = maskFrom([
      '.......',
      '.#####.',
      '.......',
    ]);
    const thin = zhangSuenThin(mask, width, height);
    expect(render(thin, width, height)).toEqual(['.......', '.#####.', '.......']);
  });

  it('保持连通性：粗十字细化后仍是一个连通块', () => {
    const rows = [
      '...###...',
      '...###...',
      '#########',
      '#########',
      '#########',
      '...###...',
      '...###...',
    ];
    const { mask, width, height } = maskFrom(rows);
    const thin = zhangSuenThin(mask, width, height);
    expect(countOn(thin)).toBeGreaterThan(0);

    // 洪水填充数连通块
    const seen = new Uint8Array(width * height);
    let components = 0;
    for (let i = 0; i < thin.length; i++) {
      if (!thin[i] || seen[i]) continue;
      components++;
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const cur = stack.pop()!;
        const cx = cur % width;
        const cy = (cur - cx) / width;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const n = ny * width + nx;
            if (thin[n] && !seen[n]) {
              seen[n] = 1;
              stack.push(n);
            }
          }
        }
      }
    }
    expect(components).toBe(1);
  });

  it('输出仍是 0/255', () => {
    const { mask, width, height } = maskFrom(['####', '####']);
    for (const v of zhangSuenThin(mask, width, height)) expect(v === 0 || v === 255).toBe(true);
  });
});

describe('pruneSpurs', () => {
  it('削掉接点上的短毛刺，主干原样保留', () => {
    // 一条长横线，中间往下长出 2px 的小胡子
    const { mask, width, height } = maskFrom([
      '..............',
      '.############.',
      '.......#......',
      '.......#......',
      '..............',
    ]);
    const pruned = pruneSpurs(mask, width, height, 3);
    expect(render(pruned, width, height)).toEqual([
      '..............',
      '.############.',
      '..............',
      '..............',
      '..............',
    ]);
  });

  it('比阈值长的分支不动', () => {
    const { mask, width, height } = maskFrom([
      '..............',
      '.############.',
      '.......#......',
      '.......#......',
      '.......#......',
      '.......#......',
      '.......#......',
    ]);
    const pruned = pruneSpurs(mask, width, height, 2);
    expect(countOn(pruned)).toBe(countOn(mask));
  });

  it('maxSpurLength = 0 时是空操作', () => {
    const { mask, width, height } = maskFrom(['.###.', '..#..']);
    expect(pruneSpurs(mask, width, height, 0)).toEqual(mask);
  });
});
