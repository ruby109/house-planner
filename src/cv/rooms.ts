/**
 * 房间提取（见 docs/CV-PIPELINE.md 第 2 节第 5 步）。
 *
 * 规格写的是「cornerHarris 找端点沿轴补线封门洞」。这里改成**直接用已经提取好的墙段**
 * 来封洞：墙段的端点本来就是精确的角点，比在 mask 上重新找角点稳得多，也不用调
 * Harris 的一堆参数。两种封洞方式：
 *
 * 1. **共线缺口**：两段近乎共线、面对面的端点相距小于一个门宽 → 直接架桥（门洞/引き戸）；
 * 2. **悬空端点**：端点顺着自己的方向往前打一条射线，撞到别的墙就补上（隔墙没画到头）。
 *
 * 封好之后取反 → `connectedComponents` → 面积过滤 → `findContours + approxPolyDP`。
 */
import type { CvModule, Mat } from './cvRuntime';
import { MatScope } from './cvRuntime';
import { planBridges, type PxBridge, type PxSegment } from './geometry';
import type { CvRoom, CvWall, PxPoint } from './types';

export interface RoomOptions {
  strokePx: number;
  /** 门洞最大跨度（px）；默认按笔画宽换算（外墙 ≈140mm，门 ≈900mm） */
  maxDoorGapPx?: number;
  /** 房间最小面积（px²）；默认 0.2 帖对应的像素面积 */
  minAreaPx?: number;
}

export interface RoomResult {
  rooms: CvRoom[];
  /** 封洞后的墙 mask（debug 用） */
  sealed: Mat;
  /** 为封洞补出来的连接段（M5 起带 `kind`：`gap` 就是门窗洞口候选） */
  bridges: PxBridge[];
  warnings: string[];
}

/**
 * 房间最小面积。0.2 帖 = 0.2 × 1.6562 m² ≈ 0.33 m²。
 *
 * M4.1 把它从 0.25 帖再放低一档：トイレ / 洗面所 / 収納 这些小间本来就在 0.5~1 帖，
 * 门洞封得不完美时轮廓会缩水，阈值卡在 0.25 帖会把它们整块吃掉，
 * 对应的 VLM 语义（トイレ / 洗面所）就挂不上宿主被丢弃。
 */
const MIN_ROOM_MM2 = 0.2 * 1.6562e6;
/** 外墙厚度经验值：用墙笔画宽反推 px/mm */
const WALL_THICKNESS_MM = 140;
/** 门宽经验值 */
const DOOR_WIDTH_MM = 900;

/** 把墙段（含厚度）+ 连接段画进一张 mask */
function renderWalls(cv: CvModule, walls: readonly CvWall[], bridges: readonly PxSegment[], width: number, height: number, strokePx: number): Mat {
  const mask = cv.Mat.zeros(height, width, cv.CV_8UC1);
  const white = new cv.Scalar(255, 255, 255, 255);
  for (const w of walls) {
    const t = Math.max(2, Math.round(w.thicknessPx || strokePx));
    cv.line(mask, new cv.Point(Math.round(w.x1), Math.round(w.y1)), new cv.Point(Math.round(w.x2), Math.round(w.y2)), white, t);
  }
  const bridgeWidth = Math.max(2, Math.round(strokePx));
  for (const b of bridges) {
    cv.line(mask, new cv.Point(Math.round(b.x1), Math.round(b.y1)), new cv.Point(Math.round(b.x2), Math.round(b.y2)), white, bridgeWidth);
  }
  return mask;
}

export function extractRooms(
  cv: CvModule,
  walls: readonly CvWall[],
  width: number,
  height: number,
  opts: RoomOptions,
): RoomResult {
  const warnings: string[] = [];
  const stroke = Math.max(1, opts.strokePx);
  const pxPerMm = stroke / WALL_THICKNESS_MM;
  const maxGapPx = opts.maxDoorGapPx ?? Math.max(6, Math.min(Math.min(width, height) * 0.2, DOOR_WIDTH_MM * pxPerMm));
  const minAreaPx = opts.minAreaPx ?? Math.max(stroke * stroke * 4, MIN_ROOM_MM2 * pxPerMm * pxPerMm);

  const bridges = planBridges(walls, maxGapPx, stroke);
  const sealed = renderWalls(cv, walls, bridges, width, height, stroke);

  const scope = new MatScope();
  const rooms: CvRoom[] = [];
  try {
    const free = scope.keep(new cv.Mat());
    cv.bitwise_not(sealed, free);

    const labels = scope.keep(new cv.Mat());
    const stats = scope.keep(new cv.Mat());
    const centroids = scope.keep(new cv.Mat());
    const count = cv.connectedComponentsWithStats(free, labels, stats, centroids, 4, cv.CV_32S);

    const imageArea = width * height;
    const keep = new Uint8Array(count + 1);
    const labelData = labels.data32S;

    // 触到图边的区域 = 图外空白，直接丢
    const touchesBorder = new Uint8Array(count + 1);
    for (let x = 0; x < width; x++) {
      touchesBorder[labelData[x]] = 1;
      touchesBorder[labelData[(height - 1) * width + x]] = 1;
    }
    for (let y = 0; y < height; y++) {
      touchesBorder[labelData[y * width]] = 1;
      touchesBorder[labelData[y * width + width - 1]] = 1;
    }

    const areas = new Int32Array(count + 1);
    for (let i = 1; i < count; i++) {
      const area = stats.intAt(i, cv.CC_STAT_AREA);
      areas[i] = area;
      if (touchesBorder[i]) continue;
      if (area < minAreaPx) continue;
      if (area > imageArea * 0.45) continue;
      keep[i] = 1;
    }

    // 逐块取轮廓（分开取，保证一块一个多边形，不受相邻块影响）
    const epsilonBase = Math.max(1.5, stroke * 0.7);
    const one = scope.keep(new cv.Mat(height, width, cv.CV_8UC1));
    for (let i = 1; i < count; i++) {
      if (!keep[i]) continue;
      const d = one.data;
      for (let p = 0; p < labelData.length; p++) d[p] = labelData[p] === i ? 255 : 0;

      const contours = new cv.MatVector();
      const hierarchy = new cv.Mat();
      const approx = new cv.Mat();
      try {
        cv.findContours(one, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        if (contours.size() === 0) continue;

        // 取最大的一条（理论上只有一条）
        let bestIdx = 0;
        let bestArea = -1;
        for (let ci = 0; ci < contours.size(); ci++) {
          const a = cv.contourArea(contours.get(ci));
          if (a > bestArea) {
            bestArea = a;
            bestIdx = ci;
          }
        }
        cv.approxPolyDP(contours.get(bestIdx), approx, epsilonBase, true);

        const polygon: PxPoint[] = [];
        const ad = approx.data32S;
        for (let k = 0; k < approx.rows; k++) polygon.push({ x: ad[k * 2], y: ad[k * 2 + 1] });
        if (polygon.length < 3) continue;
        rooms.push({ polygon, areaPx: areas[i] });
      } finally {
        contours.delete();
        hierarchy.delete();
        approx.delete();
      }
    }
  } finally {
    scope.dispose();
  }

  if (rooms.length === 0) warnings.push('没有提取到闭合的房间区域（门洞可能没封上，或墙体提取不完整）');

  rooms.sort((a, b) => b.areaPx - a.areaPx);
  return { rooms, sealed, bridges, warnings };
}
