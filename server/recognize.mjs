/**
 * M3：`/api/recognize` 的**框架无关** handler（见 docs/AI-RECOGNITION.md 第 1 节）。
 *
 *   recognize(body)         -> Promise<RecognizeResult>          // 只要结果
 *   recognizeDetailed(body) -> Promise<{result, usage, model, …}> // 带 usage / 耗时（测试脚本用）
 *
 * 本地开发由 `server/dev.mjs`（node:http）包一层；将来上 Vercel 只要再包一层
 * `(req, res)` 即可，业务逻辑不动。
 *
 * 实现约定：
 * - 纯 JS + JSDoc，**不经过 vite / tsc**，`node server/dev.mjs` 能直接跑；
 * - zod schema 从 `src/ai/recognizeSchema.ts` 直接 import（Node 24 原生剥离类型注解），
 *   保证前后端**同一份 schema**，不存在两份定义漂移的问题；
 * - 服务端**最多重试 1 次**（见 `server/retry.mjs`，两个 provider 共用）；
 * - provider 具体实现在 `server/providers/*.mjs`（openrouter / anthropic）。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  RecognizeResultSchema,
  applyImageAspect,
  sanitizeRecognizeResult,
} from '../src/ai/recognizeSchema.ts';
import {
  CV_FALLBACK_WARNING,
  CV_INSUFFICIENT_MESSAGE,
  cvStatsPayload,
  extractCvGeometry,
  fuseExtract,
  isExtractUsable,
  isExtractUsableForCv,
  labelFuseExtract,
} from './cvPipeline.mjs';
import { RecognizeError } from './errors.mjs';
import { buildMarkedImage, roomListText } from './markedImage.mjs';
import { DEFAULT_ANTHROPIC_MODEL, recognizeWithAnthropic } from './providers/anthropic.mjs';
import {
  DEFAULT_OPENROUTER_MODEL,
  labelWithOpenRouter,
  recognizeWithOpenRouter,
} from './providers/openrouter.mjs';

export { RecognizeError } from './errors.mjs';
export { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENROUTER_MODEL };
export {
  CV_FALLBACK_WARNING,
  CV_INSUFFICIENT_MESSAGE,
  MIN_HYBRID_WALLS,
  MIN_CV_ROOMS,
  MIN_CV_WALLS,
} from './cvPipeline.mjs';

/**
 * 可选的识别管线：
 * - `cv`（**默认**，M5 架构）：几何唯一来源 = OpenCV，AI 只按编号做房间标注；
 * - `hybrid`（M4，保留供对比）：CV 提几何 + VLM 提语义，靠中心点挂载融合；
 * - `vlm`（M3，保留供对比）：纯 AI 出几何。
 *
 * `hybrid` / `vlm` 仍然留在 API 与 `test-recognize.mjs` 里，但**已从 UI 移除**
 * ——2026-08-11 用户裁定：VLM 出几何的路线废弃。
 */
export const RECOGNIZE_PIPELINES = ['cv', 'hybrid', 'vlm'];
/**
 * 默认管线。2026-08-11 用户裁定：几何唯一来源 = OpenCV，
 * CV 提取不达标**直接报错**引导手动描图，不再回退 AI 画几何。
 */
export const DEFAULT_PIPELINE = 'cv';

/** 兼容旧引用：默认模型 = Anthropic 路径的默认模型 */
export const DEFAULT_MODEL = DEFAULT_ANTHROPIC_MODEL;
/** 允许的图片 MIME */
const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
/** CV 管线能解码的格式（`src/cv/decode.ts` 只有 jpeg-js + pngjs） */
const CV_DECODABLE_TYPES = new Set(['image/jpeg', 'image/png']);
/** mock 返回前的假延迟，让 UI 的 spinner 有机会露脸 */
export const MOCK_DELAY_MS = 800;

/**
 * 请求体里 `model` 字段的默认 allowlist（可用 env `RECOGNIZE_MODELS` 覆盖，逗号分隔）。
 * 2026-08-11 五图对比测试后用户裁定：qwen 质量不稳弃用、gemini 未测弃用，
 * 只保留 gpt-5.6-luna-pro（+refine 默认开）。
 */
