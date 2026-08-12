/**
 * M3：本地开发用的极简 API 服务（见 docs/AI-RECOGNITION.md 第 1 节）。
 *
 *   node --env-file=.env server/dev.mjs      # npm run dev:api
 *
 * 处理两个接口：
 *   POST /api/recognize       —— 识别一张間取り図
 *   GET  /api/recognize/info  —— 当前 provider / model / 可选模型（给对话框显示）
 *
 * 不需要 CORS——前端走 vite 的 `/api` proxy。
 * 业务逻辑全在框架无关的 `server/recognize.mjs` 里，这里只做 HTTP 的壳。
 */
import { createServer } from 'node:http';
import { RecognizeError } from './errors.mjs';
import { isMockEnabled, recognizeDetailed, recognizeInfo } from './recognize.mjs';

// `npm run dev:api:mock` —— 跨平台地打开 mock，不用在命令行里写环境变量
if (process.argv.includes('--mock')) process.env.MOCK_RECOGNIZE = '1';

const PORT = Number(process.env.API_PORT || 8787);
/** 压缩后的底图 dataURL 上限 1.5MB，留足余量 */
const MAX_BODY_BYTES = 20 * 1024 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RecognizeError('bad_request', '图片太大，请换一张', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** usage → 一行日志（绝不打印 key） */
function usageLine(call) {
  const u = call.usage || {};
  const tokens = `${u.prompt_tokens ?? 0}+${u.completion_tokens ?? 0} tok`;
  const cost = u.total_cost ? `, $${u.total_cost.toFixed(6)}` : '';
  const mode = call.structuredOutput ? 'json_schema' : 'prompt-json';
  const flags = [mode];
  if (call.retried) flags.push('retried');
  if (call.refined) flags.push('refined');
  return `${call.provider}/${call.model} [${flags.join(', ')}] ${tokens}${cost}`;
}

const server = createServer(async (req, res) => {
  const path = (req.url || '').split('?')[0];

  if (path === '/api/recognize/info') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: { code: 'method_not_allowed', message: '只支持 GET' } });
      return;
    }
    sendJson(res, 200, recognizeInfo());
    return;
  }

  if (path !== '/api/recognize') {
    sendJson(res, 404, { error: { code: 'not_found', message: '未知接口' } });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { code: 'method_not_allowed', message: '只支持 POST' } });
    return;
  }

  try {
    const text = await readBody(req);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RecognizeError('bad_request', '请求体不是合法 JSON', 400);
    }
    const call = await recognizeDetailed(body);
    const { result } = call;
    const cvLine = call.cv
      ? ` — cv ${call.cv.walls} walls / ${call.cv.rooms} rooms (${call.cv.elapsedMs}ms)`
      : '';
    console.log(
      `[recognize:${call.pipeline}] ok in ${call.ms}ms — ${result.rooms.length} rooms / ` +
        `${result.openings.length} openings / ${result.columns.length} columns — ${usageLine(call)}${cvLine}`,
    );
    sendJson(res, 200, {
      result,
      warnings: call.warnings ?? [],
      // cv / hybrid 成功时带上融合好的几何；纯 VLM 路径为 null，前端自己跑 solver
      solved: call.solved ?? null,
      pipeline: call.pipeline ?? 'vlm',
      cv: call.cv ?? null,
      // M5：AI 的原始房间标注（调试 / 测试脚本用）
      label: call.label ?? null,
      meta: {
        provider: call.provider,
        model: call.model,
        ms: call.ms,
        refined: call.refined === true,
        pipelineRequested: call.pipelineRequested ?? null,
      },
    });
  } catch (err) {
    const status = err instanceof RecognizeError ? err.status : 500;
    const code = err instanceof RecognizeError ? err.code : 'api_error';
    const message = err instanceof Error ? err.message : '识别失败';
    console.error(`[recognize] ${code}: ${message}`);
    // M5：cv_insufficient 会带上 CV 的统计，前端据此在错误面板里说清「提到了多少」
    const details = err instanceof RecognizeError ? (err.details ?? null) : null;
    sendJson(res, status, { error: { code, message, ...(details ? { details } : {}) } });
  }
});

server.listen(PORT, () => {
  console.log(`house-planner recognize API → http://localhost:${PORT}/api/recognize`);
  if (isMockEnabled()) {
    console.log('MOCK_RECOGNIZE=1：返回 server/fixtures/mock-2ldk.json，不会真的调用 API');
    return;
  }
  const info = recognizeInfo();
  if (info.provider === 'openrouter' && !process.env.OPENROUTER_APIKEY) {
    console.log('⚠ 未检测到 OPENROUTER_APIKEY —— 复制 .env.example 为 .env 填入 key，');
    console.log('  或先用 mock 模式开发：npm run dev:api:mock');
  } else if (info.provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    console.log('⚠ 未检测到 ANTHROPIC_API_KEY —— 复制 .env.example 为 .env 填入 key，');
    console.log('  或先用 mock 模式开发：npm run dev:api:mock');
  } else {
    console.log(`provider：${info.provider}，模型：${info.model}（真实 API 调用会产生费用）`);
    if (info.provider === 'openrouter') {
      console.log(`可选模型（请求体 model 字段）：${info.models.join(' / ')}`);
    }
  }
});
