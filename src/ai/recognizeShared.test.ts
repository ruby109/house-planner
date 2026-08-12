/**
 * `recognizeShared.ts` 的单测：这几个纯函数是 OpenRouter **降级路径**（没有 structured outputs
 * 时靠 prompt 约束 + 手工解析）与 **schema 转换**的关键环节，出错会直接导致识别整体不可用。
 */
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { RecognizeResultSchema } from './recognizeSchema';
import {
  buildRetryUserText,
  enforceStrictObjects,
  parseModelJson,
  stripCodeFences,
  toStrictJsonSchema,
} from './recognizeShared';

describe('stripCodeFences', () => {
  it('原样返回没有围栏的文本', () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
    expect(stripCodeFences('  {"a":1}  ')).toBe('{"a":1}');
  });

  it('剥掉 ```json 围栏', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('剥掉没有语言标注的围栏', () => {
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('围栏前后有废话时也能取出代码块', () => {
    const raw = '好的，识别结果如下：\n```json\n{"a":1}\n```\n希望有帮助。';
    expect(stripCodeFences(raw)).toBe('{"a":1}');
  });

  it('只有开围栏（输出被截断）时也能去掉那一行', () => {
    expect(stripCodeFences('```json\n{"a":1}')).toBe('{"a":1}');
  });

  it('保留 JSON 内部的反引号内容不被误伤', () => {
    expect(stripCodeFences('```json\n{"notes":"图上写着 6帖"}\n```')).toBe('{"notes":"图上写着 6帖"}');
  });

  it('空输入返回空串', () => {
    expect(stripCodeFences('')).toBe('');
    expect(stripCodeFences(undefined as unknown as string)).toBe('');
  });
});

describe('parseModelJson', () => {
  it('解析裸 JSON', () => {
    expect(parseModelJson('{"rooms":[]}')).toEqual({ rooms: [] });
  });

  it('解析围栏包着的 JSON', () => {
    expect(parseModelJson('```json\n{"rooms":[1,2]}\n```')).toEqual({ rooms: [1, 2] });
  });

  it('JSON 前后有说明文字时截取 {...}', () => {
    expect(parseModelJson('这是结果：{"n":1} 完毕')).toEqual({ n: 1 });
  });

  it('完全不是 JSON 时抛错', () => {
    expect(() => parseModelJson('抱歉，我看不清这张图。')).toThrow();
    expect(() => parseModelJson('')).toThrow('空内容');
  });
});

describe('enforceStrictObjects', () => {
  it('给缺失的 object 补上 additionalProperties:false 与全量 required', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    };
    enforceStrictObjects(schema);
    expect(schema).toMatchObject({ additionalProperties: false, required: ['a', 'b'] });
  });

  it('递归处理数组 items 与嵌套 object', () => {
    const schema = {
      type: 'object',
      properties: {
        list: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' } } } },
      },
    };
    enforceStrictObjects(schema);
    const items = (schema.properties.list as { items: Record<string, unknown> }).items;
    expect(items.additionalProperties).toBe(false);
    expect(items.required).toEqual(['x']);
  });

  it('不会把名为 "type" 的属性当成 object 节点', () => {
    const schema = {
      type: 'object',
      properties: { type: { type: 'string', enum: ['door'] } },
    };
    enforceStrictObjects(schema);
    // properties.type 本身只是个 string schema，不该被塞 additionalProperties
    expect(schema.properties.type).toEqual({ type: 'string', enum: ['door'] });
    expect(schema).toMatchObject({ additionalProperties: false });
  });
});

describe('toStrictJsonSchema', () => {
  const schema = toStrictJsonSchema(RecognizeResultSchema);

  it('去掉 $schema 顶层字段', () => {
    expect(schema.$schema).toBeUndefined();
  });

  it('顶层是 object 且列全了五个字段', () => {
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['notes', 'scale', 'rooms', 'openings', 'columns']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('每一个 object 节点都是 strict 的', () => {
    const objects: Array<Record<string, unknown>> = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      if (obj.type === 'object' && obj.properties) objects.push(obj);
      Object.values(obj).forEach(walk);
    };
    walk(schema);
    // 顶层 + scale + room + point + opening + column
    expect(objects.length).toBe(6);
    for (const obj of objects) {
      expect(obj.additionalProperties).toBe(false);
      expect(obj.required).toEqual(Object.keys(obj.properties as object));
    }
  });

  it('可空字段用 anyOf[.., null] 表达而不是省略 required', () => {
    const room = (schema.properties as any).rooms.items;
    expect(room.required).toContain('tatamiCount');
    expect(room.properties.tatamiCount.anyOf).toEqual([{ type: 'number' }, { type: 'null' }]);
  });

  it('枚举字段带上了取值列表', () => {
    const scale = (schema.properties as any).scale;
    expect(scale.properties.method.enum).toEqual(['tatami', 'dimension_text', 'estimate']);
  });

  it('生成的 schema 能被 zod 反向接受（结构没漂）', () => {
    // 用 schema 描述的字段造一个最小合法对象，确认 zod 也认
    const sample = {
      notes: 'x',
      scale: { method: 'tatami', drawingWidthMm: 8000 },
      rooms: [{ id: 'r1', name: 'LDK', floor: 'flooring', tatamiCount: null, polygon: [] }],
      openings: [],
      columns: [],
    };
    expect(RecognizeResultSchema.safeParse(sample).success).toBe(true);
  });

  it('对任意 zod v4 schema 都能产出 strict 结果', () => {
    const custom = z.object({ a: z.string(), b: z.object({ c: z.number() }) });
    const json = toStrictJsonSchema(custom) as any;
    expect(json.additionalProperties).toBe(false);
    expect(json.properties.b.additionalProperties).toBe(false);
  });
});

describe('buildRetryUserText', () => {
  it('把问题列表拼成带项目符号的反馈', () => {
    const text = buildRetryUserText(['rooms 为空', 'openings[0]: 坐标越界']);
    expect(text).toContain('- rooms 为空');
    expect(text).toContain('- openings[0]: 坐标越界');
    expect(text).toContain('0~1000');
  });

  it('最多只反馈 10 条', () => {
    const issues = Array.from({ length: 25 }, (_, i) => `问题${i}`);
    const text = buildRetryUserText(issues);
    expect(text).toContain('问题9');
    expect(text).not.toContain('问题10');
  });
});
