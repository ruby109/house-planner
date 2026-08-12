/**
 * M5 标注 schema 的单测。
 *
 * 重点全在「编号」上：M5 的语义挂载完全靠 index，别的字段错了都只是显示问题。
 */
import { describe, expect, it } from 'vitest';
import {
  LabelResultSchema,
  groupRoomIndices,
  labelResultIssues,
  labelsByIndex,
  sanitizeLabelResult,
  type LabelResult,
} from './labelSchema';
import { toStrictJsonSchema } from './recognizeShared';

type PartialLabelRoom = Omit<LabelResult['rooms'][number], 'sameRoomAs'> & { sameRoomAs?: number | null };

function result(rooms: readonly PartialLabelRoom[], notes = ''): LabelResult {
  return { notes, rooms: rooms.map((r) => ({ sameRoomAs: null, ...r })) };
}

const OK: LabelResult = result([
  { index: 1, name: 'LDK', floor: 'flooring', tatamiCount: 15.5 },
  { index: 2, name: '洋室', floor: 'flooring', tatamiCount: 7 },
  { index: 3, name: null, floor: 'other', tatamiCount: null },
]);

describe('LabelResultSchema', () => {
  it('接受合法结果', () => {
    expect(LabelResultSchema.safeParse(OK).success).toBe(true);
  });

  it('拒绝多余字段（strictObject，structured outputs 的硬要求）', () => {
    const bad = { ...OK, rooms: [{ ...OK.rooms[0], polygon: [] }] };
    expect(LabelResultSchema.safeParse(bad).success).toBe(false);
  });

  it('拒绝未知的 floor', () => {
    const bad = result([{ index: 1, name: 'LDK', floor: 'carpet' as never, tatamiCount: null }]);
    expect(LabelResultSchema.safeParse(bad).success).toBe(false);
  });

  it('能生成 strict JSON Schema（每个 object 都 additionalProperties: false）', () => {
    const json = toStrictJsonSchema(LabelResultSchema) as Record<string, unknown>;
    expect(json.additionalProperties).toBe(false);
    expect((json.required as string[]).sort()).toEqual(['notes', 'rooms']);
    const room = (json.properties as any).rooms.items;
    expect(room.additionalProperties).toBe(false);
    expect((room.required as string[]).sort()).toEqual([
      'floor',
      'index',
      'name',
      'sameRoomAs',
      'tatamiCount',
    ]);
  });
});

describe('labelResultIssues', () => {
  it('合法结果没有问题', () => {
    expect(labelResultIssues(OK, 3)).toEqual([]);
  });

  it('少答几个编号是允许的（那些区域会显示成「房间」）', () => {
    expect(labelResultIssues(OK, 8)).toEqual([]);
  });

  it('rooms 为空要报', () => {
    expect(labelResultIssues(result([]), 3)).toHaveLength(1);
  });

  it('编号越界要报', () => {
    const issues = labelResultIssues(
      result([{ index: 9, name: 'LDK', floor: 'flooring', tatamiCount: null }]),
      3,
    );
    expect(issues.some((i) => i.includes('9'))).toBe(true);
  });

  it('编号重复要报', () => {
    const issues = labelResultIssues(
      result([
        { index: 1, name: 'LDK', floor: 'flooring', tatamiCount: null },
        { index: 1, name: '洋室', floor: 'flooring', tatamiCount: null },
      ]),
      3,
    );
    expect(issues.some((i) => i.includes('重复'))).toBe(true);
  });

  it('帖数不是正数要报', () => {
    const issues = labelResultIssues(
      result([{ index: 1, name: 'LDK', floor: 'flooring', tatamiCount: 0 }]),
      3,
    );
    expect(issues).toHaveLength(1);
  });
});

