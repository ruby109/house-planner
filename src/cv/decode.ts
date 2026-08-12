/**
 * 图片解码 / 编码（纯 JS，不引原生依赖）。
 *
 * - JPEG：jpeg-js
 * - PNG：pngjs
 *
 * 统一输出 RGBA。**不做压缩**：CV 精度直接受分辨率影响，压缩留给调用方
 * （`extractGeometry` 内部有 `maxSidePx` 的降采样兜底，并会把坐标换算回原图尺度）。
 */
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

export interface DecodedImage {
  /** RGBA，长度 = width × height × 4 */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
  return true;
}

/** 按文件头判定格式（不看扩展名）；无法识别时抛错 */
export function decodeImage(bytes: Uint8Array): DecodedImage {
  if (startsWith(bytes, PNG_MAGIC)) {
    const png = PNG.sync.read(bytes);
    return { data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), width: png.width, height: png.height };
  }
  if (startsWith(bytes, JPEG_MAGIC)) {
    const raw = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, tolerantDecoding: true });
    return { data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.length), width: raw.width, height: raw.height };
  }
  throw new Error('只支持 PNG / JPEG（按文件头判定），无法识别这张图的格式');
}

/** RGBA → PNG 字节流（debug 输出用） */
export function encodePng(data: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.length);
  return PNG.sync.write({ width, height, data: bytes });
}
