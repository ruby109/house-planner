/**
 * 二值化 + deskew（见 docs/CV-PIPELINE.md 第 2 节第 1 步）。
 *
 * ## 为什么不是「clean 用近黑固定阈值」
 *
 * 规格原本写的是 clean 模式用近黑固定阈值。实测五张日式間取り图后改成了
 * **自适应阈值为主 + 近黑兜底**：
 *
 * - 外墙在这类图上是**灰色带阴影线的色带**（灰度 150~210），不是黑的；
 * - 内墙是**两条极淡的细线**（JPEG 压到 500px 宽后灰度只有 200~235）；
 * - 房间底色又常是米色（灰度 225~240），比内墙线还深。
 *
 * 任何全局阈值都没法同时「抓住淡内墙」和「放过米色房间底」。`adaptiveThreshold`
 * 正好对付这个：大片均匀底色局部对比度为 0 → 判背景；细线比周围亮底暗 → 判前景。
 * 再 OR 一层「近黑」保证实心黑块（设备图例、粗外墙）一定进来。
 *
 * mode 仍然按规格区分：`clean`（有大片纯白背景的电子稿）用较保守的参数，
 * `photo`（翻拍/扫描，没有纯白峰）用更大的 block 和更低的 C。
 */
import type { CvModule, Mat } from './cvRuntime';
import { MatScope, toOdd } from './cvRuntime';
import type { BinarizeMode } from './types';

export interface BinarizeOptions {
  /** 关掉 deskew（单测/调参用） */
  deskew?: boolean;
  /** deskew 最大校正角，超过就认为主方向判错了，不转 */
  maxDeskewDeg?: number;
  /** 强制模式（默认自动判定） */
  mode?: BinarizeMode;
  /** 关掉「只保留线稿区域」的预筛（默认开启） */
  restrictToDrawing?: boolean;
}

export interface BinarizeResult {
  /** 8UC1 灰度（已 deskew） */
  gray: Mat;
  /** 8UC1 二值，255 = 墨迹（已 deskew） */
  bin: Mat;
  mode: BinarizeMode;
  deskewDeg: number;
  /** 线稿区域占比（< 1 表示识别出了照片/色块，多半是拼版广告图） */
  drawingFrac: number;
  warnings: string[];
}

/** 直方图统计（模式判定用） */
export interface HistogramStats {
  /** 灰度 ≥ 235 的比例 */
  whiteFrac: number;
  /** 灰度 ≤ 100 的比例 */
  inkFrac: number;
  /** 90 分位灰度 */
  p90: number;
}

export function grayHistogramStats(gray: Mat): HistogramStats {
  const data = gray.data;
  const hist = new Int32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  const total = data.length || 1;

  let white = 0;
  for (let i = 235; i < 256; i++) white += hist[i];
  let ink = 0;
  for (let i = 0; i <= 100; i++) ink += hist[i];

  let acc = 0;
  let p90 = 255;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc / total >= 0.9) {
      p90 = i;
      break;
    }
  }

  return { whiteFrac: white / total, inkFrac: ink / total, p90 };
}

/**
 * 模式判定。
 * 判据是「有没有一大片**纯白**纸底」：电子稿的 p90 会顶到 250 左右，
 * 翻拍件因为光照不均，纸底会散在 200~235，p90 上不去。
 */
export function detectMode(stats: HistogramStats): BinarizeMode {
  return stats.p90 >= 238 && stats.whiteFrac >= 0.12 ? 'clean' : 'photo';
}

/**
 * 估计整图的倾斜角：对二值图跑 `HoughLines`，取所有直线与最近轴的偏差的中位数。
 * 只在 ±`maxDeg` 内才认，超了就当没倾斜（多半是斜墙/装饰线主导）。
 */
