/**
 * M3：AI 识别结果的 schema（见 docs/AI-RECOGNITION.md 第 2 节）。
 *
 * 设计原则：**语义 + 归一化坐标（0–1000，相对图片，x 右 y 下）**，不要毫米绝对坐标
 * ——VLM 给的精确尺寸不可靠，换算与规整交给 `src/ai/solve.ts`。
 *
 * 三条硬约束（Anthropic structured outputs 的 schema 限制）：
 * 1. 所有对象必须 `additionalProperties: false` → 一律用 `z.strictObject`；
 * 2. 不能用数值 min/max 约束（`z.number().min()` 之类）→ 范围校验放 parse 之后（本文件下半部分）；
 * 3. 不能递归。
 *
 * 特别注意两点实现约束：
 * - 这里用的是 **zod v4**（`zod/v4` 子路径）。`@anthropic-ai/sdk/helpers/zod` 的
 *   `zodOutputFormat()` 只接受 v4 的 schema；项目其余部分（model/schema.ts）仍用 zod v3，
 *   两者可以共存（zod 3.25 同时提供 v3 与 v4 两套入口）。
 * - 本文件同时被 **前端（Vite）** 与 **server/*.mjs（Node 直接跑）** 引用，
 *   所以只能包含「可擦除语法」（无 enum / 无参数属性 / 无 namespace），
 *   并且不 import 任何浏览器或 store 相关的东西。
 */
import * as z from 'zod/v4';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 归一化坐标上限：**模型侧**的约定是 x/y **各自独立**归一化，
 * `x = 像素x ÷ 图宽 × 1000`、`y = 像素y ÷ 图高 × 1000`，两者都恒在 [0, 1000]。
 *
 * ⚠ 内部（`solve.ts` / `fuse.ts`）用的是**另一套**：两轴共用一个比例尺（都按图**宽**归一化），
 * 所以竖图的 y 会超过 1000。两者之间由 `applyImageAspect()` 转换，转换点在
 * `server/recognize.mjs`——**校验与 sanitize 之后**。别把两套坐标搞混。
 */
export const NORM_MAX = 1000;
/** 校验时允许的越界余量（模型偶尔会给 -3 / 1004 这种） */
export const NORM_SLACK = 60;
/**
 * 「宽容归一化」能兜住的上限：某个轴的坐标最大值落在 (NORM_MAX, NORM_RESCALE_MAX] 时，
 * 判定为模型做了**等比归一化**（两轴共用比例尺），按比例把该轴压回 0~1000；
 * 超过它就不是缩放问题（模型多半在用像素坐标或者干脆画飞了），照旧报校验错误。
 *
 * 2600 的来历：日本間取り图再竖也很少超过 1:2.6 的长宽比，
 * 比这更大的倍率已经不能用「等比归一化」解释了。
 */
export const NORM_RESCALE_MAX = 2600;
/** 房间多边形顶点数的合理区间 */
export const POLYGON_MIN_POINTS = 3;
export const POLYGON_MAX_POINTS = 24;
/** 室外在 openings.roomA / roomB 里的特殊值 */
export const OUTSIDE_ID = 'outside';

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

export const ScaleMethodSchema = z.enum(['tatami', 'dimension_text', 'estimate']);

export const RecognizedFloorSchema = z.enum(['flooring', 'tatami', 'tile', 'other']);

export const RecognizedOpeningTypeSchema = z.enum(['door', 'sliding_door', 'window', 'opening']);

export const NormPointSchema = z.strictObject({
  x: z.number().describe('归一化 X = 像素x ÷ 图片宽度 × 1000，恒在 0~1000'),
  y: z.number().describe('归一化 Y = 像素y ÷ 图片高度 × 1000（与 X 各自独立归一化），恒在 0~1000，向下为正'),
});

export const RecognizedRoomSchema = z.strictObject({
  id: z.string().describe('房间编号，形如 "r1"、"r2"，同一张图内唯一'),
  name: z.string().describe('房间名，保留日文原文：LDK / 洋室 / 和室 / 浴室 / 玄関 / 洗面所 …'),
  floor: RecognizedFloorSchema.describe('地面材质：flooring=フローリング, tatami=畳, tile=タイル/CF, other'),
  tatamiCount: z
    .number()
    .nullable()
    .describe('图上标注的帖数（"6帖"→6；只标 ㎡ 时按 1帖=1.62㎡ 换算；没有标注→null）'),
  polygon: z
    .array(NormPointSchema)
    .describe(
      '沿墙中心线的多边形，按顺序闭合（不要重复首点），顶点 4~14 个；' +
        '图上真实存在的斜め壁・角の斜めカット要按实际角度如实描出，不要强行直角化',
    ),
});

