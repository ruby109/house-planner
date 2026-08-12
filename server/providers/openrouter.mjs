/**
 * OpenRouter provider —— 用一个统一网关对比多家视觉模型的識別效果。
 *
 * 设计要点：
 * - **零新依赖**：直接用 Node 24 的全局 `fetch` 打 `POST /api/v1/chat/completions`；
 * - **OpenAI 风格消息**：`content: [{type:'image_url', image_url:{url:<dataURL>}}, {type:'text', ...}]`，
 *   system 沿用 `prompt.mjs` 里那份（和 Anthropic 路径同一份领域知识）；
 * - **结构化输出**：`response_format: {type:'json_schema', json_schema:{strict:true, schema}}`，
 *   schema 由 zod v4 的 `z.toJSONSchema()` 生成（`src/ai/recognizeShared.ts`）；
 * - **降级路径**：模型/上游不认 `response_format` 时（400/404/422 且错误信息里提到
 *   response_format / json_schema），自动去掉它重试，靠 prompt 里「只输出 JSON 对象」约束，
 *   回复剥掉 markdown 围栏后 `JSON.parse`；
 * - **重试**：zod / 硬伤校验没过时走 `retry.mjs` 的公共逻辑（与 Anthropic 路径完全一致）。
 *
 * ⚠ 任何日志、错误信息里都**不要**出现 API key。
 */
import {
  RecognizeResultSchema,
  fixAxisNormalization,
  recognizeResultIssues,
  sanitizeRecognizeResult,
} from '../../src/ai/recognizeSchema.ts';
import {
  LabelResultSchema,
  labelResultIssues,
  sanitizeLabelResult,
} from '../../src/ai/labelSchema.ts';
import { parseModelJson, toStrictJsonSchema } from '../../src/ai/recognizeShared.ts';
import { RecognizeError } from '../errors.mjs';
import {
  LABEL_JSON_ONLY_SUFFIX,
  LABEL_SYSTEM_PROMPT,
  buildLabelRetryText,
  buildLabelUserText,
} from '../labelPrompt.mjs';
import { JSON_ONLY_SUFFIX, REFINE_USER_TEXT, SYSTEM_PROMPT, buildUserText } from '../prompt.mjs';
import { recognizeWithRetry } from '../retry.mjs';

export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models';

/** 默认模型（allowlist 里的第一个；可用 env RECOGNIZE_MODEL 覆盖） */
export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-5.6-luna-pro';
/** 思考 + 输出的上限 */
export const MAX_TOKENS = 16000;
/** structured outputs 的 schema 名字 */
export const JSON_SCHEMA_NAME = 'recognize_result';
/** M5 房间标注的 schema 名字 */
export const LABEL_SCHEMA_NAME = 'label_result';

/** OpenRouter 会把它们显示在 dashboard 的 app 排行里（可选 header，不含任何敏感信息） */
const APP_HEADERS = {
  'HTTP-Referer': 'https://github.com/house-planner',
  'X-Title': 'house-planner',
};

// ---------------------------------------------------------------------------
// JSON Schema（生成一次就缓存）
// ---------------------------------------------------------------------------

/** @type {Record<string, unknown> | null} */
let cachedSchema = null;

/** `RecognizeResult` 的 strict JSON Schema */
export function recognizeJsonSchema() {
  if (!cachedSchema) cachedSchema = toStrictJsonSchema(RecognizeResultSchema);
  return cachedSchema;
}

// ---------------------------------------------------------------------------
// 消息组装
// ---------------------------------------------------------------------------

/**
 * @param {{ base64: string, mediaType: string, imageWidthPx: number, imageHeightPx: number }} input
 * @param {string | null} feedback 重试时追加的 user turn（校验问题摘要）
 * @param {boolean} useSchema 是否用 response_format（false = 降级路径，要在 prompt 里加 JSON 约束）
 */