export const DEFAULT_RECOGNIZE_MODELS = ['openai/gpt-5.6-luna-pro'];

const MOCK_FIXTURE_URL = new URL('./fixtures/mock-2ldk.json', import.meta.url);

export function isMockEnabled() {
  const v = process.env.MOCK_RECOGNIZE;
  return v === '1' || v === 'true';
}

// ---------------------------------------------------------------------------
// provider / 模型选择
// ---------------------------------------------------------------------------

/**
 * provider 选择：
 * 1. 显式的 env `RECOGNIZE_PROVIDER`（`openrouter` | `anthropic`）优先；
 * 2. 否则：有 OPENROUTER_APIKEY 且没有 ANTHROPIC_API_KEY → openrouter；
 * 3. 其余情况 → anthropic（保持 M3 的原有行为）。
 * @returns {'openrouter' | 'anthropic'}
 */
export function resolveProvider() {
  const explicit = (process.env.RECOGNIZE_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'openrouter' || explicit === 'anthropic') return explicit;
  if (explicit) {
    throw new RecognizeError(
      'bad_request',
      `RECOGNIZE_PROVIDER 只能是 openrouter 或 anthropic，当前是 "${explicit}"`,
      500,
    );
  }
  if (process.env.OPENROUTER_APIKEY && !process.env.ANTHROPIC_API_KEY) return 'openrouter';
  return 'anthropic';
}

/** 请求体里 `model` 字段的 allowlist */
export function allowedModels() {
  const raw = process.env.RECOGNIZE_MODELS;
  if (!raw) return [...DEFAULT_RECOGNIZE_MODELS];
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : [...DEFAULT_RECOGNIZE_MODELS];
}

/** 当前生效的模型（没有显式指定时 provider 各自的默认值） */
export function resolveModel(provider = resolveProvider()) {
  return (
    process.env.RECOGNIZE_MODEL ||
    (provider === 'openrouter' ? DEFAULT_OPENROUTER_MODEL : DEFAULT_ANTHROPIC_MODEL)
  );
}

/** `GET /api/recognize/info` 的内容：给 UI 展示当前 provider/model，并提供模型下拉的选项 */
export function recognizeInfo() {
  const mock = isMockEnabled();
  let provider;
  try {
    provider = resolveProvider();
  } catch {
    provider = 'anthropic';
  }
  return {
    provider,
    model: resolveModel(provider),
    models: allowedModels(),
    mock,
    pipeline: DEFAULT_PIPELINE,
    pipelines: [...RECOGNIZE_PIPELINES],
  };
}

// ---------------------------------------------------------------------------
// 入参处理
// ---------------------------------------------------------------------------

/**
 * 拆 `data:image/jpeg;base64,xxxx` → { mediaType, base64 }
 * @param {string} dataUrl
 */
export function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
    throw new RecognizeError('bad_request', '缺少图片数据', 400);
  }
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/is.exec(dataUrl.trim());
  if (!m) {
    throw new RecognizeError('bad_request', '图片必须是 base64 的 data URL', 400);
  }
  const mediaType = m[1].toLowerCase();
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
    throw new RecognizeError('bad_request', `不支持的图片格式：${mediaType}`, 400);
  }
  return { mediaType, base64: m[2] };
}

/**
 * @param {unknown} body
 * @returns {{ mediaType: string, base64: string, imageWidthPx: number, imageHeightPx: number, model: string | null, refine: boolean, pipeline: 'cv' | 'vlm' | 'hybrid', ignoreSmallRooms: boolean }}
 */
