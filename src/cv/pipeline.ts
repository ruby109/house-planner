/**
 * M4-CV 阶段 A 总入口（见 docs/CV-PIPELINE.md 第 2 节）。
 *
 *   decode → binarize(+deskew) → wallMask(文字剔除/粗笔画) → skeleton → segments → rooms
 *
 * 输出坐标一律是**原图像素**：内部若因为图太大做了降采样，出口会统一乘回去。
 */
import { binarize } from './binarize';
import { pickColumns } from './columns';
import type { CvModule } from './cvRuntime';
import { MatScope, ensureCv, maskToArray } from './cvRuntime';
import type { DecodedImage } from './decode';
import { dropIslandWalls, findWallIslands } from './islandFilter';
import { buildOpenings } from './openings';
import { buildBuildingOutline, dropOutsideWalls } from './outline';
import { extractRooms } from './rooms';
import { extractSegments } from './segments';
import {
  WALL_THICKNESS_MM,
  attachTolerancePx,
  closeDanglingEnds,
  composeIndexMaps,
  countDanglingEnds,
  mergeWallsAcrossGaps,
} from './wallNet';
import type {
  BinarizeMode,
  CvColumn,
  CvExtract,
  CvOpening,
  CvRoom,
  CvWall,
  TextBox,
} from './types';
import { buildWallMask } from './wallMask';

export interface ExtractOptions {
  /** 长边超过它就先降采样（默认 1800）；坐标会换算回原图尺度 */
  maxSidePx?: number;
  /**
   * 长边不足它就先**放大**（默认 1200）。
   * 网上抓的間取り图常常只有 500px 宽，墙才 3~4px：这时形态学 kernel 只能在
   * 3/4/5 之间跳，量化误差比信号还大。先放大到 ~1200px，kernel 才有分辨率可调。
   */
  minSidePx?: number;
  /** 返回中间步骤的 mask（cv-debug 用） */
  debug?: boolean;
  /** 关掉 deskew */
  deskew?: boolean;
  /** 强制二值化模式 */
  mode?: BinarizeMode;
  /** 关掉「最大连通墙体团」启发式 */
  isolatePlan?: boolean;
}

const DEFAULT_MAX_SIDE = 1800;
const DEFAULT_MIN_SIDE = 1200;

/** 按需缩放到工作尺度，返回 work 尺度的 RGBA 与 work→原图的系数 */
function toWorkImage(
  cv: CvModule,
  image: DecodedImage,
  maxSide: number,
  minSide: number,
): { rgba: Uint8ClampedArray; width: number; height: number; scale: number } {
  const longSide = Math.max(image.width, image.height);
  let ratio = 1;
  if (longSide > maxSide) ratio = maxSide / longSide;
  else if (longSide < minSide) ratio = Math.min(3, minSide / longSide);
  if (Math.abs(ratio - 1) < 1e-6) {
    return { rgba: image.data, width: image.width, height: image.height, scale: 1 };
  }

  const width = Math.max(1, Math.round(image.width * ratio));
  const height = Math.max(1, Math.round(image.height * ratio));
  const scope = new MatScope();
  try {
    const src = scope.keep(new cv.Mat(image.height, image.width, cv.CV_8UC4));
    src.data.set(image.data);
    const dst = scope.keep(new cv.Mat());
    cv.resize(src, dst, new cv.Size(width, height), 0, 0, ratio < 1 ? cv.INTER_AREA : cv.INTER_CUBIC);
    return { rgba: new Uint8ClampedArray(dst.data), width, height, scale: image.width / width };
  } finally {
    scope.dispose();
  }
}

function scaleWall(w: CvWall, k: number): CvWall {
  return { x1: w.x1 * k, y1: w.y1 * k, x2: w.x2 * k, y2: w.y2 * k, thicknessPx: w.thicknessPx * k };
}

function scaleRoom(r: CvRoom, k: number): CvRoom {
  return { polygon: r.polygon.map((p) => ({ x: p.x * k, y: p.y * k })), areaPx: r.areaPx * k * k };
}

function scaleBox(b: TextBox, k: number): TextBox {
  return { x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k };
}

function scaleOpening(o: CvOpening, k: number): CvOpening {
  return { ...o, x1: o.x1 * k, y1: o.y1 * k, x2: o.x2 * k, y2: o.y2 * k };
}

/** 建筑轮廓栅格 → work 尺度的 0/255 mask（debug 拼图第 5 张） */
function outlineMask(
  outline: { cellPx: number; cols: number; rows: number; mask: Uint8Array } | null,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  if (!outline) return out;
  for (let y = 0; y < height; y++) {
    const cy = Math.min(outline.rows - 1, Math.floor(y / outline.cellPx));
    for (let x = 0; x < width; x++) {
      const cx = Math.min(outline.cols - 1, Math.floor(x / outline.cellPx));
      out[y * width + x] = outline.mask[cy * outline.cols + cx] ? 255 : 0;
    }
  }
  return out;
}

