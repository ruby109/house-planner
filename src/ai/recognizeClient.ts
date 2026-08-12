/**
 * M3：前端调用 `/api/recognize` 的薄封装（见 docs/AI-RECOGNITION.md 第 5 节）。
 *
 * 前端**永远不接触 API key**：图片压缩后 POST 给本地 API 服务（vite `/api` proxy → :8787），
 * 由服务端调用 Anthropic。这里只负责请求、错误文案归一化、以及对返回结果再做一次 zod 校验。
 */
import { z } from 'zod';
import {
  FloorTypeSchema,
  OpeningSwingSchema,
  OpeningTypeSchema,
  StructureKindSchema,
} from '../model/schema';
import type { SolveResult } from './solve';
import {
  RecognizeResultSchema,
  sanitizeRecognizeResult,
  type RecognizeResult,
} from './recognizeSchema';

export const RECOGNIZE_ENDPOINT = '/api/recognize';
export const RECOGNIZE_INFO_ENDPOINT = '/api/recognize/info';

/**
 * 识别管线：
 * - `cv`（**默认**，M5）：几何唯一来源 = 轮廓提取，AI 只按编号做房间标注；
 * - `hybrid`（M4）/ `vlm`（M3）：保留在 API 与测试脚本里供对比，**UI 已不再暴露**。
 */
export type RecognizePipeline = 'cv' | 'vlm' | 'hybrid';

export interface RecognizeRequest {
  /** 压缩后的 JPEG dataURL（复用 utils/underlayImage.ts 的压缩） */
  imageDataUrl: string;
  imageWidthPx: number;
  imageHeightPx: number;
  /** 可选：指定模型（必须在服务端 allowlist 里，见 RecognizeInfo.models） */
  model?: string;
  /** 可选：识别成功后再让模型对照图片校对一轮（更准，但耗时与费用翻倍） */
  refine?: boolean;
  /** 可选：识别管线，默认服务端的 `hybrid` */
  pipeline?: RecognizePipeline;
  /**
   * 可选（M4.2）：hybrid 下把挂载失败的小隔间（洗面所 / トイレ / 玄関 …）安静忽略，
   * **服务端默认 true**。传 false 会像以前一样为每个丢弃的小隔间报一条 warning。
   */
  ignoreSmallRooms?: boolean;
}

/** hybrid 模式下服务端 CV 提取的统计（给完成面板显示） */
export interface RecognizeCvStats {
  walls: number;
  rooms: number;
  mode: string;
  wallStrokePx: number;
  deskewDeg: number;
  elapsedMs: number;
  imageWidthPx: number;
  imageHeightPx: number;
  warnings: string[];
  /** M4.1：被剔除的虚线链 / 细线框 / 孤岛墙段 */
  dashChainsRemoved?: number;
  thinBlobsRemoved?: number;
  islandWallsRemoved?: number;
  borderWallsDropped?: number;
  shortDiagonalsDropped?: number;
  matchedRooms?: number;
  /** M4.1：靠 IoU 兜底挂上的房间数 / 并进邻居的无名碎块数 */
  iouMountedRooms?: number;
  unnamedMerged?: number;
  /** M4.2：挂载失败后被安静忽略的小隔间数 */
  ignoredSmallRooms?: number;
  scaleBasis?: string;
  mmPerPixel?: number;
  /** M5：洞口 / 柱候选数与实际落进墙里的洞口数 */
  openingCandidates?: number;
  columnCandidates?: number;
  openingsPlaced?: number;
  /** M5：AI 给出名字的房间数 / 带帖数标注的房间数 */
  namedRooms?: number;
  tatamiRooms?: number;
  /** M5：标注走的是编号标记图还是文字清单 */
  markerMode?: 'marked_image' | 'text_list';
  /** M5.2：拼回同一个房间的碎块数 / 摘掉的吧台隔断段数 / 摘墙后剩下的悬空端点数 */
  mergedPieces?: number;
  fakePartitionsRemoved?: number;
  danglingEndsAfterMerge?: number;
}