export function normalizeRequestBody(body) {
  if (!body || typeof body !== 'object') {
    throw new RecognizeError('bad_request', '请求体必须是 JSON 对象', 400);
  }
  const {
    imageDataUrl,
    imageWidthPx,
    imageHeightPx,
    model,
    refine,
    pipeline,
    ignoreSmallRooms,
  } = /** @type {any} */ (body);
  const { mediaType, base64 } = parseImageDataUrl(imageDataUrl);
  const w = Number(imageWidthPx);
  const h = Number(imageHeightPx);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new RecognizeError('bad_request', '缺少有效的图片像素尺寸', 400);
  }

  let picked = null;
  if (model !== undefined && model !== null && model !== '') {
    if (typeof model !== 'string') {
      throw new RecognizeError('bad_request', 'model 必须是字符串', 400);
    }
    const allowed = allowedModels();
    if (!allowed.includes(model)) {
      throw new RecognizeError(
        'bad_request',
        `不允许的模型 "${model}"，可选：${allowed.join(' / ')}（改 env RECOGNIZE_MODELS 可扩展）`,
        400,
      );
    }
    picked = model;
  }

  if (refine !== undefined && refine !== null && typeof refine !== 'boolean') {
    throw new RecognizeError('bad_request', 'refine 必须是布尔值', 400);
  }

  let pickedPipeline = DEFAULT_PIPELINE;
  if (pipeline !== undefined && pipeline !== null && pipeline !== '') {
    if (typeof pipeline !== 'string' || !RECOGNIZE_PIPELINES.includes(pipeline)) {
      throw new RecognizeError(
        'bad_request',
        `pipeline 只能是 ${RECOGNIZE_PIPELINES.join(' / ')}`,
        400,
      );
    }
    pickedPipeline = pipeline;
  }

  // M4.2：小隔间（洗面所 / トイレ / 玄関 …）挂载失败时安静忽略，**默认开**。
  // M5 起这个开关**只对 hybrid 管线有意义**（cv 管线不存在「挂载失败」这回事），
  // 字段本身保留是为了 API 兼容——UI 已经把勾选框摘掉了。
  if (
    ignoreSmallRooms !== undefined &&
    ignoreSmallRooms !== null &&
    typeof ignoreSmallRooms !== 'boolean'
  ) {
    throw new RecognizeError('bad_request', 'ignoreSmallRooms 必须是布尔值', 400);
  }

  return {
    mediaType,
    base64,
    imageWidthPx: Math.round(w),
    imageHeightPx: Math.round(h),
    model: picked,
    refine: refine === true,
    pipeline: pickedPipeline,
    ignoreSmallRooms: ignoreSmallRooms !== false,
  };
}

// ---------------------------------------------------------------------------
// mock
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** MOCK_RECOGNIZE=1 时返回的手工 fixture（同样过一遍 schema，保证 fixture 不腐坏） */
export async function loadMockResult() {
  const text = await readFile(fileURLToPath(MOCK_FIXTURE_URL), 'utf8');
  const parsed = RecognizeResultSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new RecognizeError('invalid_output', `mock fixture 不符合 schema：${parsed.error.message}`);
  }
  return sanitizeRecognizeResult(parsed.data);
}

// ---------------------------------------------------------------------------
// 业务入口
// ---------------------------------------------------------------------------

