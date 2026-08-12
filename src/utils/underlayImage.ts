/**
 * 底图（Milestone 2）：图片压缩、图片元素缓存，以及「图片像素 ↔ 文档 mm」的坐标数学。
 *
 * 坐标约定（本文件是唯一定义处，UnderlayLayer 的 Konva 属性与之一一对应）：
 *
 *   doc_mm = offset + R(rotation) · (mmPerPixel · img_px)
 *
 * 即 `offset` 是**图片左上角（像素 0,0）在文档里的 mm 坐标**，旋转绕这个锚点进行；
 * Konva 侧写成 `x/y = offset`、`scaleX/scaleY = mmPerPixel`、`rotation = rotation`。
 *
 * 架构决策（M2）：压缩后的 dataURL 若超过 UNDERLAY_MAX_DATA_URL_CHARS(≈1.5MB)，
 * 就按「降质量 → 降尺寸」的阶梯继续压，保证写进 localStorage 时不撑爆配额。
 *
 * 本文件不 import 任何 store：纯数学部分可以在 node 环境下直接单测，
 * 浏览器 API（canvas / Image / FileReader）只在函数体内使用。
 */
import type { Pt, Underlay } from '../model/types';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 上传后默认让图片宽度对应的实际尺寸（mm）——一个合理的初始猜测 */
export const UNDERLAY_TARGET_WIDTH_MM = 9100;
/** 降采样后的长边上限（px） */
export const UNDERLAY_MAX_LONG_EDGE = 1600;
/** dataURL 长度上限（字符 ≈ 字节）：1.5MB */
export const UNDERLAY_MAX_DATA_URL_CHARS = 1_500_000;
/** 默认透明度 */
export const UNDERLAY_DEFAULT_OPACITY = 0.5;
/** 标定面板默认长度：1 間 = 1820mm */
export const UNDERLAY_DEFAULT_KNOWN_MM = 1820;
/** 透明度可调区间 */
export const UNDERLAY_MIN_OPACITY = 0.1;
export const UNDERLAY_MAX_OPACITY = 1;

/** 压缩阶梯：先降质量，再降尺寸 */
export const UNDERLAY_EDGE_LADDER = [UNDERLAY_MAX_LONG_EDGE, 1280, 1024, 800, 640] as const;
export const UNDERLAY_QUALITY_LADDER = [0.8, 0.65, 0.5, 0.4] as const;

// ---------------------------------------------------------------------------
// 纯数学：尺寸与压缩阶梯
// ---------------------------------------------------------------------------

export interface PixelSize {
  width: number;
  height: number;
}

