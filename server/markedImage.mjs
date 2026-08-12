/**
 * M5：**编号标记图**（见 docs/CV-PIPELINE.md 第 7 节）。
 *
 * 在原图上给每一块 CV 房间画一个「白底黑字」的序号圆标，交给 AI 做标注：
 * AI 只需要回答「几号房间叫什么」，一个坐标都不用给。
 *
 * ## opencv.js 的绘制 API 到底有没有？
 *
 * 实测 `@techstark/opencv-js` 5.0（默认 WASM 构建）：
 *   - `putText` / `circle` / `rectangle` / `line` / `fillPoly` / `cvtColor` / `resize` ✅
 *   - `getTextSize` ❌、`imencode` ❌
 *
 * 所以：**能画**（走标记图这条主路），但
 *   - 文字尺寸只能**按 Hershey 字体的固有度量估算**（见 `HERSHEY_*` 常量）；
 *   - PNG 编码走项目里现成的 pngjs（`src/cv/decode.ts` 的 `encodePng`）。
 *
 * 万一将来换构建、`putText` 没了，`buildMarkedImage()` 会返回 `null`，
 * 调用方自动退化到 `roomListText()` 的**文字清单**路径（编号 + 归一化重心 + bbox）。
 * 两条路都在，任何一条断了都不会让整个管线挂掉。
 */
import './tsHooks.mjs';

/**
 * HERSHEY_SIMPLEX 在 fontScale=1 时的固有度量（数字字形）：
 * 每个字符的步进宽 ≈ 20px、大写/数字的字高 ≈ 21px。
 * `getTextSize` 不可用，只能靠这两个常数反推 fontScale 与居中偏移。
 */
const HERSHEY_ADVANCE = 20;
const HERSHEY_CAP_HEIGHT = 21;

/** 标记图的目标宽度：源图太小时先放大，圆标和数字才看得清 */
const MARK_TARGET_WIDTH = 1400;
/** 放大倍率上限（再大只是糊，白白撑 token） */
const MARK_MAX_UPSCALE = 3;
/** 圆标半径相对图宽的比例 / 绝对下限上限（px，标记图尺度） */
const MARK_RADIUS_FRAC = 0.021;
const MARK_RADIUS_MIN = 11;
const MARK_RADIUS_MAX = 34;

/** @type {Promise<any> | null} */
let modulesPromise = null;

function loadModules() {
  if (!modulesPromise) {
    modulesPromise = (async () => ({
      decode: await import('../src/cv/decode.ts'),
      anchor: await import('../src/cv/anchor.ts'),
      cvRuntime: await import('../src/cv/cvRuntime.ts'),
    }))();
  }
  return modulesPromise;
}

/**
 * 每块 CV 房间的编号锚点（原图像素 + 归一化），文字清单与标记图共用。
 *
 * @param {import('../src/cv/types.ts').CvExtract} extract
 * @returns {Promise<Array<{ index: number, x: number, y: number, spanPx: number,
 *   bounds: {x0:number,y0:number,x1:number,y1:number}, areaPx: number }>>}
 */
export async function roomAnchors(extract) {
  const { anchor } = await loadModules();
  return extract.rooms.map((room, i) => {
    const a = anchor.roomLabelAnchor(room.polygon);
    return {
      index: i + 1,
      x: a.x,
      y: a.y,
      spanPx: a.spanPx,
      bounds: anchor.polyBounds(room.polygon),
      areaPx: room.areaPx,
    };
  });
}

/**
 * 退化路径：把编号 + 位置写成一段**文字清单**塞进 prompt。
 *
 * 坐标按「两轴各自独立归一化到 0~1000」给（与 M3 的 prompt 约定一致，
 * 模型对这一套最熟）。面积用「占全图的千分比」表达，比像素数直观。
 *
 * @param {import('../src/cv/types.ts').CvExtract} extract
 */
export async function roomListText(extract) {
  const anchors = await roomAnchors(extract);
  const w = Math.max(1, extract.stats.imageWidthPx);
  const h = Math.max(1, extract.stats.imageHeightPx);
  const nx = (v) => Math.round((v / w) * 1000);
  const ny = (v) => Math.round((v / h) * 1000);
  const lines = anchors.map((a) => {
    const b = a.bounds;
    return (
      `${a.index}号：中心 (x=${nx(a.x)}, y=${ny(a.y)})，` +
      `范围 x ${nx(b.x0)}~${nx(b.x1)} / y ${ny(b.y0)}~${ny(b.y1)}，` +
      `占图面积 ${(a.areaPx / (w * h) * 100).toFixed(1)}%`
    );
  });
  return lines.join('\n');
}