export const RecognizedOpeningSchema = z.strictObject({
  type: RecognizedOpeningTypeSchema.describe(
    'door=开き戸(弧线), sliding_door=引き戸(双错线), window=窗(墙上三线/双线), opening=无门开口',
  ),
  roomA: z.string().describe('洞口一侧的房间 id；室外用 "outside"'),
  roomB: z.string().describe('洞口另一侧的房间 id；室外用 "outside"'),
  x: z.number().describe('洞口中心的归一化 X（÷图宽×1000，0~1000）'),
  y: z.number().describe('洞口中心的归一化 Y（÷图高×1000，0~1000）'),
});

export const RecognizedColumnSchema = z.strictObject({
  x: z.number().describe('柱中心的归一化 X（÷图宽×1000，0~1000）'),
  y: z.number().describe('柱中心的归一化 Y（÷图高×1000，0~1000）'),
  w: z.number().nullable().describe('柱的归一化宽（÷图宽×1000；不确定填 null）'),
  h: z.number().nullable().describe('柱的归一化高（÷图高×1000；不确定填 null）'),
});

export const RecognizedScaleSchema = z.strictObject({
  method: ScaleMethodSchema.describe(
    'tatami=靠帖数标注推算（首选）, dimension_text=图上有 mm 尺寸文字, estimate=只能凭常识估计',
  ),
  drawingWidthMm: z.number().describe('图中建筑总宽（左外墙到右外墙）的估计值，单位 mm'),
});

export const RecognizeResultSchema = z.strictObject({
  notes: z.string().describe('对这张图的自由观察（调试用，不会进入文档）'),
  scale: RecognizedScaleSchema,
  rooms: z.array(RecognizedRoomSchema),
  openings: z.array(RecognizedOpeningSchema),
  columns: z.array(RecognizedColumnSchema).describe('只标注确信的柱；宁缺勿滥'),
});

// ---------------------------------------------------------------------------
// 推导类型
// ---------------------------------------------------------------------------

export type ScaleMethod = z.infer<typeof ScaleMethodSchema>;
export type RecognizedFloor = z.infer<typeof RecognizedFloorSchema>;
export type RecognizedOpeningType = z.infer<typeof RecognizedOpeningTypeSchema>;
export type NormPoint = z.infer<typeof NormPointSchema>;
export type RecognizedRoom = z.infer<typeof RecognizedRoomSchema>;
export type RecognizedOpening = z.infer<typeof RecognizedOpeningSchema>;
export type RecognizedColumn = z.infer<typeof RecognizedColumnSchema>;
export type RecognizeResult = z.infer<typeof RecognizeResultSchema>;

// ---------------------------------------------------------------------------
// 宽容归一化：把「等比归一化」的输出压回 0~1000（校验**之前**跑）
// ---------------------------------------------------------------------------

/** 保留 3 位小数：`v × (1000/max)` 的浮点误差会让最大值落成 1000.0000000000001 */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export interface AxisNormalizationFix {
  result: RecognizeResult;
  /** 实际施加的缩放系数（1 = 该轴没动） */
  factors: { x: number; y: number };
  warnings: string[];
}

/** 该轴要不要修，修的话系数是多少 */
function rescaleFactor(max: number): number {
  if (!Number.isFinite(max)) return 1;
  if (max <= NORM_MAX || max > NORM_RESCALE_MAX) return 1;
  return NORM_MAX / max;
}

/**
 * **宽容归一化修正**（纯函数）。
 *
 * 长宽比悬殊的图上，模型很容易忽略「两轴各自独立归一化」的约定，改用
 * **同一个比例尺**去缩放两个轴（典型症状：竖长条图的 y 冲到 1100~2100）。
 * 这种错误是**纯粹的单轴线性缩放**，信息一点没丢，所以与其把整份结果打回，
 * 不如按该轴的实测最大值把它压回 0~1000：
 *
 *   `factor = 1000 / 该轴坐标最大值`（仅当最大值 ∈ (1000, 2600]）
 *
 * rooms / openings / columns 三处坐标**同步**缩放（columns 的 w 跟 x、h 跟 y），
 * 保证相对关系不变。最大值 > 2600（不像缩放问题）或有负数越界的，
 * 原样留给 `recognizeResultIssues()` 报错——这里只做「明确可救」的那一类。
 */