/** 等比缩到长边 ≤ maxEdge（不放大），结果为 ≥1 的整数 */
export function scaledSize(width: number, height: number, maxEdge: number): PixelSize {
  const w = Number.isFinite(width) ? width : 0;
  const h = Number.isFinite(height) ? height : 0;
  const long = Math.max(w, h);
  if (!(long > 0)) return { width: 1, height: 1 };
  if (!(maxEdge > 0) || long <= maxEdge) {
    return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
  }
  const k = maxEdge / long;
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

export interface CompressAttempt {
  size: PixelSize;
  quality: number;
}

/**
 * 由原始尺寸推出压缩尝试序列（尺寸相同的档位会合并，避免重复编码同一张画布）。
 * 顺序：同一尺寸下先把质量降完，再缩尺寸。
 */
export function compressionLadder(width: number, height: number): CompressAttempt[] {
  const out: CompressAttempt[] = [];
  const seen = new Set<string>();
  for (const edge of UNDERLAY_EDGE_LADDER) {
    const size = scaledSize(width, height, edge);
    const key = `${size.width}x${size.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const quality of UNDERLAY_QUALITY_LADDER) out.push({ size, quality });
  }
  return out;
}

/** dataURL 的存储成本（字符数≈字节数，localStorage 按字符计费） */
export function dataUrlChars(dataUrl: string): number {
  return dataUrl.length;
}

export function isWithinUnderlayBudget(dataUrl: string): boolean {
  return dataUrlChars(dataUrl) <= UNDERLAY_MAX_DATA_URL_CHARS;
}

// ---------------------------------------------------------------------------
// 纯数学：图片像素 ↔ 文档 mm
// ---------------------------------------------------------------------------

/** 绕原点旋转（度，顺时针为正，与屏幕 y 向下一致） */
function rotate(p: Pt, deg: number): Pt {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

/** 图片像素坐标 → 文档 mm */
export function imagePxToDoc(u: Underlay, px: Pt): Pt {
  const r = rotate({ x: px.x * u.mmPerPixel, y: px.y * u.mmPerPixel }, u.rotation);
  return { x: u.offset.x + r.x, y: u.offset.y + r.y };
}

/** 文档 mm → 图片像素坐标 */
export function docToImagePx(u: Underlay, p: Pt): Pt {
  const r = rotate({ x: p.x - u.offset.x, y: p.y - u.offset.y }, -u.rotation);
  return { x: r.x / u.mmPerPixel, y: r.y / u.mmPerPixel };
}

/** 底图四角（左上 → 右上 → 右下 → 左下）在文档里的 mm 坐标 */
export function underlayCornersMm(u: Underlay, size: PixelSize): Pt[] {
  const { width: w, height: h } = size;
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ].map((p) => imagePxToDoc(u, p));
}

/** 底图中心在文档里的 mm 坐标 */
export function underlayCenterMm(u: Underlay, size: PixelSize): Pt {
  return imagePxToDoc(u, { x: size.width / 2, y: size.height / 2 });
}

/**
 * 改 rotation / mmPerPixel 时保持**图片中心不动**所需的新 offset。
 * （offset 锚在左上角，直接改角度会让图跳走。）
 */
export function offsetKeepingCenter(
  u: Underlay,
  next: Partial<Pick<Underlay, 'rotation' | 'mmPerPixel'>>,
  size: PixelSize,
): Pt {
  const center = underlayCenterMm(u, size);
  const rotation = next.rotation ?? u.rotation;
  const mmPerPixel = next.mmPerPixel ?? u.mmPerPixel;
  const half = rotate(
    { x: (size.width / 2) * mmPerPixel, y: (size.height / 2) * mmPerPixel },
    rotation,
  );
  return { x: Math.round(center.x - half.x), y: Math.round(center.y - half.y) };
}

/** 上传后的初始比例：让图片宽度 ≈ targetWidthMm */
export function initialMmPerPixel(
  widthPx: number,
  targetWidthMm: number = UNDERLAY_TARGET_WIDTH_MM,
): number {
  if (!(widthPx > 0)) return targetWidthMm;
  return targetWidthMm / widthPx;
}

/** 让图片中心落在 center（默认原点）的 offset */
export function centeredOffset(size: PixelSize, mmPerPixel: number, center: Pt = { x: 0, y: 0 }): Pt {
  return {
    x: Math.round(center.x - (size.width * mmPerPixel) / 2),
    y: Math.round(center.y - (size.height * mmPerPixel) / 2),
  };
}

/** 上传（或更换图片）后的默认 Underlay：居中、opacity 0.5、locked */
export function createUnderlay(
  imageDataUrl: string,
  size: PixelSize,
  base?: Pick<Underlay, 'opacity' | 'locked'> | null,
): Underlay {
  const mmPerPixel = initialMmPerPixel(size.width);
  return {
    imageDataUrl,
    opacity: base ? base.opacity : UNDERLAY_DEFAULT_OPACITY,
    mmPerPixel,
    offset: centeredOffset(size, mmPerPixel),
    rotation: 0,
    locked: base ? base.locked : true,
  };
}

export interface CalibrationResult {
  mmPerPixel: number;
  offset: Pt;
}

/**
 * 两点标定：用户在底图上点出的两点 a、b（文档 mm，**不吸附网格**）实际长度为
 * realLengthMm，据此重算 mmPerPixel，并**围绕 a、b 的中点保持位置不动**。
 *
 * 推导：设 k = realLengthMm / |b-a|（即比例的放大倍数），新比例 s₁ = k·s₀。
 * 要让中点 M 对应的图片像素不变，需 offset₁ = M - k·(M - offset₀)
 * ——旋转矩阵与标量可交换，所以这个式子与 rotation 无关。
 *
 * 输入非法（两点重合 / 长度 ≤ 0）时返回 null。
 */
export function calibrateUnderlay(
  u: Underlay,
  a: Pt,
  b: Pt,
  realLengthMm: number,
): CalibrationResult | null {
  const dMm = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(dMm > 0) || !Number.isFinite(realLengthMm) || !(realLengthMm > 0)) return null;
  const k = realLengthMm / dMm;
  const mmPerPixel = u.mmPerPixel * k;
  if (!Number.isFinite(mmPerPixel) || !(mmPerPixel > 0)) return null;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return {
    mmPerPixel,
    offset: {
      x: Math.round(mid.x - k * (mid.x - u.offset.x)),
      y: Math.round(mid.y - k * (mid.y - u.offset.y)),
    },
  };
}

// ---------------------------------------------------------------------------
// 浏览器侧：图片加载与缓存
// ---------------------------------------------------------------------------

const imageCache = new Map<string, HTMLImageElement>();

/** 已加载过的图片元素（未加载返回 null，供同步取用） */
export function cachedImage(dataUrl: string | null | undefined): HTMLImageElement | null {
  if (!dataUrl) return null;
  return imageCache.get(dataUrl) ?? null;
}

/** 已加载过的图片像素尺寸（未加载返回 null）——fit / PNG 导出算包围盒时用 */
export function cachedImageSize(dataUrl: string | null | undefined): PixelSize | null {
  const img = cachedImage(dataUrl);
  if (!img) return null;
  return { width: img.naturalWidth, height: img.naturalHeight };
}

/** 加载图片元素（带缓存）。失败时 reject。 */
export function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
  const hit = imageCache.get(dataUrl);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      imageCache.set(dataUrl, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error('underlay image load failed'));
    img.src = dataUrl;
  });
}

// ---------------------------------------------------------------------------
// 浏览器侧：压缩
// ---------------------------------------------------------------------------

export interface CompressedImage extends PixelSize {
  dataUrl: string;
  /** dataURL 字符数 */
  chars: number;
  /** 是否已压到预算之内 */
  withinBudget: boolean;
}

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result;
      if (typeof r === 'string') resolve(r);
      else reject(new Error('unexpected FileReader result'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * 把用户选的图片压成 JPEG dataURL：
 * 长边 ≤1600px、quality 0.8 起步，PNG 透明区域垫白底；
 * 结果超过 1.5MB 就按 compressionLadder 继续降质量 / 降尺寸。
 */
export async function compressImageFile(file: Blob): Promise<CompressedImage> {
  const srcDataUrl = await readFileAsDataUrl(file);
  const img = await loadImageElement(srcDataUrl);
  const natural = {
    width: img.naturalWidth || img.width,
    height: img.naturalHeight || img.height,
  };
  if (!(natural.width > 0) || !(natural.height > 0)) {
    throw new Error('image has no intrinsic size');
  }

  const canvas = document.createElement('canvas');
  let drawnKey = '';
  let last: CompressedImage | null = null;

  for (const attempt of compressionLadder(natural.width, natural.height)) {
    const key = `${attempt.size.width}x${attempt.size.height}`;
    if (key !== drawnKey) {
      canvas.width = attempt.size.width;
      canvas.height = attempt.size.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas 2d context unavailable');
      // PNG / 带透明通道的图转 JPEG 时透明区域会变黑，先垫白底
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, attempt.size.width, attempt.size.height);
      ctx.drawImage(img, 0, 0, attempt.size.width, attempt.size.height);
      drawnKey = key;
    }
    const dataUrl = canvas.toDataURL('image/jpeg', attempt.quality);
    const out: CompressedImage = {
      dataUrl,
      width: attempt.size.width,
      height: attempt.size.height,
      chars: dataUrlChars(dataUrl),
      withinBudget: isWithinUnderlayBudget(dataUrl),
    };
    if (out.withinBudget) return out;
    last = out;
  }

  if (!last) throw new Error('compression produced no output');
  return last;
}

/**
 * M5：**给识别用**的图片准备。与底图上传的区别是「能不重编码就不重编码」。
 *
 * 原因是 M5 把几何的唯一来源交给了 OpenCV：多一道 JPEG 有损重编码，墙线上就会多一圈
 * 振铃噪声，细内墙断掉一两个像素，整块房间就连通到隔壁去了。
 * 实测 test2.jpg（500×375、25KB）：直接用原始字节能提出 **8 块区域**（含 15.5 帖的 LDK）；
 * 经 `compressImageFile` 走一遍 canvas + quality 0.8 之后变成 **11 块碎区域，
 * 而且最大的那块 LDK 整个消失了**——识别结果里直接少一个房间。
 *
 * 所以：尺寸本来就在阈值内、体积也在预算内的图**原样送走**（绝大多数間取り图都是这一类）；
 * 只有确实过大的才走压缩阶梯。
 */
export async function prepareRecognizeImage(file: Blob): Promise<CompressedImage> {
  const srcDataUrl = await readFileAsDataUrl(file);
  try {
    const img = await loadImageElement(srcDataUrl);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (
      width > 0 &&
      height > 0 &&
      Math.max(width, height) <= UNDERLAY_MAX_LONG_EDGE &&
      isWithinUnderlayBudget(srcDataUrl)
    ) {
      return {
        dataUrl: srcDataUrl,
        width,
        height,
        chars: dataUrlChars(srcDataUrl),
        withinBudget: true,
      };
    }
  } catch {
    /* 加载失败就交给 compressImageFile 去报错 */
  }
  return compressImageFile(file);
}
