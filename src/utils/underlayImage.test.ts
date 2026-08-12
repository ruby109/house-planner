import { describe, expect, it } from 'vitest';
import type { Underlay } from '../model/types';
import {
  UNDERLAY_MAX_DATA_URL_CHARS,
  UNDERLAY_MAX_LONG_EDGE,
  UNDERLAY_TARGET_WIDTH_MM,
  calibrateUnderlay,
  centeredOffset,
  compressionLadder,
  createUnderlay,
  docToImagePx,
  imagePxToDoc,
  initialMmPerPixel,
  isWithinUnderlayBudget,
  offsetKeepingCenter,
  scaledSize,
  underlayCenterMm,
  underlayCornersMm,
} from './underlayImage';

const SIZE = { width: 1600, height: 1200 };

function makeUnderlay(patch: Partial<Underlay> = {}): Underlay {
  return {
    imageDataUrl: 'data:image/jpeg;base64,xxx',
    opacity: 0.5,
    mmPerPixel: 5,
    offset: { x: -4000, y: -3000 },
    rotation: 0,
    locked: true,
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// 压缩相关（纯数学部分；canvas 编码在 node 里跑不了，只测策略）
// ---------------------------------------------------------------------------

describe('scaledSize', () => {
  it('长边缩到上限，等比', () => {
    expect(scaledSize(3200, 2400, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(scaledSize(2400, 3200, 1600)).toEqual({ width: 1200, height: 1600 });
  });

  it('小图不放大', () => {
    expect(scaledSize(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });

  it('结果是 ≥1 的整数', () => {
    const s = scaledSize(1001, 3, 100);
    expect(Number.isInteger(s.width)).toBe(true);
    expect(s.height).toBeGreaterThanOrEqual(1);
  });

  it('非法输入不崩', () => {
    expect(scaledSize(0, 0, 1600)).toEqual({ width: 1, height: 1 });
    expect(scaledSize(NaN, NaN, 1600)).toEqual({ width: 1, height: 1 });
  });
});

describe('compressionLadder', () => {
  it('先降质量后降尺寸，首档 = 长边上限 + quality 0.8', () => {
    const ladder = compressionLadder(4000, 3000);
    expect(ladder[0].size.width).toBe(UNDERLAY_MAX_LONG_EDGE);
    expect(ladder[0].quality).toBe(0.8);
    // 同一尺寸内质量递减
    expect(ladder[1].quality).toBeLessThan(ladder[0].quality);
    // 质量跑完后尺寸才变小
    const firstSmaller = ladder.find((a) => a.size.width < UNDERLAY_MAX_LONG_EDGE);
    expect(firstSmaller).toBeDefined();
    expect(ladder.indexOf(firstSmaller!)).toBe(4);
  });

  it('小图不会出现重复尺寸档位', () => {
    const ladder = compressionLadder(600, 400);
    const keys = ladder.map((a) => `${a.size.width}x${a.size.height}`);
    // 600×400 的长边小于 1600/1280/1024/800 三档 → 这几档尺寸相同，只保留一次
    expect(new Set(keys).size).toBeLessThan(keys.length / 2 + 1);
    expect(keys[0]).toBe('600x400');
  });
});

describe('isWithinUnderlayBudget', () => {
  it('1.5MB 以内通过，超出不通过', () => {
    expect(isWithinUnderlayBudget('data:image/jpeg;base64,' + 'A'.repeat(1000))).toBe(true);
    expect(isWithinUnderlayBudget('A'.repeat(UNDERLAY_MAX_DATA_URL_CHARS + 1))).toBe(false);
    expect(isWithinUnderlayBudget('A'.repeat(UNDERLAY_MAX_DATA_URL_CHARS))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 坐标数学
// ---------------------------------------------------------------------------

describe('imagePxToDoc / docToImagePx', () => {
  it('无旋转时就是缩放 + 平移', () => {
    const u = makeUnderlay();
    expect(imagePxToDoc(u, { x: 0, y: 0 })).toEqual({ x: -4000, y: -3000 });
    expect(imagePxToDoc(u, { x: 100, y: 200 })).toEqual({ x: -3500, y: -2000 });
  });

  it('带旋转时互为逆变换', () => {
    const u = makeUnderlay({ rotation: 37, mmPerPixel: 3.25 });
    for (const px of [
      { x: 0, y: 0 },
      { x: 1600, y: 1200 },
      { x: 123, y: -456 },
    ]) {
      const back = docToImagePx(u, imagePxToDoc(u, px));
      expect(back.x).toBeCloseTo(px.x, 6);
      expect(back.y).toBeCloseTo(px.y, 6);
    }
  });

  it('rotation 90° 顺时针（y 向下）', () => {
    const u = makeUnderlay({ rotation: 90, offset: { x: 0, y: 0 }, mmPerPixel: 1 });
    const p = imagePxToDoc(u, { x: 100, y: 0 });
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(100, 6);
  });
});

describe('underlayCornersMm / underlayCenterMm', () => {
  it('无旋转：四角就是包围盒', () => {
    const u = makeUnderlay({ offset: { x: 0, y: 0 }, mmPerPixel: 2 });
    expect(underlayCornersMm(u, SIZE)).toEqual([
      { x: 0, y: 0 },
      { x: 3200, y: 0 },
      { x: 3200, y: 2400 },
      { x: 0, y: 2400 },
    ]);
    expect(underlayCenterMm(u, SIZE)).toEqual({ x: 1600, y: 1200 });
  });

  it('旋转 90° 后仍有 4 个角，且中心到各角距离相同', () => {
    const u = makeUnderlay({ rotation: 90 });
    const c = underlayCenterMm(u, SIZE);
    const d = underlayCornersMm(u, SIZE).map((p) => Math.hypot(p.x - c.x, p.y - c.y));
    for (const v of d) expect(v).toBeCloseTo(d[0], 6);
  });
});

describe('offsetKeepingCenter', () => {
  it('改角度时中心不动（误差来自 offset 取整，<1mm）', () => {
    const u = makeUnderlay({ rotation: 0 });
    const before = underlayCenterMm(u, SIZE);
    const next = { ...u, rotation: 33, offset: offsetKeepingCenter(u, { rotation: 33 }, SIZE) };
    const after = underlayCenterMm(next, SIZE);
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
  });

  it('改比例时中心不动', () => {
    const u = makeUnderlay({ rotation: 12 });
    const before = underlayCenterMm(u, SIZE);
    const next = {
      ...u,
      mmPerPixel: 7.3,
      offset: offsetKeepingCenter(u, { mmPerPixel: 7.3 }, SIZE),
    };
    const after = underlayCenterMm(next, SIZE);
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
  });
});

describe('initialMmPerPixel / centeredOffset / createUnderlay', () => {
  it('图片宽度对应 9100mm', () => {
    expect(initialMmPerPixel(1600)).toBeCloseTo(UNDERLAY_TARGET_WIDTH_MM / 1600, 9);
    expect(initialMmPerPixel(0)).toBe(UNDERLAY_TARGET_WIDTH_MM);
  });

  it('居中放置：中心落在原点', () => {
    const mmPerPixel = initialMmPerPixel(SIZE.width);
    const offset = centeredOffset(SIZE, mmPerPixel);
    expect(offset.x).toBe(-Math.round(UNDERLAY_TARGET_WIDTH_MM / 2));
    const u = makeUnderlay({ mmPerPixel, offset, rotation: 0 });
    const c = underlayCenterMm(u, SIZE);
    // offset 取整 → 中心最多偏 0.5mm
    expect(Math.abs(c.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(c.y)).toBeLessThanOrEqual(0.5);
  });

  it('默认 opacity 0.5、locked、rotation 0，宽度 ≈ 9100mm', () => {
    const u = createUnderlay('data:image/jpeg;base64,zz', SIZE);
    expect(u.opacity).toBe(0.5);
    expect(u.locked).toBe(true);
    expect(u.rotation).toBe(0);
    expect(u.mmPerPixel * SIZE.width).toBeCloseTo(UNDERLAY_TARGET_WIDTH_MM, 6);
    expect(Number.isInteger(u.offset.x) && Number.isInteger(u.offset.y)).toBe(true);
  });

  it('更换图片时沿用原来的 opacity / locked', () => {
    const u = createUnderlay('data:image/jpeg;base64,zz', SIZE, { opacity: 0.9, locked: false });
    expect(u.opacity).toBe(0.9);
    expect(u.locked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 两点标定
// ---------------------------------------------------------------------------

/**
 * M5 回归：识别用的图**不能**被无谓地重编码一遍。
 *
 * 这不是「优化」而是正确性问题：几何的唯一来源是 OpenCV，多走一道 quality 0.8 的
 * JPEG 会让细内墙断掉，实测 test2 直接少提出 15.5 帖的 LDK 那一整块区域。
 * 这里用打桩的 FileReader / Image 把「小图原样透传」这条路钉死。
 */
describe('prepareRecognizeImage', () => {
  // loadImageElement 按 dataURL 缓存，所以每个用例得用不一样的串
  function stubBrowser(naturalWidth: number, naturalHeight: number, dataUrl: string) {
    const g = globalThis as Record<string, unknown>;
    const prev = { FileReader: g.FileReader, Image: g.Image };
    g.FileReader = class {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error: unknown = null;
      readAsDataURL() {
        this.result = dataUrl;
        queueMicrotask(() => this.onload?.());
      }
    };
    g.Image = class {
      naturalWidth = naturalWidth;
      naturalHeight = naturalHeight;
      width = naturalWidth;
      height = naturalHeight;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    };
    return () => {
      g.FileReader = prev.FileReader;
      g.Image = prev.Image;
    };
  }

  it('尺寸与体积都在预算内 → 原始字节原样透传，不重编码', async () => {
    const small = 'data:image/png;base64,SMALL';
    const restore = stubBrowser(500, 375, small);
    try {
      const { prepareRecognizeImage } = await import('./underlayImage');
      const out = await prepareRecognizeImage(new Blob(['x']));
      expect(out.dataUrl).toBe(small);
      expect(out.width).toBe(500);
      expect(out.height).toBe(375);
      expect(out.withinBudget).toBe(true);
    } finally {
      restore();
    }
  });

  it('长边超过上限 → 交给压缩阶梯（这里没有 canvas，所以只断言它确实走了那条路）', async () => {
    const restore = stubBrowser(UNDERLAY_MAX_LONG_EDGE + 1, 1000, 'data:image/png;base64,BIG');
    try {
      const { prepareRecognizeImage } = await import('./underlayImage');
      // node 环境没有 document/canvas，compressImageFile 必然抛错——正是我们要区分的分支
      await expect(prepareRecognizeImage(new Blob(['x']))).rejects.toBeTruthy();
    } finally {
      restore();
    }
  });
});

describe('calibrateUnderlay', () => {
  it('比例按「实际长度 / 当前量得长度」缩放', () => {
    const u = makeUnderlay(); // 5 mm/px
    // 图上量得 910mm，实际是 1820mm → 比例翻倍
    const res = calibrateUnderlay(u, { x: 0, y: 0 }, { x: 910, y: 0 }, 1820)!;
    expect(res.mmPerPixel).toBeCloseTo(10, 9);
  });

  it('标定后两点之间的实际长度精确等于输入值（误差 <1%）', () => {
    const u = makeUnderlay({ rotation: 17, mmPerPixel: 4.2 });
    const a = { x: -1234, y: 880 };
    const b = { x: 2100, y: 1750 };
    const real = 3640;
    const res = calibrateUnderlay(u, a, b, real)!;
    const next: Underlay = { ...u, ...res };

    // 两点在图片像素空间的位置（标定不改变它们对应的像素，只改比例）
    const pa = docToImagePx(u, a);
    const pb = docToImagePx(u, b);
    const lenMm = Math.hypot(pb.x - pa.x, pb.y - pa.y) * next.mmPerPixel;
    expect(Math.abs(lenMm - real) / real).toBeLessThan(0.01);
    expect(lenMm).toBeCloseTo(real, 6);
  });

  it('围绕两点中点保持位置：中点对应的图片像素不变（图不跳走）', () => {
    for (const rotation of [0, 25, -90]) {
      const u = makeUnderlay({ rotation, mmPerPixel: 6.5 });
      const a = { x: 100, y: -200 };
      const b = { x: 1500, y: 900 };
      const before = docToImagePx(u, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const res = calibrateUnderlay(u, a, b, 2730)!;
      const after = docToImagePx({ ...u, ...res }, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      // offset 取整带来的误差 <1px
      expect(after.x).toBeCloseTo(before.x, 0);
      expect(after.y).toBeCloseTo(before.y, 0);
    }
  });

  it('offset 保持整数 mm', () => {
    const res = calibrateUnderlay(makeUnderlay(), { x: 0, y: 0 }, { x: 777, y: 333 }, 1820)!;
    expect(Number.isInteger(res.offset.x)).toBe(true);
    expect(Number.isInteger(res.offset.y)).toBe(true);
  });

  it('两点重合 / 长度非法 → null', () => {
    const u = makeUnderlay();
    expect(calibrateUnderlay(u, { x: 5, y: 5 }, { x: 5, y: 5 }, 1820)).toBeNull();
    expect(calibrateUnderlay(u, { x: 0, y: 0 }, { x: 100, y: 0 }, 0)).toBeNull();
    expect(calibrateUnderlay(u, { x: 0, y: 0 }, { x: 100, y: 0 }, -5)).toBeNull();
    expect(calibrateUnderlay(u, { x: 0, y: 0 }, { x: 100, y: 0 }, NaN)).toBeNull();
  });
});