/**
 * `/api/recognize` 的业务入口（带调用元信息）。
 *
 * `pipeline: 'hybrid'`（默认）时：**本地 CV 提取与 VLM 调用并行跑**（`Promise.all`），
 * 两边都回来之后交给 `fuseCvAndVlm` 融合，响应里多带 `solved`（融合好的 SolveResult）
 * 与 `cv`（统计）。CV 提取不达标（没有房间 / 墙段 < 6）就**自动回退纯 VLM**并加一条 warning
 * ——test1 这类整版广告图会走到这里。
 *
 * @param {unknown} body 已解析的 JSON 请求体
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function recognizeDetailed(body, options = {}) {
  const input = normalizeRequestBody(body);

  if (isMockEnabled()) {
    const started = Date.now();
    await sleep(MOCK_DELAY_MS);
    return {
      result: await loadMockResult(),
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, total_cost: 0, calls: 0 },
      model: 'mock',
      provider: 'mock',
      ms: Date.now() - started,
      structuredOutput: true,
      retried: false,
      refined: false,
      warnings: [],
      upstream: null,
      // mock 永远走纯 VLM：fixture 里没有图片，CV 无从提取
      pipeline: 'vlm',
      pipelineRequested: input.pipeline,
      cv: null,
      label: null,
      solved: null,
    };
  }

  const provider = resolveProvider();
  if (input.pipeline === 'cv') return recognizeWithCv(input, options, provider);

  const call = provider === 'openrouter' ? recognizeWithOpenRouter : recognizeWithAnthropic;
  // 模型给的是「x 除图宽、y 除图高」的每轴独立归一化；`solve.ts` / `fuse.ts` 一路
  // 假定两轴同一比例尺（都按图宽归一化）。**校验与 sanitize 之后**在这里转换一次，
  // 之后整条下游（含返回给前端的 result）拿到的都是内部坐标系。
  const vlmPromise = call(input, {
    model: input.model ?? undefined,
    signal: options.signal,
    refine: input.refine,
  }).then((vlm) => ({
    ...vlm,
    result: applyImageAspect(vlm.result, input.imageWidthPx, input.imageHeightPx),
  }));

  if (input.pipeline !== 'hybrid') {
    const vlm = await vlmPromise;
    return { ...vlm, pipeline: 'vlm', pipelineRequested: input.pipeline, cv: null, solved: null };
  }

  // CV 是本地纯计算，跟网络调用并行跑；失败不影响识别本身，降级成纯 VLM。
  // decodeImage 只认 PNG / JPEG，webp / gif 直接跳过 CV（别浪费一次解码异常）。
  const cvPromise = CV_DECODABLE_TYPES.has(input.mediaType)
    ? extractCvGeometry(input.base64).then(
        (extract) => ({ extract, error: null }),
        (err) => ({ extract: null, error: err instanceof Error ? err.message : String(err) }),
      )
    : Promise.resolve({ extract: null, error: `${input.mediaType} 暂不支持轮廓提取` });
  const [vlm, cv] = await Promise.all([vlmPromise, cvPromise]);

  if (!isExtractUsable(cv.extract)) {
    const detail = cv.error ? `${CV_FALLBACK_WARNING}（${cv.error}）` : CV_FALLBACK_WARNING;
    return {
      ...vlm,
      pipeline: 'vlm',
      pipelineRequested: 'hybrid',
      cv: cvStatsPayload(cv.extract),
      solved: null,
      warnings: [...(vlm.warnings ?? []), detail],
    };
  }

  const dims = {
    imageWidthPx: cv.extract.stats.imageWidthPx,
    imageHeightPx: cv.extract.stats.imageHeightPx,
    ignoreSmallRooms: input.ignoreSmallRooms,
  };
  const solved = await fuseExtract(cv.extract, vlm.result, dims);
  return {
    ...vlm,
    pipeline: 'hybrid',
    pipelineRequested: 'hybrid',
    // CV 自己的 warnings（降采样之类）留在 cv.warnings 里，不往用户面前推
    cv: cvStatsPayload(cv.extract, solved.fuseStats),
    solved,
    warnings: [...(vlm.warnings ?? [])],
  };
}

// ---------------------------------------------------------------------------
// M5：cv 管线（几何唯一来源 = OpenCV，AI 只做房间标注）
// ---------------------------------------------------------------------------

/**
 * 把标注结果套回 `RecognizeResult` 的形状。
 *
 * 前端与测试脚本的既有契约里 `result` 一定是 `RecognizeResult`；cv 管线的 AI
 * **不产出任何几何**，所以这里给的是一份「有 notes、有比例、rooms 为空」的壳，
 * 真正的成果全在 `solved` 里。rooms 留空是诚实的表达：这条路径下 AI 没有画任何东西。
 *
 * @param {import('../src/ai/labelSchema.ts').LabelResult} labels
 * @param {number} mmPerPx
 * @param {number} imageWidthPx
 * @param {string} scaleBasis
 */
function labelsAsRecognizeResult(labels, mmPerPx, imageWidthPx, scaleBasis) {
  return {
    notes: labels.notes ?? '',
    scale: {
      method: scaleBasis === 'tatami' ? 'tatami' : 'estimate',
      drawingWidthMm: Math.round(mmPerPx * imageWidthPx),
    },
    rooms: [],
    openings: [],
    columns: [],
  };
}

