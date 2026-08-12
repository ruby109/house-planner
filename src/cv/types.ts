/**
 * M4-CV 阶段 A：OpenCV 墙体提取的公共类型（见 docs/CV-PIPELINE.md 第 2 节）。
 *
 * 全部坐标都是**原图像素**（管线内部可能降采样处理，输出前会换算回原图尺度）。
 */

/** 图片像素坐标 */
export interface PxPoint {
  x: number;
  y: number;
}

/** 一段墙：中心线 + 厚度（骨架路线，不是轮廓多边形） */
export interface CvWall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 沿线 distanceTransform 中位数 ×2 */
  thicknessPx: number;
}

/** 一个房间：封闭区域的多边形 */
export interface CvRoom {
  polygon: PxPoint[];
  areaPx: number;
}

/**
 * M5：洞口候选 —— 墙上那段「本来该有墙、实际是缺口」的中心线段（像素坐标）。
 *
 * 来源是封房间时补出来的**共线桥接段**（`planBridges` 的 `kind: 'gap'`）：
 * 两段共线的墙面对面留了个小于门宽的口子，那就是门 / 窗 / 无门开口。
 * 具体是哪一种由 `exterior` 交给融合器做启发式（外墙 → window，内墙 → door）。
 *
 * ⚠ 宽度的 mm 过滤（<500 / >2730 丢弃）**不在这里做**：CV 阶段还不知道比例。
 */
export interface CvOpening {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 缺口所在墙段在 `CvExtract.walls` 里的下标；认不出时省略 */
  onWallIndex?: number;
  /** 缺口是否在外墙上（法向两侧至少有一侧不属于任何 CV 房间） */
  exterior: boolean;
}

/**
 * M5：柱候选 —— 接近正方形的实心小块（像素坐标，中心 + 边长）。
 *
 * 「尽力而为」：识别不出就是空数组，不硬凑。マンション图里独立画出来的黑方块
 * 能抓到；与墙连成一体的柱型本来就不是独立连通块，抓不到也不影响墙体几何。
 */
export interface CvColumn {
  /** 中心 */
  x: number;
  y: number;
  wPx: number;
  hPx: number;
}

/** 被判定为文字/标注而剔除的连通块（debug 叠加图里画蓝框；虚线链画黄框） */
export interface TextBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 二值化模式：clean = 电子稿线图，photo = 翻拍/扫描件 */
export type BinarizeMode = 'clean' | 'photo';

export interface CvStats {
  /** 墙笔画中位宽（px，原图尺度） */
  wallStrokePx: number;
  mode: BinarizeMode;
  /** 原图尺寸 */
  imageWidthPx: number;
  imageHeightPx: number;
  /** 管线内部实际处理的尺寸（可能被降采样） */
  workWidthPx: number;
  workHeightPx: number;
  /** 被剔除的文字/标注连通块数量 */
  textBlocksRemoved: number;
  /** M4.1：被剔除的虚线链条数（共线等间距重复的短杠） */
  dashChainsRemoved: number;
  /** M4.1：被剔除的「整块都比墙细」的线框数（床暖房 / 家具 / 指北针） */
  thinBlobsRemoved: number;
  /** M4.1：被剔除的孤岛墙段数（与主墙网不连通、落在图纸内部、比墙细） */
  islandWallsRemoved: number;
  /** M5.1：两端都在建筑轮廓外而被剔除的墙段数（指北针 / 图例 / 比例尺） */
  outsideWallsRemoved: number;
  /** M5.1：跨洞合墙少掉的墙段数（门洞两侧的共线墙并成一条） */
  gapMergedWalls: number;
  /** M5.1：被延伸到别的墙上（T 接）的悬空端点数 */
  danglingExtended: number;
  /** M5.1：两端都悬空且短于 600mm 而被丢弃的碎屑墙段数 */
  scrapWallsRemoved: number;
  /** M5.1：闭合处理**前**的悬空端点数 */
  danglingEndsBefore: number;
  /** M5.1：闭合处理**后**仍然悬空的端点数（阳台矮墙这类合法自由端也算在内） */
  danglingEnds: number;
  /** M5：洞口候选数（= `CvExtract.openings.length`，放这里方便 server 直接取统计） */
  openingCandidates: number;
  /** M5：柱候选数 */
  columnCandidates: number;
  /** 端到端耗时 ms */
  elapsedMs: number;
}

/** 中间步骤的 mask（仅 opts.debug 时返回），值域 0/255，尺寸 = work 尺寸 */
export interface CvDebugMasks {
  binary: Uint8Array;
  wallMask: Uint8Array;
  skeleton: Uint8Array;
  sealed: Uint8Array;
  /** M5.1：建筑轮廓（栅格放大回 work 尺度）；房间/墙都没有时是全 0 */
  outline: Uint8Array;
  width: number;
  height: number;
  /** work → 原图的缩放系数 */
  scale: number;
}

export interface CvExtract {
  walls: CvWall[];
  rooms: CvRoom[];
  /** M5：门窗洞口候选（墙上的缺口中心线段） */
  openings: CvOpening[];
  /** M5：柱候选（接近正方形的实心块，尽力而为） */
  columns: CvColumn[];
  /** 应用过的旋转校正（度，顺时针为正） */
  deskewDeg: number;
  stats: CvStats;
  warnings: string[];
  /** 被剔除的文字块（原图坐标） */
  textBoxes: TextBox[];
  /** M4.1：被剔除的虚线链 / 细线框（原图坐标，debug 叠加图里画黄框） */
  dashBoxes: TextBox[];
  /** M5.1：建筑轮廓外被剔除的墙段包围盒（原图坐标，debug 叠加图里画品红框） */
  outsideBoxes: TextBox[];
  debug?: CvDebugMasks;
}