/** opencv.js 这套构建到底能不能画字（`buildMarkedImage` 的前置条件） */
export async function canDrawMarks() {
  try {
    const { cvRuntime } = await loadModules();
    const cv = await cvRuntime.ensureCv();
    return typeof cv.putText === 'function' && typeof cv.circle === 'function';
  } catch {
    return false;
  }
}

/**
 * 生成编号标记图。
 *
 * @param {string} base64 原图 base64（不带 data URL 前缀）
 * @param {import('../src/cv/types.ts').CvExtract} extract
 * @returns {Promise<{ base64: string, mediaType: string, width: number, height: number, scale: number } | null>}
 *   `null` = 这套 opencv 构建画不了（调用方退化到 `roomListText`）
 */
export async function buildMarkedImage(base64, extract) {
  const { decode, cvRuntime, anchor } = await loadModules();
  const cv = await cvRuntime.ensureCv();
  if (typeof cv.putText !== 'function' || typeof cv.circle !== 'function') return null;
  if (extract.rooms.length === 0) return null;

  const image = decode.decodeImage(Buffer.from(base64, 'base64'));
  const scale = Math.min(
    MARK_MAX_UPSCALE,
    Math.max(1, MARK_TARGET_WIDTH / Math.max(1, image.width)),
  );
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const scope = new cvRuntime.MatScope();
  try {
    const src = scope.keep(new cv.Mat(image.height, image.width, cv.CV_8UC4));
    src.data.set(image.data);

    let canvas = src;
    if (scale !== 1) {
      const resized = scope.keep(new cv.Mat());
      cv.resize(src, resized, new cv.Size(width, height), 0, 0, cv.INTER_CUBIC);
      canvas = resized;
    }

    const white = new cv.Scalar(255, 255, 255, 255);
    const black = new cv.Scalar(0, 0, 0, 255);
    const baseRadius = Math.round(
      Math.min(MARK_RADIUS_MAX, Math.max(MARK_RADIUS_MIN, width * MARK_RADIUS_FRAC)),
    );

    for (let i = 0; i < extract.rooms.length; i++) {
      const a = anchor.roomLabelAnchor(extract.rooms[i].polygon);
      const cx = Math.round(a.x * scale);
      const cy = Math.round(a.y * scale);
      const label = String(i + 1);

      // 细长走廊里别画一个把墙盖住的大圆：半径跟着「这一横排有多宽」收
      const radius = Math.max(
        MARK_RADIUS_MIN,
        Math.min(baseRadius, Math.round((a.spanPx * scale) / 2.2) || baseRadius),
      );

      // 白底 + 黑边圆（黑边是为了在浅色底图上也能看出边界）
      cv.circle(canvas, new cv.Point(cx, cy), radius, white, -1);
      cv.circle(canvas, new cv.Point(cx, cy), radius, black, Math.max(1, Math.round(radius / 8)));

      // 字号：让整串数字的宽度 ≈ 1.5 个半径，同时字高不超过 1.2 个半径
      const byWidth = (radius * 1.5) / (label.length * HERSHEY_ADVANCE);
      const byHeight = (radius * 1.2) / HERSHEY_CAP_HEIGHT;
      const fontScale = Math.max(0.3, Math.min(byWidth, byHeight));
      const thickness = Math.max(1, Math.round(fontScale * 2.2));
      const textW = label.length * HERSHEY_ADVANCE * fontScale;
      const textH = HERSHEY_CAP_HEIGHT * fontScale;
      cv.putText(
        canvas,
        label,
        // putText 的锚点是**基线左端**，所以要自己把宽高折半挪回中心
        new cv.Point(Math.round(cx - textW / 2), Math.round(cy + textH / 2)),
        cv.FONT_HERSHEY_SIMPLEX,
        fontScale,
        black,
        thickness,
        cv.LINE_AA ?? 16,
      );
    }

    const rgba = new Uint8Array(canvas.data);
    const png = decode.encodePng(rgba, width, height);
    return {
      base64: Buffer.from(png).toString('base64'),
      mediaType: 'image/png',
      width,
      height,
      scale,
    };
  } finally {
    scope.dispose();
  }
}
