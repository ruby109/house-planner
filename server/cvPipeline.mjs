/**
 * M4-CV 阶段 B：server 侧的 CV 提取 + 融合封装（见 docs/CV-PIPELINE.md 第 4、5 节）。
 *
 * `src/cv/*.ts` 与 `src/ai/fuse.ts` 都是前端那套「省扩展名」的 TS 模块，
 * 这里用 `tsHooks.mjs` + 动态 import 把它们拉进 Node（跟 cv-debug.mjs / test-recognize.mjs 一个路子）。
 *
 * opencv.js 的 WASM 加载要 1 秒上下，所以模块只加载一次并缓存；第一次 hybrid 请求会稍慢。
 */
import './tsHooks.mjs';

/** 少于这么多墙段就认为图纸提取失败（整版广告图的典型症状） */
export const MIN_HYBRID_WALLS = 6;
/**
 * M5 `cv` 管线的达标线：**房间 < 2 或 墙 < 6 就直接报错**，不再回退 AI 画几何。
 * 一块区域也分不出来的图，AI 标注无从谈起（没有编号可标）。
 */
export const MIN_CV_ROOMS = 2;
export const MIN_CV_WALLS = 6;
/** 回退提示文案（UI 直接展示） */
export const CV_FALLBACK_WARNING =
  '图纸提取失败（整版广告图请先裁剪出户型部分），已回退纯 AI 模式';
/** M5：CV 不达标时的结构化错误文案（前端据此弹「换图 / 描摹底图」引导） */
export const CV_INSUFFICIENT_MESSAGE =
  '图片分辨率不足以自动提取户型：请换一张更清晰的图（整版广告图请先裁剪出户型部分），或用底图描摹模式手动绘制';

/** @type {Promise<{decode: any, pipeline: any, fuse: any, labelFuse: any}> | null} */
let modulesPromise = null;

function loadModules() {
  if (!modulesPromise) {
    modulesPromise = (async () => ({
      decode: await import('../src/cv/decode.ts'),
      pipeline: await import('../src/cv/pipeline.ts'),
      fuse: await import('../src/ai/fuse.ts'),
      labelFuse: await import('../src/ai/labelFuse.ts'),
    }))();
  }
  return modulesPromise;
}

/**
 * 本地跑一遍 CV 墙体/房间提取。
 * @param {string} base64 图片的 base64（不带 data URL 前缀）
 * @returns {Promise<import('../src/cv/types.ts').CvExtract>}
 */
export async function extractCvGeometry(base64) {
  const { decode, pipeline } = await loadModules();
  const image = decode.decodeImage(Buffer.from(base64, 'base64'));
  return pipeline.extractGeometry(image, {});
}

/**
 * CV 几何 + VLM 语义 → SolveResult（含 fuseStats）。
 * @param {import('../src/cv/types.ts').CvExtract} extract
 * @param {import('../src/ai/recognizeSchema.ts').RecognizeResult} recognized
 * @param {{ imageWidthPx: number, imageHeightPx: number, ignoreSmallRooms?: boolean }} dims
 */
export async function fuseExtract(extract, recognized, dims) {
  const { fuse } = await loadModules();
  return fuse.fuseCvAndVlm(extract, recognized, dims);
}

/**
 * M5：CV 几何 + AI 标注 → SolveResult（含 labelStats）。
 * @param {import('../src/cv/types.ts').CvExtract} extract
 * @param {import('../src/ai/labelSchema.ts').LabelResult} labels
 * @param {{ imageWidthPx: number, imageHeightPx: number }} dims
 */
export async function labelFuseExtract(extract, labels, dims) {
  const { labelFuse } = await loadModules();
  return labelFuse.labelFuse(extract, labels, dims);
}

/**
 * CV 提取的结果够不够格走融合。
 * @param {import('../src/cv/types.ts').CvExtract | null} extract
 */
export function isExtractUsable(extract) {
  if (!extract) return false;
  return extract.rooms.length > 0 && extract.walls.length >= MIN_HYBRID_WALLS;
}

/**
 * M5：CV 提取够不够格走 `cv` 管线（不够就直接报错，不回退）。
 * @param {import('../src/cv/types.ts').CvExtract | null} extract
 */
export function isExtractUsableForCv(extract) {
  if (!extract) return false;
  return extract.rooms.length >= MIN_CV_ROOMS && extract.walls.length >= MIN_CV_WALLS;
}

/** 响应里给 UI 的 CV 统计（不含几何，体积很小） */
export function cvStatsPayload(extract, fuseStats = null) {
  if (!extract) return null;
  return {
    walls: extract.walls.length,
    rooms: extract.rooms.length,
    openingCandidates: extract.stats.openingCandidates ?? extract.openings?.length ?? 0,
    columnCandidates: extract.stats.columnCandidates ?? extract.columns?.length ?? 0,
    mode: extract.stats.mode,
    wallStrokePx: Math.round(extract.stats.wallStrokePx * 100) / 100,
    deskewDeg: Math.round(extract.deskewDeg * 100) / 100,
    elapsedMs: extract.stats.elapsedMs,
    imageWidthPx: extract.stats.imageWidthPx,
    imageHeightPx: extract.stats.imageHeightPx,
    // M4.1 虚线 / 孤岛剔除的账
    dashChainsRemoved: extract.stats.dashChainsRemoved,
    thinBlobsRemoved: extract.stats.thinBlobsRemoved,
    islandWallsRemoved: extract.stats.islandWallsRemoved,
    // M5.1 墙网闭合 / 装饰图形剔除的账
    outsideWallsRemoved: extract.stats.outsideWallsRemoved,
    gapMergedWalls: extract.stats.gapMergedWalls,
    danglingEnds: extract.stats.danglingEnds,
    warnings: extract.warnings,
    ...(fuseStats
      ? {
          borderWallsDropped: fuseStats.borderWallsDropped,
          shortDiagonalsDropped: fuseStats.shortDiagonalsDropped,
          scaleBasis: fuseStats.scaleBasis,
          mmPerPixel: Math.round(fuseStats.mmPerPixel * 1000) / 1000,
          // M4 hybrid 的语义挂载统计（M5 的 labelStats 里没有这几项，会是 undefined）
          matchedRooms: fuseStats.matchedRooms,
          iouMountedRooms: fuseStats.iouMountedRooms,
          unnamedMerged: fuseStats.unnamedMerged,
          ignoredSmallRooms: fuseStats.ignoredSmallRooms,
          // M5 的标注统计
          namedRooms: fuseStats.namedRooms,
          tatamiRooms: fuseStats.tatamiRooms,
          openingsPlaced: fuseStats.openingsPlaced,
          // M5.2 同房间碎块拼合
          mergedPieces: fuseStats.mergedPieces,
          fakePartitionsRemoved: fuseStats.fakePartitionsRemoved,
          danglingEndsAfterMerge: fuseStats.danglingEndsAfterMerge,
        }
      : {}),
  };
}
