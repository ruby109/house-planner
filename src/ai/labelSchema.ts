/**
 * M5：**房间标注**结果的 schema（见 docs/CV-PIPELINE.md 第 7 节）。
 *
 * 与 M3~M4 的 `recognizeSchema.ts` 的根本区别：**这里一个坐标都没有**。
 * 几何全部来自 OpenCV，AI 只回答「几号房间叫什么、地面是什么、标了几帖」。
 * 「坐标约定搞反 / 多边形重叠 / 房间漏画」这一整类 bug 从机制上被消灭了，
 * token 也降了一个量级（没有多边形要吐）。
 *
 * 与 `recognizeSchema.ts` 同样的三条硬约束（structured outputs 的 schema 限制）：
 * 1. 所有对象 `additionalProperties: false` → 一律 `z.strictObject`；
 * 2. 不能用数值 min/max → 范围校验放 parse 之后（本文件下半部分）；
 * 3. 不能递归。
 *
 * 本文件同时被前端（Vite）与 `server/*.mjs`（Node 直接跑）引用，
 * 所以只能包含「可擦除语法」，且不 import 任何浏览器 / store 相关的东西。
 */
import * as z from 'zod/v4';

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

export const LabelFloorSchema = z.enum(['flooring', 'tatami', 'tile', 'other']);

export const LabelRoomSchema = z.strictObject({
  index: z
    .number()
    .describe('房间编号，与标记图上圆标里的数字（或房间清单里的编号）严格对应，从 1 开始'),
  name: z
    .string()
    .nullable()
    .describe('该编号区域的房间名，保留日文原文：LDK / 洋室 / 和室 / 浴室 / 玄関 / バルコニー …；认不出填 null'),
  floor: LabelFloorSchema.describe(
    '地面材质：flooring=フローリング, tatami=畳, tile=タイル/CF/土間, other=判断不了',
  ),
  tatamiCount: z
    .number()
    .nullable()
    .describe('图上**明确标注**的帖数（"6帖"→6；只标 ㎡ 时按 1帖=1.62㎡ 换算）；图上没写就填 null，不要估算'),
  sameRoomAs: z
    .number()
    .nullable()
    .describe(
      '如果这一块和另一个编号其实是**同一个房间**被切开的（例如 LDK 被吧台切成两半），' +
        '填那一组里**最小的**编号；否则填 null。自己就是最小编号时也填 null',
    ),
});

export const LabelResultSchema = z.strictObject({
  notes: z
    .string()
    .describe('对这张图的自由观察：读到的标注文字、哪些编号拿不准、编号与房间对不上的地方'),
  rooms: z.array(LabelRoomSchema).describe('每个编号一条，不要遗漏，也不要编造不存在的编号'),
});

// ---------------------------------------------------------------------------
// 推导类型
// ---------------------------------------------------------------------------

export type LabelFloor = z.infer<typeof LabelFloorSchema>;
export type LabelRoom = z.infer<typeof LabelRoomSchema>;
export type LabelResult = z.infer<typeof LabelResultSchema>;

// ---------------------------------------------------------------------------
// parse 之后的校验与清洗
// ---------------------------------------------------------------------------

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 硬伤检查：返回人类可读的问题列表（空数组 = 通过）。
 *
 * 判据刻意**很松**——标注任务里唯一「致命」的错误是编号对不上（那会把语义挂到
 * 别的房间头上）。名字认不出、帖数没标都是合法输出（填 null 即可），不该触发重试。
 */