export interface RecognizeResponse {
  result: RecognizeResult;
  /** 服务端侧的提示（例如二次校对失败已回退、CV 提取失败已回退纯 AI） */
  warnings: string[];
  /**
   * hybrid 成功时，服务端已经融合好的几何（与本地 `solveRecognizeResult` 同型）。
   * 为 null 说明走的是纯 VLM 路径，前端自己跑 solver。
   */
  solved: SolveResult | null;
  /** 服务端**实际**用的管线（请求 hybrid 但 CV 不达标时会是 'vlm'） */
  pipeline: RecognizePipeline;
  cv: RecognizeCvStats | null;
}

// ---------------------------------------------------------------------------
// solved 的校验
// ---------------------------------------------------------------------------

/**
 * 服务端融合结果的**宽松**校验：只卡结构与有限数，不卡 `model/schema.ts` 的整数约束
 * ——洞口 offset 是沿墙投影出来的小数（纯 VLM 路径也一样），卡整数会误杀。
 */
const LoosePt = z.object({ x: z.number().finite(), y: z.number().finite() });
const SolvedResultSchema = z.object({
  walls: z.array(z.object({ id: z.string(), start: LoosePt, end: LoosePt })),
  openings: z.array(
    z.object({
      id: z.string(),
      wallId: z.string(),
      type: OpeningTypeSchema,
      offset: z.number().finite(),
      width: z.number().finite().positive(),
      swing: OpeningSwingSchema.optional(),
    }),
  ),
  structures: z.array(
    z.object({
      id: z.string(),
      kind: StructureKindSchema,
      position: LoosePt,
      width: z.number().finite().positive(),
      depth: z.number().finite().positive(),
      rotation: z.number().finite(),
    }),
  ),
  rooms: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      polygon: z.array(LoosePt),
      floor: FloorTypeSchema,
    }),
  ),
  underlay: z.object({
    mmPerPixel: z.number().finite().positive(),
    offset: LoosePt,
    rotation: z.number().finite().optional(),
  }),
  mmPerUnit: z.number().finite(),
  areaMismatchRoomIds: z.array(z.string()),
  warnings: z.array(z.string()),
});

/** 解析服务端的 `solved`；形状不对就返回 null（调用方退回本地 solver） */
export function parseSolvedResult(raw: unknown): SolveResult | null {
  if (raw === null || raw === undefined) return null;
  const parsed = SolvedResultSchema.safeParse(raw);
  return parsed.success ? (parsed.data as SolveResult) : null;
}

function parseCvStats(raw: unknown): RecognizeCvStats | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.walls !== 'number' || typeof v.rooms !== 'number') return null;
  return {
    ...(v as unknown as RecognizeCvStats),
    warnings: Array.isArray(v.warnings) ? v.warnings.filter((w): w is string => typeof w === 'string') : [],
  };
}

/** `GET /api/recognize/info` 的返回：当前 provider / 模型 / 可选模型 */
export interface RecognizeInfo {
  /** 'openrouter' | 'anthropic' | 'mock' */
  provider: string;
  /** 没有显式指定 model 时实际会用的模型 */
  model: string;
  /** 请求体 model 字段的 allowlist（给下拉框用） */
  models: string[];
  /** 服务端是否在 mock 模式 */
  mock: boolean;
  /** 服务端的默认管线（UI 的初始选项跟着它走，免得两边默认值漂移） */
  pipeline: RecognizePipeline;
}

/**
 * 查一次服务端配置。**失败一律返回 null**（这只是给对话框显示一行小字，
 * 不该因为它挂掉而阻塞识别流程——服务端没起来时 start() 会给出更准确的报错）。
 */
export async function fetchRecognizeInfo(signal?: AbortSignal): Promise<RecognizeInfo | null> {
  try {
    const response = await fetch(RECOGNIZE_INFO_ENDPOINT, { signal });
    if (!response.ok) return null;
    const data = (await response.json()) as Partial<RecognizeInfo> | null;
    if (!data || typeof data.provider !== 'string' || typeof data.model !== 'string') return null;
    return {
      provider: data.provider,
      model: data.model,
      models: Array.isArray(data.models) ? data.models.filter((m) => typeof m === 'string') : [],
      mock: data.mock === true,
      pipeline:
        data.pipeline === 'vlm' || data.pipeline === 'hybrid' || data.pipeline === 'cv'
          ? data.pipeline
          : 'cv',
    };
  } catch {
    return null;
  }
}

