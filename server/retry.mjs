/**
 * **provider 无关**的「校验失败就追加一个 user turn 重试一次」逻辑。
 *
 * 原来这段流程写死在 `recognize.mjs` 的 Anthropic 分支里，
 * 引入 OpenRouter 之后提炼出来，两条路径共用同一份重试策略：
 *
 *   1. 调一次模型 → zod parse → **宽容归一化修正** → `recognizeResultIssues()` 硬伤检查；
 *   2. 通过 → 直接返回；
 *   3. 没通过（或第一次就抛 `invalid_output`）→ 把问题摘要作为追加 user turn 再问一次；
 *   4. 第二次还没过 → 抛 `invalid_output`。
 *
 * 第 1 步的「宽容归一化修正」是 prompt 之外的**第二道防线**：模型在长宽比悬殊的图上
 * 容易改用等比归一化（见 `fixAxisNormalization`），那是单轴线性缩放、信息无损，
 * 直接按比例压回 0~1000 比多烧一次 token 划算得多。
 *
 * **最多重试 1 次**（见 docs/AI-RECOGNITION.md 第 1 节），鉴权 / 限流 / 拒绝一律直接抛出。
 */
import {
  fixAxisNormalization,
  recognizeResultIssues,
  sanitizeRecognizeResult,
} from '../src/ai/recognizeSchema.ts';
import { buildRetryUserText } from '../src/ai/recognizeShared.ts';
import { RecognizeError } from './errors.mjs';

/**
 * @typedef {object} Attempt
 * @property {import('../src/ai/recognizeSchema.ts').RecognizeResult | null} parsed
 * @property {unknown} [meta] provider 自己想带出来的东西（usage 之类）
 */

/**
 * @param {object} options
 * @param {(feedback: string | null) => Promise<Attempt>} options.attempt
 *   调一次模型。`feedback` 非 null 时表示这是重试，要把这段文字作为追加的 user turn。
 * @param {(err: unknown) => RecognizeError} [options.normalizeError]
 *   provider 特有的错误归一化（默认原样透传 RecognizeError）。
 * @returns {Promise<{ result: import('../src/ai/recognizeSchema.ts').RecognizeResult, meta: unknown, retried: boolean, warnings: string[] }>}
 */
export async function recognizeWithRetry({ attempt, normalizeError }) {
  const normalize = normalizeError ?? ((err) => (err instanceof RecognizeError
    ? err
    : new RecognizeError('api_error', `识别失败：${err instanceof Error ? err.message : String(err)}`)));

  /** @type {Attempt} */
  let first;
  try {
    first = await attempt(null);
  } catch (err) {
    const e = normalize(err);
    // 只有「输出不合格」才值得重试；鉴权 / 限流 / 拒绝直接抛出
    if (e.code !== 'invalid_output') throw e;
    first = { parsed: null, meta: null, issues: [e.message] };
  }

  const firstFix = first.parsed
    ? fixAxisNormalization(first.parsed)
    : { result: null, warnings: [] };
  const firstIssues =
    first.issues ?? (firstFix.result ? recognizeResultIssues(firstFix.result) : ['模型没有返回结构化结果']);
  if (firstFix.result && firstIssues.length === 0) {
    return {
      result: sanitizeRecognizeResult(firstFix.result),
      meta: first.meta ?? null,
      retried: false,
      warnings: firstFix.warnings,
    };
  }

  /** @type {Attempt} */
  let second;
  try {
    second = await attempt(buildRetryUserText(firstIssues));
  } catch (err) {
    throw normalize(err);
  }

  const secondFix = second.parsed
    ? fixAxisNormalization(second.parsed)
    : { result: null, warnings: [] };
  const secondIssues = secondFix.result
    ? recognizeResultIssues(secondFix.result)
    : ['模型没有返回结构化结果'];
  if (!secondFix.result || secondIssues.length > 0) {
    throw new RecognizeError(
      'invalid_output',
      `模型两次输出都没通过校验：${secondIssues.slice(0, 3).join('；')}`,
      502,
    );
  }
  return {
    result: sanitizeRecognizeResult(secondFix.result),
    meta: second.meta ?? null,
    retried: true,
    warnings: secondFix.warnings,
  };
}
