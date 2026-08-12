/**
 * M3+：**provider 无关**的识别辅助函数（纯函数，前后端共用）。
 *
 * 放在 `src/ai/` 而不是 `server/` 的原因和 `recognizeSchema.ts` 一样：
 * server 端的 `.mjs` 靠 Node 24 的原生类型剥离直接 import `.ts`，
 * 而 vitest 只收 `src/**\/*.test.ts`——放这里才能配单测。
 *
 * 这里只放「不依赖任何 SDK / 网络 / 环境变量」的东西：
 * - `stripCodeFences` / `parseModelJson`：降级路径（没有结构化输出时）解析模型回复；
 * - `toStrictJsonSchema`：zod v4 schema → OpenAI 风格 `json_schema` 的 strict 子集；
 * - `buildRetryUserText`：校验失败后追加的那一轮 user turn 文案。
 */
import * as z from 'zod/v4';

// ---------------------------------------------------------------------------
// 1. 模型回复 → JSON
// ---------------------------------------------------------------------------

/** 整段就是一个 ```lang … ``` 代码块 */
const WHOLE_FENCE = /^```[^\n]*\n([\s\S]*?)\n?```$/;
/** 文字中间夹着一个代码块 */
const INNER_FENCE = /```[a-zA-Z0-9_+-]*[ \t]*\r?\n([\s\S]*?)```/;

/**
 * 剥掉 markdown 代码围栏。没有围栏时原样返回（只做 trim）。
 * 走「降级路径」（模型不支持 response_format）时模型很爱裹一层 ```json。
 */
export function stripCodeFences(raw: string): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text.includes('```')) return text;

  const whole = WHOLE_FENCE.exec(text);
  if (whole) return whole[1].trim();

  const inner = INNER_FENCE.exec(text);
  if (inner) return inner[1].trim();

  // 只有开围栏、没有闭围栏（被截断）——把开围栏那一行去掉
  return text.replace(/^```[^\n]*\r?\n?/, '').replace(/```\s*$/, '').trim();
}

/**
 * 把模型回复解析成 JSON 对象：先剥围栏，再直接 parse；
 * 还不行就截取第一个 `{` 到最后一个 `}`（模型偶尔会在 JSON 前后加一句废话）。
 *
 * 解析不出来时抛普通 `Error`（调用方负责包装成 RecognizeError）。
 */
export function parseModelJson(raw: string): unknown {
  const text = stripCodeFences(raw);
  if (!text) throw new Error('模型返回了空内容');

  try {
    return JSON.parse(text);
  } catch {
    /* 落到下面的截取兜底 */
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* 落到下面抛错 */
    }
  }
  throw new Error(`模型没有返回可解析的 JSON（前 120 字符：${text.slice(0, 120)}）`);
}

// ---------------------------------------------------------------------------
// 2. zod → JSON Schema（OpenAI 风格 structured outputs 的 strict 子集）
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 递归修正 JSON Schema，满足 `strict: true` 的两条硬要求：
 * 1. 每个 object 都要 `additionalProperties: false`；
 * 2. `required` 必须列出 **全部** properties（可空字段用 `anyOf[..., null]` 表达，而不是省略）。
 *
 * zod v4 的 `z.toJSONSchema()` 对 `z.strictObject` 本来就会给 `additionalProperties: false`，
 * 这一步是防御性的——万一以后 schema 里混进 `z.object()` 也不会悄悄变成非 strict。
 * 原地修改并返回同一个对象。
 */
export function enforceStrictObjects<T>(node: T): T {
  visitStrict(node);
  return node;
}

function visitStrict(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) visitStrict(item);
    return;
  }
  if (!isPlainObject(node)) return;

  if (node.type === 'object' && isPlainObject(node.properties)) {
    node.additionalProperties = false;
    node.required = Object.keys(node.properties);
  }
  for (const value of Object.values(node)) visitStrict(value);
}

/**
 * zod v4 schema → 可直接塞进
 * `response_format.json_schema.schema` 的 JSON Schema。
 *
 * 去掉 `$schema`（部分网关会因为这个未知顶层字段报错），并做一遍 strict 修正。
 */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>;
  delete json.$schema;
  return enforceStrictObjects(json);
}

// ---------------------------------------------------------------------------
// 3. 坐标约定的**唯一权威表述**
// ---------------------------------------------------------------------------

/**
 * 归一化坐标公式的原文。**单一来源**：
 * - `server/prompt.mjs` 的 system prompt 第二节直接嵌它；
 * - `buildRetryUserText()` 在校验失败重试时把它原样再贴一遍。
 *
 * 之所以写得这么啰嗦：模型在长宽比悬殊的图上会本能地「两轴共用一个比例尺」
 * （等比归一化），于是竖长条图的 y 冲到 1000 以上，整份结果被校验打回。
 * 必须把「两轴各自独立」说死，不留任何解释空间。
 */
export const NORM_COORD_RULE = `x = 像素x ÷ 图片宽度 × 1000，y = 像素y ÷ 图片高度 × 1000。
**两个轴各自独立归一化**：x 用图宽做分母，y 用图高做分母，绝对不要让两轴共用同一个比例尺。
所以**无论图是横的还是竖的**，x 和 y 都必然落在 0~1000 之间——图片右边缘恒为 x=1000，图片下边缘恒为 y=1000。`;

// ---------------------------------------------------------------------------
// 4. 校验失败后的重试文案
// ---------------------------------------------------------------------------

/** 反馈给模型的问题条数上限（prompt 不要被撑爆） */
export const RETRY_ISSUE_LIMIT = 10;

/**
 * 把 `recognizeResultIssues()` 的问题列表拼成追加 user turn 的文案。
 * Anthropic / OpenRouter 两条路径共用同一段话术。
 *
 * 第 1 条永远是坐标公式原文：越界几乎总是「等比归一化」造成的，
 * 只说「坐标要在 0~1000」而不重申公式，模型第二次还会照错不误。
 */
export function buildRetryUserText(issues: readonly string[]): string {
  const summary = issues.slice(0, RETRY_ISSUE_LIMIT).join('\n- ');
  return `上一次的识别结果没有通过校验：\n- ${summary}\n\n请重新完整输出一次，修正上述问题。特别注意坐标的算法（**重申一遍**）：

${NORM_COORD_RULE}

如果上面的问题里有「坐标超出 0~1000」，那基本可以肯定你把 y 也按图片宽度去算了——请改用图片高度重算所有 y。
另外：每个房间的多边形至少 3 个顶点，openings 里引用的房间 id 必须存在（室外用 "outside"）。`;
}