export function labelResultIssues(result: LabelResult, roomCount: number): string[] {
  const issues: string[] = [];
  if (result.rooms.length === 0) {
    issues.push('rooms 为空：图上有编号，每个编号都要给一条结果');
    return issues;
  }

  const seen = new Set<number>();
  for (const room of result.rooms) {
    if (!finite(room.index) || !Number.isInteger(room.index)) {
      issues.push(`rooms: index "${room.index}" 不是整数`);
      continue;
    }
    if (room.index < 1 || room.index > roomCount) {
      issues.push(`rooms: 编号 ${room.index} 不存在（图上只有 1~${roomCount} 号）`);
      continue;
    }
    if (seen.has(room.index)) issues.push(`rooms: 编号 ${room.index} 重复了`);
    seen.add(room.index);
    if (room.tatamiCount !== null && (!finite(room.tatamiCount) || room.tatamiCount <= 0)) {
      issues.push(`rooms[${room.index}].tatamiCount: ${room.tatamiCount} 不是正数（没有标注请填 null）`);
    }
    if (room.sameRoomAs !== null && room.sameRoomAs === room.index) {
      issues.push(`rooms[${room.index}].sameRoomAs 不能指向自己（是这一组里最小的编号就填 null）`);
    }
  }

  // 少答几个编号是可以接受的（那些区域会显示成「房间」），但一个都没对上就是搞砸了
  if (seen.size === 0) issues.push('没有一条结果的编号是有效的，请对照标记图重新回答');
  return issues;
}

/**
 * 温和清洗：丢掉非法 / 越界 / 重复的编号，帖数非正数改 null，名字 trim 后空串改 null。
 * 同一个编号出现多次时保留**第一条**。
 */
export function sanitizeLabelResult(result: LabelResult, roomCount: number): LabelResult {
  const seen = new Set<number>();
  const rooms: LabelRoom[] = [];
  for (const room of result.rooms) {
    const index = finite(room.index) ? Math.round(room.index) : NaN;
    if (!Number.isFinite(index) || index < 1 || index > roomCount || seen.has(index)) continue;
    seen.add(index);
    const name = typeof room.name === 'string' ? room.name.trim() : '';
    const sameAs = finite(room.sameRoomAs) ? Math.round(room.sameRoomAs) : null;
    rooms.push({
      index,
      name: name === '' ? null : name,
      floor: room.floor,
      tatamiCount:
        room.tatamiCount !== null && finite(room.tatamiCount) && room.tatamiCount > 0
          ? room.tatamiCount
          : null,
      // 指向自己 / 指向不存在的编号 一律当没填
      sameRoomAs: sameAs !== null && sameAs !== index && sameAs >= 1 && sameAs <= roomCount ? sameAs : null,
    });
  }
  rooms.sort((a, b) => a.index - b.index);
  return { notes: typeof result.notes === 'string' ? result.notes : '', rooms };
}

/** 编号 → 标注，方便融合器按下标取（编号是 1-based，CV 房间下标是 0-based） */
export function labelsByIndex(result: LabelResult): Map<number, LabelRoom> {
  return new Map(result.rooms.map((r) => [r.index, r]));
}

/**
 * 按 `sameRoomAs` 把编号并成组：**同一个真实房间被 CV 切开的那些块**归为一组。
 *
 * 这一步不是锦上添花，是**必须的**：比例 = Σ帖数 ÷ Σ像素面积，
 * 而一个被切成三块的 LDK，AI 会老老实实给三块都写上「18.4 帖」——
 * 帖数被算了三遍，面积却只有一份，整张图的尺寸会大出 70%（test5 实测：101 帖 vs 实际 ~32 帖）。
 * 归组之后每组的帖数只算一次，面积按整组求和，正好是这个房间的真实值。
 *
 * 返回：编号（1-based）→ 组代表编号。指向环 / 指向不存在的编号都会退化成「自成一组」。
 */
export function groupRoomIndices(result: LabelResult, roomCount: number): Map<number, number> {
  const parent = new Map<number, number>();
  for (let i = 1; i <= roomCount; i++) parent.set(i, i);

  const find = (i: number): number => {
    const seen = new Set<number>();
    let r = i;
    while (parent.get(r) !== r) {
      if (seen.has(r)) return i; // 有环：退化成自成一组
      seen.add(r);
      r = parent.get(r) ?? r;
    }
    return r;
  };

  for (const room of result.rooms) {
    if (room.sameRoomAs === null) continue;
    if (!parent.has(room.index) || !parent.has(room.sameRoomAs)) continue;
    const a = find(room.index);
    const b = find(room.sameRoomAs);
    if (a === b) continue;
    // 组代表取更小的编号，与 prompt 里的约定一致
    if (a < b) parent.set(b, a);
    else parent.set(a, b);
  }

  const out = new Map<number, number>();
  for (let i = 1; i <= roomCount; i++) out.set(i, find(i));
  return out;
}