export function estimateSkewDeg(cv: CvModule, bin: Mat, maxDeg: number): number {
  const scope = new MatScope();
  try {
    const lines = scope.keep(new cv.Mat());
    const threshold = Math.max(40, Math.round(Math.min(bin.cols, bin.rows) * 0.25));
    cv.HoughLines(bin, lines, 1, Math.PI / 720, threshold, 0, 0);

    // opencv.js 的 HoughLines 同样返回 1×N 的 CV_32FC2
    const devs: number[] = [];
    const d = lines.data32F;
    for (let i = 0; i + 1 < d.length; i += 2) {
      const theta = d[i + 1];
      let deg = (theta * 180) / Math.PI; // 0..180，法线方向
      deg = ((deg % 90) + 90) % 90;
      const dev = deg > 45 ? deg - 90 : deg;
      if (Math.abs(dev) <= maxDeg) devs.push(dev);
    }
    if (devs.length < 4) return 0;
    devs.sort((a, b) => a - b);
    const mid = devs[Math.floor(devs.length / 2)];
    return Math.abs(mid) < 0.15 ? 0 : mid;
  } finally {
    scope.dispose();
  }
}

/**
 * 「图纸区域」掩膜（整版广告图的救命稻草，见 docs/CV-PIPELINE.md 第 7 节）。
 *
 * 把图切成小块，逐块判断是**线稿**还是**照片/色块**：
 * - 线稿：底是白的（亮像素占比高）且几乎没有彩度（间取り图只有黑线 + 米色地板）；
 * - 照片 / 深色横幅 / 二维码：要么暗，要么彩度高。
 *
 * 不这么先筛一道的话，广告图里的照片会把「墙笔画宽」的估计整个带跑
 * （照片二值化后是大片实心块，distanceTransform 值比墙大一个量级），
 * 后面的形态学 kernel 全部失准。对干净图这一步基本是空操作。
 */
/** 照片区域占比低于它就认为「这不是拼版广告图」，整个预筛跳过 */
export const PHOTO_AREA_MIN_FRAC = 0.18;

export function drawingRegionMask(
  cv: CvModule,
  rgba: Uint8ClampedArray,
  bin: Mat,
  width: number,
  height: number,
): { mask: Mat; drawingFrac: number } {
  const binData = bin.data;
  // 块要够大：小到一整块都落在墙带里，就会把墙自己当成「照片」剔掉
  const block = Math.max(8, Math.round(Math.min(width, height) / 24));
  const cols = Math.ceil(width / block);
  const rows = Math.ceil(height / block);
  const flags = new Uint8Array(cols * rows);

  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const x0 = bx * block;
      const y0 = by * block;
      const x1 = Math.min(width, x0 + block);
      const y1 = Math.min(height, y0 + block);
      let count = 0;
      let bright = 0;
      let satSum = 0;
      let ink = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = y * width + x;
          const i = p * 4;
          const r = rgba[i];
          const g = rgba[i + 1];
          const b = rgba[i + 2];
          const gray = 0.299 * r + 0.587 * g + 0.114 * b;
          if (gray >= 200) bright++;
          if (binData[p]) ink++;
          satSum += Math.max(r, g, b) - Math.min(r, g, b);
          count++;
        }
      }
      if (count === 0) continue;
      // 判「照片」而不是判「线稿」：只有明确不像线稿的块才排除，宁松勿紧。
      // 三条判据分别对应「暗」「花」「糊」——最后一条（墨迹占比）专治灰调城市照片：
      // 线稿再密，墨迹也只占一成多；照片二值化后满屏都是。
      const isPhoto = bright / count < 0.35 || satSum / count > 45 || ink / count > 0.32;
      flags[by * cols + bx] = isPhoto ? 255 : 0;
    }
  }

  const photo = new cv.Mat(rows, cols, cv.CV_8UC1);
  photo.data.set(flags);
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  // 先开：孤立的暗块（密集家具图例、粗外墙）不算照片，得留下
  cv.morphologyEx(photo, photo, cv.MORPH_OPEN, kernel);
  // 再闭：照片里偶尔冒出的亮块不该把照片区割碎
  cv.morphologyEx(photo, photo, cv.MORPH_CLOSE, kernel);
  kernel.delete();

  let drawingBlocks = 0;
  for (let i = 0; i < photo.data.length; i++) if (!photo.data[i]) drawingBlocks++;

  // 只有「确实是拼版广告图」才动手。干净的间取り图上零星几块误判（密集设备图例、
  // 粗外墙）如果照剔不误，反而会把墙掏出缺口，得不偿失。
  const photoFrac = 1 - drawingBlocks / Math.max(1, cols * rows);
  if (photoFrac < PHOTO_AREA_MIN_FRAC) {
    photo.delete();
    const full = new cv.Mat(height, width, cv.CV_8UC1);
    full.data.fill(255);
    return { mask: full, drawingFrac: 1 };
  }

  const small = new cv.Mat();
  cv.bitwise_not(photo, small);
  photo.delete();
  const mask = new cv.Mat();
  cv.resize(small, mask, new cv.Size(width, height), 0, 0, cv.INTER_NEAREST);
  small.delete();
  return { mask, drawingFrac: drawingBlocks / Math.max(1, cols * rows) };
}

