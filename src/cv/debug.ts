/**
 * 过程可视化（验收工具，见 docs/CV-PIPELINE.md 第 4 节）。
 *
 * - `renderOverlay`：原图 + 红色墙段（线宽 = 厚度）+ 房间多边形半透明填色 + 蓝色文字块框
 * - `renderSteps`：二值化 / wallMask / 骨架三张 mask 横向拼一张
 *
 * 只产出 RGBA 缓冲区，PNG 编码交给 `decode.ts` 的 `encodePng`。
 */
import type { CvModule } from './cvRuntime';
import { MatScope } from './cvRuntime';
import type { CvDebugMasks, CvExtract, PxPoint } from './types';

export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const WALL_COLOR: [number, number, number] = [214, 40, 40];
const ROOM_COLOR: [number, number, number] = [74, 111, 165];
const TEXT_COLOR: [number, number, number] = [30, 100, 220];
/** M4.1：被剔除的虚线链 / 细线框（黄框，与文字块的蓝框区分） */
const DASH_COLOR: [number, number, number] = [235, 180, 20];
/** M5：洞口候选（外墙 = 亮绿 → 窗，内墙 = 深绿 → 门） */
const OPENING_EXTERIOR_COLOR: [number, number, number] = [40, 210, 90];
const OPENING_INTERIOR_COLOR: [number, number, number] = [20, 120, 60];
/** M5：柱候选（紫框） */
const COLUMN_COLOR: [number, number, number] = [150, 60, 220];
/** M5.1：建筑轮廓外被剔除的墙段（品红框，与柱的紫框区分） */
const OUTSIDE_COLOR: [number, number, number] = [255, 0, 160];
const ROOM_ALPHA = 0.28;

/**
 * 叠加图。墙段线宽直接用 `thicknessPx`，一眼就能看出厚度回填对不对。
 */
export function renderOverlay(cv: CvModule, base: RgbaImage, extract: CvExtract): RgbaImage {
  const scope = new MatScope();
  try {
    const img = scope.keep(new cv.Mat(base.height, base.width, cv.CV_8UC4));
    img.data.set(base.data);

    // --- 房间：先在副本上实心填充，再整体 alpha 混合 ---
    if (extract.rooms.length > 0) {
      const layer = scope.keep(img.clone());
      for (const room of extract.rooms) {
        const pts = scope.keep(polygonMat(cv, room.polygon));
        const vec = scope.keep(new cv.MatVector());
        vec.push_back(pts);
        cv.fillPoly(layer, vec, new cv.Scalar(ROOM_COLOR[0], ROOM_COLOR[1], ROOM_COLOR[2], 255));
      }
      cv.addWeighted(layer, ROOM_ALPHA, img, 1 - ROOM_ALPHA, 0, img);

      for (const room of extract.rooms) {
        const pts = scope.keep(polygonMat(cv, room.polygon));
        const vec = scope.keep(new cv.MatVector());
        vec.push_back(pts);
        cv.polylines(img, vec, true, new cv.Scalar(ROOM_COLOR[0], ROOM_COLOR[1], ROOM_COLOR[2], 255), 1);
      }
    }

    // --- 文字块：蓝框 ---
    for (const b of extract.textBoxes) {
      cv.rectangle(
        img,
        new cv.Point(b.x, b.y),
        new cv.Point(b.x + b.w, b.y + b.h),
        new cv.Scalar(TEXT_COLOR[0], TEXT_COLOR[1], TEXT_COLOR[2], 255),
        1,
      );
    }

    // --- 虚线链 / 细线框：黄框 ---
    for (const b of extract.dashBoxes ?? []) {
      cv.rectangle(
        img,
        new cv.Point(Math.round(b.x) - 1, Math.round(b.y) - 1),
        new cv.Point(Math.round(b.x + b.w) + 1, Math.round(b.y + b.h) + 1),
        new cv.Scalar(DASH_COLOR[0], DASH_COLOR[1], DASH_COLOR[2], 255),
        1,
      );
    }

    // --- M5.1 建筑轮廓外被剔除的墙段：品红框 ---
    for (const b of extract.outsideBoxes ?? []) {
      cv.rectangle(
        img,
        new cv.Point(Math.round(b.x) - 2, Math.round(b.y) - 2),
        new cv.Point(Math.round(b.x + b.w) + 2, Math.round(b.y + b.h) + 2),
        new cv.Scalar(OUTSIDE_COLOR[0], OUTSIDE_COLOR[1], OUTSIDE_COLOR[2], 255),
        1,
      );
    }

    // --- M5 洞口候选：绿线（外墙=亮绿/窗，内墙=深绿/门），压在墙线之下画 ---
    for (const o of extract.openings ?? []) {
      const color = o.exterior ? OPENING_EXTERIOR_COLOR : OPENING_INTERIOR_COLOR;
      cv.line(
        img,
        new cv.Point(Math.round(o.x1), Math.round(o.y1)),
        new cv.Point(Math.round(o.x2), Math.round(o.y2)),
        new cv.Scalar(color[0], color[1], color[2], 255),
        3,
      );
    }

    // --- M5 柱候选：紫框 ---
    for (const c of extract.columns ?? []) {
      cv.rectangle(
        img,
        new cv.Point(Math.round(c.x - c.wPx / 2) - 1, Math.round(c.y - c.hPx / 2) - 1),
        new cv.Point(Math.round(c.x + c.wPx / 2) + 1, Math.round(c.y + c.hPx / 2) + 1),
        new cv.Scalar(COLUMN_COLOR[0], COLUMN_COLOR[1], COLUMN_COLOR[2], 255),
        2,
      );
    }

    // --- 墙段：红线，线宽 = 厚度 ---
    for (const w of extract.walls) {
      const t = Math.max(1, Math.round(w.thicknessPx));
      cv.line(
        img,
        new cv.Point(Math.round(w.x1), Math.round(w.y1)),
        new cv.Point(Math.round(w.x2), Math.round(w.y2)),
        new cv.Scalar(WALL_COLOR[0], WALL_COLOR[1], WALL_COLOR[2], 255),
        t,
      );
      // 端点标记，方便看接点闭合得怎么样
      cv.circle(img, new cv.Point(Math.round(w.x1), Math.round(w.y1)), 2, new cv.Scalar(20, 20, 20, 255), -1);
      cv.circle(img, new cv.Point(Math.round(w.x2), Math.round(w.y2)), 2, new cv.Scalar(20, 20, 20, 255), -1);
    }

    return { data: new Uint8ClampedArray(img.data), width: base.width, height: base.height };
  } finally {
    scope.dispose();
  }
}