export function fixAxisNormalization(result: RecognizeResult): AxisNormalizationFix {
  let maxX = 0;
  let maxY = 0;
  const track = (x: number, y: number) => {
    if (Number.isFinite(x) && x > maxX) maxX = x;
    if (Number.isFinite(y) && y > maxY) maxY = y;
  };
  for (const room of result.rooms) for (const p of room.polygon) track(p.x, p.y);
  for (const o of result.openings) track(o.x, o.y);
  for (const c of result.columns) track(c.x, c.y);

  const fx = rescaleFactor(maxX);
  const fy = rescaleFactor(maxY);
  if (fx === 1 && fy === 1) {
    return { result, factors: { x: 1, y: 1 }, warnings: [] };
  }

  const sx = (v: number) => (Number.isFinite(v) ? round3(v * fx) : v);
  const sy = (v: number) => (Number.isFinite(v) ? round3(v * fy) : v);

  const fixed: RecognizeResult = {
    ...result,
    rooms: result.rooms.map((r) => ({
      ...r,
      polygon: r.polygon.map((p) => ({ x: sx(p.x), y: sy(p.y) })),
    })),
    openings: result.openings.map((o) => ({ ...o, x: sx(o.x), y: sy(o.y) })),
    columns: result.columns.map((c) => ({
      ...c,
      x: sx(c.x),
      y: sy(c.y),
      w: c.w === null ? null : sx(c.w),
      h: c.h === null ? null : sy(c.h),
    })),
  };

  const parts: string[] = [];
  if (fx !== 1) parts.push(`x 轴 ×${round3(fx)}（原最大值 ${round3(maxX)}）`);
  if (fy !== 1) parts.push(`y 轴 ×${round3(fy)}（原最大值 ${round3(maxY)}）`);
  return {
    result: fixed,
    factors: { x: fx, y: fy },
    warnings: [`模型坐标归一化已自动修正：${parts.join('，')}`],
  };
}

// ---------------------------------------------------------------------------
// 模型坐标系 → 内部坐标系
// ---------------------------------------------------------------------------

/**
 * **模型侧（每轴各自归一化）→ 内部（两轴同一比例尺，都按图宽归一化）**。
 *
 * 模型给的是 `y = 像素y ÷ 图高 × 1000`，而 `solve.ts` / `fuse.ts` 一路都假定
 * 「1 归一化单位 = 图宽/1000 像素」（`fuse.normToPx` 对 x/y 都除以图宽）。
 * 两者只差一个常数：`y内部 = y模型 × 图高 / 图宽`。
 *
 * 放在**校验与 sanitize 之后**做：校验的 0~1000 是模型侧的约定，
 * 而转换之后竖图的 y 本来就该大于 1000。
 */
export function applyImageAspect(
  result: RecognizeResult,
  imageWidthPx: number,
  imageHeightPx: number,
): RecognizeResult {
  const ratio = imageWidthPx > 0 && imageHeightPx > 0 ? imageHeightPx / imageWidthPx : 1;
  if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) < 1e-9) return result;
  const sy = (v: number) => (Number.isFinite(v) ? round3(v * ratio) : v);

  return {
    ...result,
    rooms: result.rooms.map((r) => ({
      ...r,
      polygon: r.polygon.map((p) => ({ x: p.x, y: sy(p.y) })),
    })),
    openings: result.openings.map((o) => ({ ...o, y: sy(o.y) })),
    columns: result.columns.map((c) => ({ ...c, y: sy(c.y), h: c.h === null ? null : sy(c.h) })),
  };
}

// ---------------------------------------------------------------------------
// parse 之后的范围校验（schema 里不能写 min/max，只能在这里做）
// ---------------------------------------------------------------------------

function finite(v: number): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

function inNormRange(v: number): boolean {
  return finite(v) && v >= -NORM_SLACK && v <= NORM_MAX + NORM_SLACK;
}