/** 绕图心旋转（白底填充，避免边缘出现黑框被当成墙） */
function rotate(cv: CvModule, src: Mat, deg: number, borderValue: number): Mat {
  const center = new cv.Point(src.cols / 2, src.rows / 2);
  const m = new cv.Mat();
  const rot = cv.getRotationMatrix2D(center, -deg, 1);
  const size = new cv.Size(src.cols, src.rows);
  cv.warpAffine(
    src,
    m,
    rot,
    size,
    cv.INTER_NEAREST,
    cv.BORDER_CONSTANT,
    new cv.Scalar(borderValue, borderValue, borderValue, 255),
  );
  rot.delete();
  return m;
}

/**
 * RGBA → 灰度 → 二值（255 = 墨迹）→ deskew。
 * 返回的 `gray` / `bin` 由调用方负责 delete。
 */
export function binarize(
  cv: CvModule,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  opts: BinarizeOptions = {},
): BinarizeResult {
  const warnings: string[] = [];
  const scope = new MatScope();

  try {
    const src = scope.keep(new cv.Mat(height, width, cv.CV_8UC4));
    src.data.set(rgba);
    let gray = scope.keep(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    const stats = grayHistogramStats(gray);
    const mode = opts.mode ?? detectMode(stats);

    const minSide = Math.min(width, height);
    // block 太小会把粗墙的内部当背景挖空，太大又抓不住淡线
    const block = toOdd(Math.max(11, Math.min(41, Math.round(minSide / 22))));
    const c = mode === 'clean' ? 6 : 4;

    let bin = scope.keep(new cv.Mat());
    cv.adaptiveThreshold(gray, bin, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, block, c);

    // 近黑兜底：实心黑块内部局部对比度为 0，自适应会把它挖空
    const dark = scope.keep(new cv.Mat());
    cv.threshold(gray, dark, mode === 'clean' ? 110 : 90, 255, cv.THRESH_BINARY_INV);
    cv.bitwise_or(bin, dark, bin);

    // 去掉椒盐噪点（JPEG 块效应在自适应阈值下会冒出孤立点）
    const denoise = scope.keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2)));
    cv.morphologyEx(bin, bin, cv.MORPH_OPEN, denoise);

    // 只保留「线稿区域」：广告图的照片 / 深色横幅 / 二维码全部清零
    let drawingFrac = 1;
    if (opts.restrictToDrawing !== false) {
      const region = drawingRegionMask(cv, rgba, bin, width, height);
      scope.keep(region.mask);
      cv.bitwise_and(bin, region.mask, bin);
      drawingFrac = region.drawingFrac;
      if (region.drawingFrac < 0.9) {
        warnings.push(`图上约 ${Math.round((1 - region.drawingFrac) * 100)}% 的面积是照片/色块，已排除在墙体提取之外`);
      }
    }

    let deskewDeg = 0;
    if (opts.deskew !== false) {
      const maxDeg = opts.maxDeskewDeg ?? 5;
      deskewDeg = estimateSkewDeg(cv, bin, maxDeg);
      if (deskewDeg !== 0) {
        const rotatedGray = rotate(cv, gray, deskewDeg, 255);
        const rotatedBin = rotate(cv, bin, deskewDeg, 0);
        scope.keep(rotatedGray);
        scope.keep(rotatedBin);
        gray = rotatedGray;
        bin = rotatedBin;
        warnings.push(`整图倾斜约 ${deskewDeg.toFixed(2)}°，已自动校正`);
      }
    }

    scope.release(gray);
    scope.release(bin);
    return { gray, bin, mode, deskewDeg, drawingFrac, warnings };
  } finally {
    scope.dispose();
  }
}