/** 服务端返回的稳定错误码 */
export type RecognizeErrorCode =
  | 'bad_request'
  | 'no_api_key'
  | 'auth'
  | 'rate_limit'
  | 'refusal'
  | 'invalid_output'
  | 'api_error'
  | 'network'
  | 'not_found'
  /** M5：轮廓提取不达标（房间 < 2 或墙 < 6），前端据此引导「换图 / 描摹底图」 */
  | 'cv_insufficient';

export class RecognizeRequestError extends Error {
  readonly code: RecognizeErrorCode;

  constructor(code: RecognizeErrorCode, message: string) {
    super(message);
    this.name = 'RecognizeRequestError';
    this.code = code;
  }
}

interface ErrorPayload {
  error?: { code?: string; message?: string };
}

const KNOWN_CODES = new Set<string>([
  'bad_request',
  'no_api_key',
  'auth',
  'rate_limit',
  'refusal',
  'invalid_output',
  'api_error',
  'network',
  'not_found',
  'cv_insufficient',
]);

function toCode(raw: unknown): RecognizeErrorCode {
  return typeof raw === 'string' && KNOWN_CODES.has(raw) ? (raw as RecognizeErrorCode) : 'api_error';
}

/**
 * 发起一次识别。失败一律抛 `RecognizeRequestError`（带可分支的 code 与可直接展示的中文 message）。
 */
export async function requestRecognition(
  request: RecognizeRequest,
  signal?: AbortSignal,
): Promise<RecognizeResponse> {
  let response: Response;
  try {
    response = await fetch(RECOGNIZE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new RecognizeRequestError(
      'network',
      '连不上识别服务：请确认已经运行 `npm run dev:api`（默认 http://localhost:8787）',
    );
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const body = (payload ?? {}) as ErrorPayload;
    // 服务端没起来时，vite proxy 会返回一个非 JSON 的 500/504——按「连不上」提示，
    // 否则用户只会看到一个没头没尾的 HTTP 状态码
    if (!body.error?.message) {
      if (response.status === 404) {
        throw new RecognizeRequestError(
          'not_found',
          '识别服务没有响应 /api/recognize：请确认已经运行 `npm run dev:api`',
        );
      }
      if (response.status >= 500) {
        throw new RecognizeRequestError(
          'network',
          `连不上识别服务（HTTP ${response.status}）：请确认已经运行 \`npm run dev:api\`（默认 http://localhost:8787）`,
        );
      }
    }
    throw new RecognizeRequestError(
      toCode(body.error?.code),
      body.error?.message || `识别失败（HTTP ${response.status}）`,
    );
  }

  const body = (payload ?? {}) as {
    result?: unknown;
    warnings?: unknown;
    solved?: unknown;
    pipeline?: unknown;
    cv?: unknown;
  };
  const parsed = RecognizeResultSchema.safeParse(body.result);
  if (!parsed.success) {
    throw new RecognizeRequestError('invalid_output', '识别结果格式不正确，请重试');
  }
  const solved = parseSolvedResult(body.solved);
  const warnings = Array.isArray(body.warnings)
    ? body.warnings.filter((w): w is string => typeof w === 'string')
    : [];
  if (body.solved && !solved) {
    warnings.push('服务端返回的融合几何格式不正确，已改用本地求解器');
  }
  return {
    result: sanitizeRecognizeResult(parsed.data),
    warnings,
    solved,
    // solved 没解析出来就当纯 VLM 走（前端会自己跑 solver）
    pipeline:
      solved && (body.pipeline === 'cv' || body.pipeline === 'hybrid')
        ? (body.pipeline as RecognizePipeline)
        : 'vlm',
    cv: parseCvStats(body.cv),
  };
}
