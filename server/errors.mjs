/**
 * `/api/recognize` 的业务异常类型。
 *
 * 单独一个文件是为了避免 `recognize.mjs ↔ providers/*.mjs` 的循环 import
 * （provider 要抛 RecognizeError，recognize.mjs 又要 import provider）。
 */

/** 带 HTTP 状态与稳定错误码的业务异常 */
export class RecognizeError extends Error {
  /**
   * @param {string} code 前端用来分支的稳定错误码
   * @param {string} message 直接展示给用户的中文文案
   * @param {number} status HTTP 状态码
   */
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'RecognizeError';
    this.code = code;
    this.status = status;
  }
}

/**
 * 兜底包装：已经是 RecognizeError 就原样返回。
 * @param {unknown} err
 * @param {string} [code]
 * @returns {RecognizeError}
 */
export function wrapError(err, code = 'api_error') {
  if (err instanceof RecognizeError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new RecognizeError(code, `识别失败：${message}`);
}