export function buildMessages(input, feedback, useSchema) {
  const dataUrl = `data:${input.mediaType};base64,${input.base64}`;
  const system = useSchema
    ? SYSTEM_PROMPT
    : `${SYSTEM_PROMPT}${JSON_ONLY_SUFFIX}\n\n${JSON.stringify(recognizeJsonSchema())}`;

  const messages = [
    { role: 'system', content: system },
    {
      role: 'user',
      // 图片放在文字**之前**：和 Anthropic 路径保持一致，实测对图片理解更好
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: buildUserText(input) },
      ],
    },
  ];
  if (feedback) messages.push({ role: 'user', content: [{ type: 'text', text: feedback }] });
  return messages;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** 从 OpenRouter 的错误响应里抠一句人话（绝不会包含 key） */
function errorMessageOf(payload, status) {
  const err = payload && typeof payload === 'object' ? payload.error : null;
  if (err && typeof err === 'object') {
    const meta = err.metadata && typeof err.metadata === 'object' ? err.metadata : null;
    const raw = meta && typeof meta.raw === 'string' ? ` / ${meta.raw}` : '';
    return `${err.message ?? `HTTP ${status}`}${raw}`;
  }
  if (typeof payload === 'string' && payload) return payload.slice(0, 400);
  return `HTTP ${status}`;
}

/**
 * 判断「这次 400/404 是不是因为模型/上游不支持 response_format」。
 * 是的话调用方会去掉 response_format 重试一次。
 */
export function isResponseFormatUnsupported(status, message) {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  return /response[_ ]?format|json[_ ]?schema|structured[_ ]?output/i.test(message || '');
}

/**
 * 打一次 OpenRouter。HTTP 错误 → RecognizeError。
 * @returns {Promise<{ content: string, usage: object|null, finishReason: string|null, providerName: string|null }>}
 */