/**
 * 硬伤检查：返回人类可读的问题列表（空数组 = 通过）。
 * server 端用它决定是否「把错误摘要作为追加 user turn 重试一次」。
 */
export function recognizeResultIssues(result: RecognizeResult): string[] {
  const issues: string[] = [];

  if (result.rooms.length === 0) {
    issues.push('rooms 为空：至少要识别出一个房间');
  }

  const ids = new Set<string>();
  for (const room of result.rooms) {
    const at = `rooms[id=${room.id || '?'}]`;
    if (!room.id) issues.push(`${at}: id 不能为空`);
    else if (ids.has(room.id)) issues.push(`${at}: id 重复`);
    ids.add(room.id);

    if (room.polygon.length < POLYGON_MIN_POINTS) {
      issues.push(`${at}.polygon: 只有 ${room.polygon.length} 个顶点，至少需要 ${POLYGON_MIN_POINTS} 个`);
    } else if (room.polygon.length > POLYGON_MAX_POINTS) {
      issues.push(
        `${at}.polygon: ${room.polygon.length} 个顶点过多，请简化到 14 个以内（保留真实的斜边，去掉多余的折点）`,
      );
    }
    for (const p of room.polygon) {
      if (!inNormRange(p.x) || !inNormRange(p.y)) {
        issues.push(`${at}.polygon: 坐标 (${p.x}, ${p.y}) 超出 0~${NORM_MAX} 归一化范围`);
        break;
      }
    }
    if (room.tatamiCount !== null && (!finite(room.tatamiCount) || room.tatamiCount <= 0)) {
      issues.push(`${at}.tatamiCount: ${room.tatamiCount} 不是正数（没有标注请填 null）`);
    }
  }

  for (let i = 0; i < result.openings.length; i++) {
    const o = result.openings[i];
    const at = `openings[${i}]`;
    if (!inNormRange(o.x) || !inNormRange(o.y)) {
      issues.push(`${at}: 坐标 (${o.x}, ${o.y}) 超出 0~${NORM_MAX} 归一化范围`);
    }
    for (const side of [o.roomA, o.roomB]) {
      if (side !== OUTSIDE_ID && !ids.has(side)) {
        issues.push(`${at}: 房间 id "${side}" 不存在（室外请用 "${OUTSIDE_ID}"）`);
      }
    }
  }

  for (let i = 0; i < result.columns.length; i++) {
    const c = result.columns[i];
    if (!inNormRange(c.x) || !inNormRange(c.y)) {
      issues.push(`columns[${i}]: 坐标 (${c.x}, ${c.y}) 超出 0~${NORM_MAX} 归一化范围`);
    }
  }

  if (!finite(result.scale.drawingWidthMm) || result.scale.drawingWidthMm <= 0) {
    issues.push(`scale.drawingWidthMm: ${result.scale.drawingWidthMm} 不是正数`);
  }

  return issues;
}

function clampNorm(v: number): number {
  if (!finite(v)) return 0;
  return v < 0 ? 0 : v > NORM_MAX ? NORM_MAX : v;
}

/**
 * 温和清洗：坐标夹到 [0, 1000]、丢掉顶点不足的房间、丢掉引用了不存在房间的洞口。
 * solver 自身也是防御性的，这一步只是让下游少写几个 if。
 */
export function sanitizeRecognizeResult(result: RecognizeResult): RecognizeResult {
  const rooms = result.rooms
    .filter((r) => r.polygon.length >= POLYGON_MIN_POINTS)
    .map((r) => ({
      ...r,
      polygon: r.polygon.map((p) => ({ x: clampNorm(p.x), y: clampNorm(p.y) })),
      tatamiCount:
        r.tatamiCount !== null && finite(r.tatamiCount) && r.tatamiCount > 0 ? r.tatamiCount : null,
    }));

  const ids = new Set(rooms.map((r) => r.id));
  const known = (id: string) => id === OUTSIDE_ID || ids.has(id);

  return {
    ...result,
    rooms,
    openings: result.openings
      .filter((o) => known(o.roomA) && known(o.roomB))
      .map((o) => ({ ...o, x: clampNorm(o.x), y: clampNorm(o.y) })),
    columns: result.columns.map((c) => ({ ...c, x: clampNorm(c.x), y: clampNorm(c.y) })),
  };
}