function polygonMat(cv: CvModule, polygon: readonly PxPoint[]) {
  const flat: number[] = [];
  for (const p of polygon) flat.push(Math.round(p.x), Math.round(p.y));
  return cv.matFromArray(polygon.length, 1, cv.CV_32SC2, flat);
}

/** 0/255 mask → RGBA（白底 + 指定颜色的前景） */
export function maskToRgba(mask: Uint8Array, width: number, height: number, color: [number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const on = mask[i] !== 0;
    data[i * 4] = on ? color[0] : 255;
    data[i * 4 + 1] = on ? color[1] : 255;
    data[i * 4 + 2] = on ? color[2] : 255;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

/** 横向拼图（高度取最大值，空白填浅灰） */
export function tileHorizontal(images: readonly RgbaImage[], gap = 8): RgbaImage {
  const width = images.reduce((s, im) => s + im.width, 0) + gap * Math.max(0, images.length - 1);
  const height = images.reduce((h, im) => Math.max(h, im.height), 0);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = 226;
    data[i * 4 + 1] = 230;
    data[i * 4 + 2] = 236;
    data[i * 4 + 3] = 255;
  }
  let ox = 0;
  for (const im of images) {
    for (let y = 0; y < im.height; y++) {
      const srcRow = y * im.width * 4;
      const dstRow = (y * width + ox) * 4;
      data.set(im.data.subarray(srcRow, srcRow + im.width * 4), dstRow);
    }
    ox += im.width + gap;
  }
  return { data, width, height };
}

/** 二值化 / wallMask / 骨架 / 封洞 / 建筑轮廓（M5.1）五步拼一张 */
export function renderSteps(masks: CvDebugMasks): RgbaImage {
  const tiles: RgbaImage[] = [
    maskToRgba(masks.binary, masks.width, masks.height, [40, 40, 40]),
    maskToRgba(masks.wallMask, masks.width, masks.height, [30, 90, 160]),
    maskToRgba(masks.skeleton, masks.width, masks.height, [200, 30, 30]),
    maskToRgba(masks.sealed, masks.width, masks.height, [40, 140, 60]),
  ];
  if (masks.outline) {
    tiles.push(maskToRgba(masks.outline, masks.width, masks.height, OUTSIDE_COLOR));
  }
  return tileHorizontal(tiles);
}