async function callOnce({ apiKey, model, messages, useSchema, signal, schema, schemaName }) {
  /** @type {Record<string, unknown>} */
  const body = {
    model,
    messages,
    max_tokens: MAX_TOKENS,
    // 让响应里带上这次调用的实际花费（美元），不额外收费
    usage: { include: true },
  };
  if (useSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: schemaName ?? JSON_SCHEMA_NAME,
        strict: true,
        schema: schema ?? recognizeJsonSchema(),
      },
    };
  }

  let response;
  try {
    response = await fetch(OPENROUTER_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        ...APP_HEADERS,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new RecognizeError(
      'network',
      `连不上 OpenRouter：${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const message = errorMessageOf(payload, response.status);
    if (response.status === 401 || response.status === 403) {
      throw new RecognizeError(
        'auth',
        'OpenRouter API key 无效或缺失：请在项目根目录 .env 里配置 OPENROUTER_APIKEY 后重启 dev:api',
        401,
      );
    }
    if (response.status === 429) {
      throw new RecognizeError('rate_limit', 'OpenRouter 调用过于频繁或额度不足，请稍后再试', 429);
    }
    const err = new RecognizeError(
      'api_error',
      `OpenRouter 出错（${response.status}）：${message}`,
      502,
    );
    err.httpStatus = response.status;
    err.rawMessage = message;
    throw err;
  }

  // 200 但 body 里带 error（OpenRouter 对上游错误偶尔这么干）
  if (payload && typeof payload === 'object' && payload.error && !payload.choices) {
    const message = errorMessageOf(payload, 200);
    const err = new RecognizeError('api_error', `OpenRouter 出错：${message}`, 502);
    err.httpStatus = Number(payload.error?.code) || 400;
    err.rawMessage = message;
    throw err;
  }

  const choice = payload?.choices?.[0];
  if (!choice) {
    throw new RecognizeError('invalid_output', 'OpenRouter 没有返回任何 choices，请重试', 502);
  }
  const raw = choice.message?.content;
  const content = Array.isArray(raw)
    ? raw.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('')
    : typeof raw === 'string'
      ? raw
      : '';

  return {
    content,
    usage: payload.usage ?? null,
    finishReason: choice.finish_reason ?? choice.native_finish_reason ?? null,
    providerName: payload.provider ?? null,
  };
}

// ---------------------------------------------------------------------------
// usage 汇总
// ---------------------------------------------------------------------------

function emptyUsage() {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, total_cost: 0, calls: 0 };
}

function addUsage(acc, usage) {
  acc.calls += 1;
  if (!usage || typeof usage !== 'object') return acc;
  acc.prompt_tokens += Number(usage.prompt_tokens) || 0;
  acc.completion_tokens += Number(usage.completion_tokens) || 0;
  acc.total_tokens += Number(usage.total_tokens) || 0;
  // OpenRouter 在 `usage: {include:true}` 时返回 `cost`（美元）
  acc.total_cost += Number(usage.cost ?? usage.total_cost) || 0;
  return acc;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 走 OpenRouter 识别一张間取り図。
 *
 * @param {{ base64: string, mediaType: string, imageWidthPx: number, imageHeightPx: number }} input
 * @param {{ model?: string, apiKey?: string, signal?: AbortSignal, refine?: boolean }} [options]
 * @returns {Promise<{
 *   result: import('../../src/ai/recognizeSchema.ts').RecognizeResult,
 *   usage: { prompt_tokens: number, completion_tokens: number, total_tokens: number, total_cost: number, calls: number },
 *   model: string, ms: number, provider: 'openrouter',
 *   structuredOutput: boolean, retried: boolean, refined: boolean,
 *   warnings: string[], upstream: string | null,
 * }>}
 */
export async function recognizeWithOpenRouter(input, options = {}) {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_APIKEY;
  if (!apiKey) {
    throw new RecognizeError(
      'no_api_key',
      '服务端没有配置 OPENROUTER_APIKEY：请复制 .env.example 为 .env 并填入 key（或设 MOCK_RECOGNIZE=1 用示例数据）',
      501,
    );
  }
  const model = options.model || process.env.RECOGNIZE_MODEL || DEFAULT_OPENROUTER_MODEL;
  const started = Date.now();

  const usage = emptyUsage();
  /** 一旦降级过，后续（包括重试那一轮）都不再带 response_format */
  let useSchema = true;
  let upstream = null;

  const attempt = async (feedback) => {
    let call;
    try {
      call = await callOnce({
        apiKey,
        model,
        messages: buildMessages(input, feedback, useSchema),
        useSchema,
        signal: options.signal,
      });
    } catch (err) {
      // 降级路径：模型/网关不认 response_format → 去掉它重试一次
      if (useSchema && err instanceof RecognizeError && isResponseFormatUnsupported(err.httpStatus, err.rawMessage)) {
        console.warn(`[openrouter] ${model} 不支持 structured outputs，降级为 prompt 约束的纯 JSON 输出`);
        useSchema = false;
        call = await callOnce({
          apiKey,
          model,
          messages: buildMessages(input, feedback, false),
          useSchema: false,
          signal: options.signal,
        });
      } else {
        throw err;
      }
    }

    addUsage(usage, call.usage);
    if (call.providerName) upstream = call.providerName;

    if (call.finishReason === 'length') {
      throw new RecognizeError('invalid_output', '输出被长度上限截断，请裁剪图片后重试', 502);
    }
    if (call.finishReason === 'content_filter') {
      throw new RecognizeError('refusal', '模型拒绝了这次识别请求，请换一张图再试', 422);
    }

    let json;
    try {
      json = parseModelJson(call.content);
    } catch (err) {
      throw new RecognizeError(
        'invalid_output',
        `模型输出不是 JSON：${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    }

    const parsed = RecognizeResultSchema.safeParse(json);
    if (!parsed.success) {
      const brief = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('；');
      throw new RecognizeError('invalid_output', `模型输出不符合 schema：${brief}`, 502);
    }
    return { parsed: parsed.data, meta: null };
  };

  const { result, retried, warnings: retryWarnings } = await recognizeWithRetry({ attempt });

  // ---- 可选：二次校对（把上一轮 JSON 作为 assistant turn 塞回去，图片仍在上下文里） ----
  let final = result;
  let refined = false;
  const warnings = [...(retryWarnings ?? [])];
  if (options.refine) {
    try {
      const call = await callOnce({
        apiKey,
        model,
        messages: [
          ...buildMessages(input, null, useSchema),
          { role: 'assistant', content: JSON.stringify(result) },
          { role: 'user', content: [{ type: 'text', text: REFINE_USER_TEXT }] },
        ],
        useSchema,
        signal: options.signal,
      });
      addUsage(usage, call.usage);
      if (call.providerName) upstream = call.providerName;
      if (call.finishReason === 'length') throw new Error('输出被长度上限截断');

      const parsed = RecognizeResultSchema.safeParse(parseModelJson(call.content));
      if (!parsed.success) throw new Error('输出不符合 schema');
      // 校对这一轮同样吃「宽容归一化」这道防线（它不走 retry.mjs）
      const fix = fixAxisNormalization(parsed.data);
      const issues = recognizeResultIssues(fix.result);
      if (issues.length > 0) throw new Error(issues.slice(0, 3).join('；'));

      final = sanitizeRecognizeResult(fix.result);
      refined = true;
      warnings.push(...fix.warnings);
    } catch (err) {
      // 二次校对是「锦上添花」：失败一律回退首轮结果，只记 warning，不让整次识别失败
      if (err instanceof Error && err.name === 'AbortError') throw err;
      warnings.push(
        `二次校对失败，已沿用首轮识别结果：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    result: final,
    usage,
    model,
    ms: Date.now() - started,
    provider: 'openrouter',
    structuredOutput: useSchema,
    retried,
    refined,
    warnings,
    upstream,
  };
}

// ---------------------------------------------------------------------------
// M5：房间标注（走同一个 provider / 模型 / 重试策略，只是 schema 与 prompt 换了）
// ---------------------------------------------------------------------------

/** @type {Record<string, unknown> | null} */
let cachedLabelSchema = null;

/** `LabelResult` 的 strict JSON Schema */
export function labelJsonSchema() {
  if (!cachedLabelSchema) cachedLabelSchema = toStrictJsonSchema(LabelResultSchema);
  return cachedLabelSchema;
}

/**
 * 组装标注请求的消息。
 *
 * 有标记图时**两张图都发**：原图看文字（放大过的标记图会糊），标记图看编号落在哪。
 * 顺序是「原图 → 标记图 → 文字」，图片一律放在文字之前（与识别路径一致）。
 *
 * @param {{ base64: string, mediaType: string, imageWidthPx: number, imageHeightPx: number,
 *   roomCount: number, marked: { base64: string, mediaType: string } | null, roomList: string | null }} input
 * @param {string | null} feedback
 * @param {boolean} useSchema
 */
export function buildLabelMessages(input, feedback, useSchema) {
  const system = useSchema
    ? LABEL_SYSTEM_PROMPT
    : `${LABEL_SYSTEM_PROMPT}${LABEL_JSON_ONLY_SUFFIX}\n\n${JSON.stringify(labelJsonSchema())}`;

  const content = [
    { type: 'image_url', image_url: { url: `data:${input.mediaType};base64,${input.base64}` } },
  ];
  if (input.marked) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${input.marked.mediaType};base64,${input.marked.base64}` },
    });
  }
  content.push({
    type: 'text',
    text: buildLabelUserText({
      roomCount: input.roomCount,
      imageWidthPx: input.imageWidthPx,
      imageHeightPx: input.imageHeightPx,
      marked: input.marked !== null,
      roomList: input.roomList,
    }),
  });

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content },
  ];
  if (feedback) messages.push({ role: 'user', content: [{ type: 'text', text: feedback }] });
  return messages;
}

