/**
 * Anthropic 原生 SDK provider（M3 的原始实现，从 `recognize.mjs` 里搬过来的）。
 *
 * 与 OpenRouter 路径的唯一区别是「怎么把消息发出去、怎么拿到结构化结果」；
 * schema 校验与「校验失败重试一次」完全复用 `retry.mjs`。
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  RecognizeResultSchema,
  fixAxisNormalization,
  recognizeResultIssues,
  sanitizeRecognizeResult,
} from '../../src/ai/recognizeSchema.ts';
import { RecognizeError } from '../errors.mjs';
import { REFINE_USER_TEXT, SYSTEM_PROMPT, buildUserContent } from '../prompt.mjs';
import { recognizeWithRetry } from '../retry.mjs';

/** 默认模型（可用 env RECOGNIZE_MODEL 覆盖） */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';
/** 思考 + 输出的上限；不传 thinking 参数（Claude Opus 5 默认 adaptive） */
export const MAX_TOKENS = 16000;

/** SDK 的 typed exception → RecognizeError */
export function toRecognizeError(err) {
  if (err instanceof RecognizeError) return err;
  if (err instanceof Anthropic.AuthenticationError) {
    return new RecognizeError(
      'auth',
      'Anthropic API key 无效或缺失：请在项目根目录 .env 里配置 ANTHROPIC_API_KEY 后重启 dev:api',
      401,
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new RecognizeError('rate_limit', 'API 调用过于频繁，请稍后再试', 429);
  }
  if (err instanceof Anthropic.APIError) {
    return new RecognizeError('api_error', `识别服务出错（${err.status ?? '未知'}）：${err.message}`, 502);
  }
  if (err instanceof Anthropic.AnthropicError) {
    // 非 HTTP 错误：绝大多数是 structured output 没通过 zod
    return new RecognizeError('invalid_output', `模型输出不符合格式：${err.message}`, 502);
  }
  return new RecognizeError('api_error', `识别失败：${err instanceof Error ? err.message : String(err)}`);
}

/**
 * 走 Anthropic 原生 SDK 识别一张間取り図。
 *
 * @param {{ base64: string, mediaType: string, imageWidthPx: number, imageHeightPx: number }} input
 * @param {{ model?: string, signal?: AbortSignal, refine?: boolean }} [options]
 */
export async function recognizeWithAnthropic(input, options = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new RecognizeError(
      'no_api_key',
      '服务端没有配置 ANTHROPIC_API_KEY：请复制 .env.example 为 .env 并填入 key（或设 MOCK_RECOGNIZE=1 用示例数据）',
      501,
    );
  }

  const model = options.model || process.env.RECOGNIZE_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const client = new Anthropic();
  const baseMessages = [{ role: 'user', content: buildUserContent(input) }];
  const started = Date.now();
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, total_cost: 0, calls: 0 };

  const attempt = async (feedback) => {
    const messages = feedback
      ? [...baseMessages, { role: 'user', content: [{ type: 'text', text: feedback }] }]
      : baseMessages;

    const response = await client.messages.parse({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages,
      output_config: { format: zodOutputFormat(RecognizeResultSchema) },
    });

    usage.calls += 1;
    usage.prompt_tokens += response.usage?.input_tokens ?? 0;
    usage.completion_tokens += response.usage?.output_tokens ?? 0;
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

    if (response.stop_reason === 'refusal') {
      throw new RecognizeError('refusal', '模型拒绝了这次识别请求，请换一张图再试', 422);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new RecognizeError('invalid_output', '输出被长度上限截断，请裁剪图片后重试', 502);
    }
    const parsed = response.parsed_output;
    if (!parsed) {
      throw new RecognizeError('invalid_output', '模型没有返回结构化结果，请重试', 502);
    }
    return { parsed, meta: null };
  };

  const { result, retried, warnings: retryWarnings } = await recognizeWithRetry({
    attempt,
    normalizeError: toRecognizeError,
  });

  // ---- 可选：二次校对（上一轮 JSON 作为 assistant turn，图片仍在上下文里） ----
  let final = result;
  let refined = false;
  const warnings = [...(retryWarnings ?? [])];
  if (options.refine) {
    try {
      const response = await client.messages.parse({
        model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          ...baseMessages,
          { role: 'assistant', content: JSON.stringify(result) },
          { role: 'user', content: [{ type: 'text', text: REFINE_USER_TEXT }] },
        ],
        output_config: { format: zodOutputFormat(RecognizeResultSchema) },
      });
      usage.calls += 1;
      usage.prompt_tokens += response.usage?.input_tokens ?? 0;
      usage.completion_tokens += response.usage?.output_tokens ?? 0;
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

      const parsed = response.parsed_output;
      if (!parsed) throw new Error('模型没有返回结构化结果');
      const validated = RecognizeResultSchema.safeParse(parsed);
      if (!validated.success) throw new Error('输出不符合 schema');
      // 校对这一轮同样吃「宽容归一化」这道防线（它不走 retry.mjs）
      const fix = fixAxisNormalization(validated.data);
      const issues = recognizeResultIssues(fix.result);
      if (issues.length > 0) throw new Error(issues.slice(0, 3).join('；'));

      final = sanitizeRecognizeResult(fix.result);
      refined = true;
      warnings.push(...fix.warnings);
    } catch (err) {
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
    provider: 'anthropic',
    structuredOutput: true,
    retried,
    refined,
    warnings,
    upstream: null,
  };
}

export default recognizeWithAnthropic;