describe('sanitizeLabelResult', () => {
  it('丢掉越界 / 重复编号，保留第一条', () => {
    const out = sanitizeLabelResult(
      result([
        { index: 2, name: '洋室', floor: 'flooring', tatamiCount: 6 },
        { index: 9, name: '幽灵', floor: 'other', tatamiCount: null },
        { index: 2, name: '重复', floor: 'other', tatamiCount: null },
      ]),
      3,
    );
    expect(out.rooms).toHaveLength(1);
    expect(out.rooms[0].name).toBe('洋室');
  });

  it('空名字 / 非正帖数归一成 null', () => {
    const out = sanitizeLabelResult(
      result([{ index: 1, name: '   ', floor: 'other', tatamiCount: -2 }]),
      3,
    );
    expect(out.rooms[0].name).toBeNull();
    expect(out.rooms[0].tatamiCount).toBeNull();
  });

  it('按编号升序排好', () => {
    const out = sanitizeLabelResult(
      result([
        { index: 3, name: 'c', floor: 'other', tatamiCount: null },
        { index: 1, name: 'a', floor: 'other', tatamiCount: null },
      ]),
      3,
    );
    expect(out.rooms.map((r) => r.index)).toEqual([1, 3]);
  });

  it('小数编号取整后仍然有效', () => {
    const out = sanitizeLabelResult(
      result([{ index: 2.0, name: 'b', floor: 'other', tatamiCount: null }]),
      3,
    );
    expect(out.rooms[0].index).toBe(2);
  });
});

describe('groupRoomIndices', () => {
  it('没有 sameRoomAs 时每个编号自成一组', () => {
    const g = groupRoomIndices(OK, 3);
    expect([...g.values()]).toEqual([1, 2, 3]);
  });

  it('把「同一个房间被切开」的编号并成一组，代表是最小编号', () => {
    const g = groupRoomIndices(
      result([
        { index: 1, name: 'LDK', floor: 'flooring', tatamiCount: 18.4 },
        { index: 2, name: 'LDK', floor: 'flooring', tatamiCount: 18.4, sameRoomAs: 1 },
        { index: 4, name: 'LDK', floor: 'flooring', tatamiCount: 18.4, sameRoomAs: 1 },
      ]),
      4,
    );
    expect(g.get(1)).toBe(1);
    expect(g.get(2)).toBe(1);
    expect(g.get(4)).toBe(1);
    expect(g.get(3)).toBe(3);
  });

  it('链式指向（3→2→1）也能并到同一组', () => {
    const g = groupRoomIndices(
      result([
        { index: 2, name: 'LDK', floor: 'flooring', tatamiCount: null, sameRoomAs: 1 },
        { index: 3, name: 'LDK', floor: 'flooring', tatamiCount: null, sameRoomAs: 2 },
      ]),
      3,
    );
    expect(g.get(3)).toBe(1);
  });

  it('指向自己 / 指向不存在的编号会在 sanitize 里被清成 null', () => {
    const clean = sanitizeLabelResult(
      result([
        { index: 1, name: 'a', floor: 'other', tatamiCount: null, sameRoomAs: 1 },
        { index: 2, name: 'b', floor: 'other', tatamiCount: null, sameRoomAs: 99 },
      ]),
      3,
    );
    expect(clean.rooms.map((r) => r.sameRoomAs)).toEqual([null, null]);
  });

  it('成环时退化成自成一组，不会死循环', () => {
    const g = groupRoomIndices(
      result([
        { index: 1, name: 'a', floor: 'other', tatamiCount: null, sameRoomAs: 2 },
        { index: 2, name: 'b', floor: 'other', tatamiCount: null, sameRoomAs: 1 },
      ]),
      2,
    );
    expect(g.size).toBe(2);
  });
});

describe('labelsByIndex', () => {
  it('按编号建索引', () => {
    const map = labelsByIndex(OK);
    expect(map.get(1)?.name).toBe('LDK');
    expect(map.get(3)?.name).toBeNull();
    expect(map.get(4)).toBeUndefined();
  });
});