/**
 * 走 OpenRouter 给 CV 分出来的区域做标注。
 *
 * 与 `recognizeWithOpenRouter` 同样的 provider / 模型 / 降级 / **最多重试一次**策略；
 * **没有 refine**——任务简单到没有二次校对的价值（用户裁定），也省一半钱。
 *
 * @param {{ base64: string, mediaType: string, imageWidthPx: number, imageHeightPx: number,
 *   roomCount: number, marked: { base64: string, mediaType: string } | null, roomList: string | null }} input
 * @param {{ model?: string, apiKey?: string, signal?: AbortSignal }} [options]
 */
export async function labelWithOpenRouter(input, options = {}) {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_APIKEY;
  if (!apiKey) {
    throw new RecognizeError(
      'no_api_key',
      '服务端没有配置 OPENROUTER_APIKEY：请复制 .env.example 为 .env 并填入 key（或设 MOCK_RECOGNIZE=1 用示例数据）',
      501,
    );
  }
  const model = options.model || process.env.RECOGNIZE_MODEL || DEFAULT_OPENROUTER_MODEL;
  const started = Date.now();
  const usage = emptyUsage();
  let useSchema = true;
  let upstream = null;

  /** 打一轮，回来的东西 parse + 校验，返回 {result, issues} */
  const attempt = async (feedback) => {
    let call;
    try {
      call = await callOnce({
        apiKey,
        model,
        messages: buildLabelMessages(input, feedback, useSchema),
        useSchema,
        schema: labelJsonSchema(),
        schemaName: LABEL_SCHEMA_NAME,
        signal: options.signal,
      });
    } catch (err) {
      if (useSchema && err instanceof RecognizeError && isResponseFormatUnsupported(err.httpStatus, err.rawMessage)) {
        console.warn(`[openrouter] ${model} 不支持 structured outputs，降级为 prompt 约束的纯 JSON 输出`);
        useSchema = false;
        call = await callOnce({
          apiKey,
          model,
          messages: buildLabelMessages(input, feedback, false),
          useSchema: false,
          signal: options.signal,
        });
      } else {
        throw err;
      }
    }

    addUsage(usage, call.usage);
    if (call.providerName) upstream = call.providerName;
    if (call.finishReason === 'length') {
      throw new RecognizeError('invalid_output', '输出被长度上限截断，请重试', 502);
    }
    if (call.finishReason === 'content_filter') {
      throw new RecognizeError('refusal', '模型拒绝了这次请求，请换一张图再试', 422);
    }

    const parsed = LabelResultSchema.safeParse(parseModelJson(call.content));
    if (!parsed.success) {
      const brief = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('；');
      throw new RecognizeError('invalid_output', `模型输出不符合 schema：${brief}`, 502);
    }
    return { result: parsed.data, issues: labelResultIssues(parsed.data, input.roomCount) };
  };

  let first;
  try {
    first = await attempt(null);
  } catch (err) {
    if (!(err instanceof RecognizeError) || err.code !== 'invalid_output') throw err;
    first = { result: null, issues: [err.message] };
  }

  let retried = false;
  let final = first.result;
  const warnings = [];
  if (!final || first.issues.length > 0) {
    retried = true;
    const second = await attempt(buildLabelRetryText(first.issues, input.roomCount));
    if (second.issues.length > 0) {
      // 标注的硬伤只有「编号对不上」，而 sanitize 会把非法编号丢掉——
      // 与其整次失败，不如带着警告继续（几何本来就不依赖 AI）
      warnings.push(`AI 的房间标注有 ${second.issues.length} 处对不上编号，这些区域已按「房间」处理`);
    }
    final = second.result;
  }

  return {
    result: sanitizeLabelResult(final, input.roomCount),
    usage,
    model,
    ms: Date.now() - started,
    provider: 'openrouter',
    structuredOutput: useSchema,
    retried,
    warnings,
    upstream,
  };
}

/**
 * 拉一次 OpenRouter 的模型列表（免费 GET），用来校验 slug 是否存在。
 * @param {string[]} wanted
 * @returns {Promise<Array<{ id: string, exists: boolean }>>}
 */
export async function checkModelSlugs(wanted) {
  const response = await fetch(OPENROUTER_MODELS_ENDPOINT);
  if (!response.ok) throw new Error(`拉取模型列表失败：HTTP ${response.status}`);
  const payload = await response.json();
  const ids = new Set((payload?.data ?? []).map((m) => m.id));
  return wanted.map((id) => ({ id, exists: ids.has(id) }));
}

export default recognizeWithOpenRouter;