/** 墙段的包围盒（M5.1：轮廓外剔除的墙在 debug 叠加图里画品红框） */
function wallBox(w: CvWall): TextBox {
  const x = Math.min(w.x1, w.x2);
  const y = Math.min(w.y1, w.y2);
  return { x, y, w: Math.abs(w.x2 - w.x1), h: Math.abs(w.y2 - w.y1) };
}

function scaleColumn(c: CvColumn, k: number): CvColumn {
  return { x: c.x * k, y: c.y * k, wPx: c.wPx * k, hPx: c.hPx * k };
}

export async function extractGeometry(image: DecodedImage, opts: ExtractOptions = {}): Promise<CvExtract> {
  const started = Date.now();
  const cv = await ensureCv();
  const warnings: string[] = [];

  const work = toWorkImage(cv, image, opts.maxSidePx ?? DEFAULT_MAX_SIDE, opts.minSidePx ?? DEFAULT_MIN_SIDE);
  if (work.scale !== 1) {
    warnings.push(
      `原图 ${image.width}×${image.height} 已${work.scale > 1 ? '降采样' : '放大'}到 ${work.width}×${work.height} 处理`,
    );
  }

  const bin = binarize(cv, work.rgba, work.width, work.height, { deskew: opts.deskew, mode: opts.mode });
  warnings.push(...bin.warnings);

  let wallStrokePx = 0;
  let textBoxes: TextBox[] = [];
  let dashBoxes: TextBox[] = [];
  let dashChainsRemoved = 0;
  let thinBlobsRemoved = 0;
  let islandWallsRemoved = 0;
  let outsideWallsRemoved = 0;
  let outsideBoxes: TextBox[] = [];
  let gapMergedWalls = 0;
  let danglingExtended = 0;
  let scrapWallsRemoved = 0;
  let danglingEndsBefore = 0;
  let danglingEnds = 0;
  let walls: CvWall[] = [];
  let rooms: CvRoom[] = [];
  let openings: CvOpening[] = [];
  let columns: CvColumn[] = [];
  let debug: CvExtract['debug'];

  try {
    const wm = buildWallMask(cv, bin.bin, {
      isolatePlan: opts.isolatePlan,
      // 确认是拼版广告图（有成片的照片/色块）时才裁到图纸区域
      cropToPlan: opts.isolatePlan !== false && bin.drawingFrac < 0.9,
    });
    warnings.push(...wm.warnings);
    wallStrokePx = wm.strokePx;
    textBoxes = wm.textBoxes;
    dashBoxes = wm.dashBoxes;
    dashChainsRemoved = wm.dashChains;
    thinBlobsRemoved = wm.thinBlobs;

    try {
      const maskArray = maskToArray(wm.mask);
      const seg = extractSegments(cv, wm.mask, maskArray, { strokePx: wm.strokePx });
      walls = seg.walls;

      // M4.1 孤岛墙段剔除：**必须在房间提取之前**——地暖框、家具轮廓这类孤岛
      // 本身就会把房间切开，等房间出来再删就晚了。
      // 先用全量墙段跑一遍房间（只为拿到「某某孤岛落在哪个房间里」的判据），
      // 剔完再正式跑一遍。两遍 `extractRooms` 的开销可以忽略（纯连通域）。
      const probe = extractRooms(cv, walls, work.width, work.height, { strokePx: wm.strokePx });
      probe.sealed.delete();
      const island = dropIslandWalls(walls, {
        touchTolPx: Math.max(3, wm.strokePx * 1.5),
        rooms: probe.rooms,
      });
      if (island.dropped.length > 0) {
        walls = island.walls;
        islandWallsRemoved = island.dropped.length;
        warnings.push(
          `剔除了 ${island.islands.length} 团与主墙网不相连的细线段（共 ${island.dropped.length} 段：地暖框 / 指北针 / 家具线）`,
        );
      }

      const roomResult = extractRooms(cv, walls, work.width, work.height, { strokePx: wm.strokePx });
      warnings.push(...roomResult.warnings);
      rooms = roomResult.rooms;

      // ---------------------------------------------------------------------
      // M5.1 墙网闭合（见 docs/CV-PIPELINE.md 第 9 节）。三步都在**房间提取之后**：
      // 建筑轮廓要拿房间并集来定，跨洞合墙要拿 `planBridges` 的缺口来定。
      // 桥接段记的是墙段下标，每一步都要把下标映射复合上去。
      // ---------------------------------------------------------------------
      const attachTol = attachTolerancePx(wm.strokePx);
      danglingEndsBefore = countDanglingEnds(walls, attachTol);
      let bridgeMap: number[] = walls.map((_, i) => i);

      // (1) 建筑轮廓外剔除：指北针 / 图例 / 比例尺永远画在建筑轮廓之外。
      // 轮廓 = 房间并集 ∪ **主墙网**（最大连通子图，它就是建筑骨架；指北针是独立孤岛）。
      const mainIsland = findWallIslands(walls, Math.max(3, wm.strokePx * 1.5))[0];
      const coreWalls = mainIsland ? mainIsland.indices.map((i) => walls[i]) : [];
      const outline = buildBuildingOutline(rooms, coreWalls, {
        width: work.width,
        height: work.height,
        marginPx: Math.max(2, wm.strokePx),
        sealSegments: roomResult.bridges,
      });
      const outside = dropOutsideWalls(walls, outline);
      if (outside.dropped.length > 0) {
        walls = outside.walls;
        outsideWallsRemoved = outside.dropped.length;
        outsideBoxes = outside.dropped.map(wallBox);
        warnings.push(
          `剔除了 ${outside.dropped.length} 段落在建筑轮廓之外的线（指北针 / 图例 / 比例尺等装饰图形）`,
        );
      }
      bridgeMap = composeIndexMaps(bridgeMap, outside.indexMap);

      // (2) 跨洞合墙：门洞两侧本来就是同一道墙，洞口是挂在墙上的 Opening
      const remappedGaps = roomResult.bridges
        .filter((b) => b.kind === 'gap')
        .map((b) => ({ a: bridgeMap[b.a] ?? -1, b: bridgeMap[b.b] ?? -1 }))
        .filter((p) => p.a >= 0 && p.b >= 0);
      const gapMerge = mergeWallsAcrossGaps(walls, remappedGaps, {
        offsetTolPx: Math.max(2, wm.strokePx * 1.2),
      });
      walls = gapMerge.walls;
      gapMergedWalls = gapMerge.mergedCount;
      bridgeMap = composeIndexMaps(bridgeMap, gapMerge.indexMap);

      // (3) 悬空端点闭合：延伸到最近的墙（T 接），够不着的碎屑才丢
      const closed = closeDanglingEnds(walls, {
        strokePx: wm.strokePx,
        pxPerMm: wm.strokePx / WALL_THICKNESS_MM,
        attachTolPx: attachTol,
      });
      walls = closed.walls;
      danglingExtended = closed.extended;
      scrapWallsRemoved = closed.dropped.length;
      danglingEnds = closed.danglingAfter;
      bridgeMap = composeIndexMaps(bridgeMap, closed.indexMap);
      if (danglingEnds > 0) {
        warnings.push(
          `还有 ${danglingEnds} 处墙端没有闭合（阳台矮墙 / 开放边界属正常，其余请人工检查）`,
        );
      }

      const bridges = roomResult.bridges
        .map((b) => ({ ...b, a: bridgeMap[b.a] ?? -1, b: bridgeMap[b.b] ?? -1 }))
        .filter((b) => b.a >= 0 && b.b >= 0);

      // M5 柱候选：形状候选（wallMask 阶段挑的）+ 「贴不贴墙」（现在才有墙段）
      columns = pickColumns(wm.columnBoxes, walls, { strokePx: wm.strokePx });
      // M5 洞口候选：主力是共线合并时被跨过的缺口（真门洞），封房间的桥接段补漏
      openings = buildOpenings(
        bridges,
        walls,
        { strokePx: wm.strokePx, rooms, columns },
        seg.gaps,
      );

      if (opts.debug) {
        debug = {
          binary: maskToArray(bin.bin),
          wallMask: maskArray,
          skeleton: seg.skeleton,
          sealed: maskToArray(roomResult.sealed),
          outline: outlineMask(outline, work.width, work.height),
          width: work.width,
          height: work.height,
          scale: work.scale,
        };
      }
      roomResult.sealed.delete();
    } finally {
      wm.mask.delete();
    }
  } finally {
    bin.bin.delete();
    bin.gray.delete();
  }

  if (walls.length === 0) warnings.push('没有提取到任何墙段');

  const k = work.scale;
  return {
    walls: k === 1 ? walls : walls.map((w) => scaleWall(w, k)),
    rooms: k === 1 ? rooms : rooms.map((r) => scaleRoom(r, k)),
    openings: k === 1 ? openings : openings.map((o) => scaleOpening(o, k)),
    columns: k === 1 ? columns : columns.map((c) => scaleColumn(c, k)),
    deskewDeg: bin.deskewDeg,
    textBoxes: k === 1 ? textBoxes : textBoxes.map((b) => scaleBox(b, k)),
    dashBoxes: k === 1 ? dashBoxes : dashBoxes.map((b) => scaleBox(b, k)),
    outsideBoxes: k === 1 ? outsideBoxes : outsideBoxes.map((b) => scaleBox(b, k)),
    stats: {
      wallStrokePx: wallStrokePx * k,
      mode: bin.mode,
      imageWidthPx: image.width,
      imageHeightPx: image.height,
      workWidthPx: work.width,
      workHeightPx: work.height,
      textBlocksRemoved: textBoxes.length,
      dashChainsRemoved,
      thinBlobsRemoved,
      islandWallsRemoved,
      outsideWallsRemoved,
      gapMergedWalls,
      danglingExtended,
      scrapWallsRemoved,
      danglingEndsBefore,
      danglingEnds,
      openingCandidates: openings.length,
      columnCandidates: columns.length,
      elapsedMs: Date.now() - started,
    },
    warnings,
    debug,
  };
}