/**
 * cv 管线：**先 CV 后 AI**（与 hybrid 的并行不同——AI 要看 CV 分出来的编号，只能串行）。
 *
 *   extractGeometry → 达标校验（不达标直接抛 `cv_insufficient`）
 *   → buildMarkedImage（画不了就退化成文字清单）→ 标注调用 → labelFuse
 *
 * @param {ReturnType<typeof normalizeRequestBody>} input
 * @param {{ signal?: AbortSignal }} options
 * @param {'openrouter' | 'anthropic'} provider
 */
async function recognizeWithCv(input, options, provider) {
  const started = Date.now();
  if (provider !== 'openrouter') {
    throw new RecognizeError(
      'bad_request',
      'cv 管线目前只支持 OpenRouter provider：请在 .env 里配置 OPENROUTER_APIKEY（或设 RECOGNIZE_PROVIDER=openrouter）',
      501,
    );
  }
  if (!CV_DECODABLE_TYPES.has(input.mediaType)) {
    throw new RecognizeError(
      'bad_request',
      `轮廓提取只能处理 PNG / JPEG，当前是 ${input.mediaType}，请换一张图`,
      400,
    );
  }

  /** @type {import('../src/cv/types.ts').CvExtract | null} */
  let extract = null;
  let extractError = null;
  try {
    extract = await extractCvGeometry(input.base64);
  } catch (err) {
    extractError = err instanceof Error ? err.message : String(err);
  }

  if (!isExtractUsableForCv(extract)) {
    const detail = extractError
      ? `${CV_INSUFFICIENT_MESSAGE}（${extractError}）`
      : extract
        ? `${CV_INSUFFICIENT_MESSAGE}（只提取到 ${extract.rooms.length} 块区域 / ${extract.walls.length} 段墙）`
        : CV_INSUFFICIENT_MESSAGE;
    const err = new RecognizeError('cv_insufficient', detail, 422);
    err.details = { cv: cvStatsPayload(extract) };
    throw err;
  }

  // 编号标记图：画得出就画（AI 看图认编号最直观），画不出退化成文字清单
  let marked = null;
  let markedError = null;
  try {
    marked = await buildMarkedImage(input.base64, extract);
  } catch (err) {
    markedError = err instanceof Error ? err.message : String(err);
  }
  const roomList = marked ? null : await roomListText(extract);

  const label = await labelWithOpenRouter(
    {
      base64: input.base64,
      mediaType: input.mediaType,
      imageWidthPx: input.imageWidthPx,
      imageHeightPx: input.imageHeightPx,
      roomCount: extract.rooms.length,
      marked: marked ? { base64: marked.base64, mediaType: marked.mediaType } : null,
      roomList,
    },
    { model: input.model ?? undefined, signal: options.signal },
  );

  const solved = await labelFuseExtract(extract, label.result, {
    imageWidthPx: extract.stats.imageWidthPx,
    imageHeightPx: extract.stats.imageHeightPx,
  });

  const warnings = [...(label.warnings ?? [])];
  if (markedError) {
    warnings.push(`编号标记图生成失败，已改用文字坐标清单标注（${markedError}）`);
  }

  return {
    result: labelsAsRecognizeResult(
      label.result,
      solved.labelStats.mmPerPixel,
      extract.stats.imageWidthPx,
      solved.labelStats.scaleBasis,
    ),
    /** M5 专有：AI 的原始标注（测试脚本用来算命中率） */
    label: label.result,
    usage: label.usage,
    model: label.model,
    provider: label.provider,
    ms: Date.now() - started,
    structuredOutput: label.structuredOutput,
    retried: label.retried,
    refined: false,
    warnings,
    upstream: label.upstream,
    pipeline: 'cv',
    pipelineRequested: 'cv',
    cv: {
      ...cvStatsPayload(extract, solved.labelStats),
      /** 走的是标记图还是文字清单 */
      markerMode: marked ? 'marked_image' : 'text_list',
    },
    solved,
  };
}

/**
 * `/api/recognize` 的业务入口（只要识别结果，M3 起的既有签名）。
 * @param {unknown} body
 * @returns {Promise<import('../src/ai/recognizeSchema.ts').RecognizeResult>}
 */
export async function recognize(body) {
  const { result } = await recognizeDetailed(body);
  return result;
}

export default recognize;
