/**
 * 批量对比多个 OpenRouter 模型的識別效果。
 *
 *   node --env-file=.env server/test-recognize.mjs [--models a,b,c] [--dir testdata] [--out testdata/results] [--pipeline vlm|hybrid|both]
 *
 * 行为：
 * - 遍历 `--dir` 下的 jpg / jpeg / png / webp（**不压缩**，直接 base64；>3MB 警告跳过）；
 * - 逐图 × 逐管线 × 逐模型**串行**调用 `recognizeDetailed()`（直接 import handler，不走 HTTP），
 *   失败不中断整批；`--pipeline both` 会同一张图跑纯 VLM 与 hybrid 各一遍，便于横向对比；
 * - 每个组合写一个 `<out>/<run-id>/<图名>__<模型名>__<管线>.json`：
 *   识别原始结果 + solver/融合摘要 + CV 统计 + usage + 耗时（失败时写 error）；
 * - 最后生成 `<out>/<run-id>/summary.md`：一张「行=图 / 列=模型」的对比表 + warnings 汇总。
 *
 * ⚠ 真实 API 调用会产生费用；跑之前先确认 `--models` 只包含你打算花钱的模型。
 * ⚠ 输出里不会包含 API key。
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { DEFAULT_RECOGNIZE_MODELS, recognizeDetailed } from './recognize.mjs';
// solve.ts 里用的是省略扩展名的相对 import（vite 风格），需要先装 resolve hook；
// 又因为静态 import 在链接阶段就解析，所以只能 `await import()`。
import './tsHooks.mjs';

/** @type {typeof import('../src/ai/solve.ts').solveRecognizeResult} */
const solveRecognizeResult = (await import('../src/ai/solve.ts')).solveRecognizeResult;
/** @type {(polygon: Array<{x:number,y:number}>) => number} */
const polygonAreaMm2 = (await import('../src/utils/geometry.ts')).polygonAreaMm2;

const IMAGE_EXTS = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);
/** 超过这个大小的图直接跳过（不做压缩，避免 base64 撑爆 token） */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

/**
 * `--pipeline both` 时同一张图跑两条管线，方便直接对比。
 * M5 起默认是 `cv`（几何全靠轮廓提取，AI 只标注）；`vlm` / `hybrid` 留着做回归对比。
 */
const PIPELINE_CHOICES = ['cv', 'vlm', 'hybrid', 'both', 'all'];

function parseArgs(argv) {
  const out = {
    models: null,
    dir: 'testdata',
    out: 'testdata/results',
    only: null,
    refine: false,
    pipelines: ['cv'],
    // M4.2：默认忽略挂不上的小隔间（洗面所 / トイレ / 玄関 …），`--keep-small-rooms` 恢复旧行为
    ignoreSmallRooms: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const [key, inline] = eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, null];
    const value = () => inline ?? argv[++i];
    if (key === '--models') out.models = value().split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === '--dir') out.dir = value();
    else if (key === '--out') out.out = value();
    // 只跑指定的图（文件名逗号分隔），用于「先小样验证再全量」控制成本
    else if (key === '--only') out.only = value().split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === '--refine') out.refine = inline === null ? true : inline !== 'false';
    else if (key === '--keep-small-rooms') out.ignoreSmallRooms = inline === null ? false : inline === 'false';
    else if (key === '--pipeline') {
      const v = value();
      if (!PIPELINE_CHOICES.includes(v)) throw new Error(`--pipeline 只能是 ${PIPELINE_CHOICES.join(' / ')}`);
      out.pipelines = v === 'both' ? ['vlm', 'hybrid'] : v === 'all' ? ['cv', 'hybrid', 'vlm'] : [v];
    } else if (key === '--help' || key === '-h') out.help = true;
    else console.warn(`忽略未知参数：${arg}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 图片尺寸（不引依赖，手动读文件头）
// ---------------------------------------------------------------------------

/**
 * 读 PNG / JPEG / WebP 的像素尺寸。
 * @param {Buffer} buf
 * @returns {{ width: number, height: number } | null}
 */
export function imageSize(buf) {
  // PNG: 8 字节签名 + IHDR(len,type) 之后是 width/height（big endian）
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: 扫描到 SOFn（C0..CF，排除 C4/C8/CC）
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
      const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
      return { width: w + 1, height: h + 1 };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

/** 文件名安全化：`google/gemini-3.6-flash:batch` → `google__gemini-3.6-flash_batch` */
export function safeModelName(model) {
  return model.replace(/[\\/]/g, '__').replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** 一段墙相对水平轴的角度（0~180，取整到 1°） */
function wallAngle(w) {
  const deg = Math.round((Math.atan2(w.end.y - w.start.y, w.end.x - w.start.x) * 180) / Math.PI);
  return ((deg % 180) + 180) % 180;
}

/**
 * solver 结果 → 写进 JSON 的摘要。
 * `fused` 非空时直接用服务端融合好的几何（cv / hybrid 管线），否则本地跑一遍纯 VLM solver。
 * `label` 非空时（cv 管线）帖数标注从它那里取——那条路径下 `result.rooms` 是空的。
 */
function solverSummary(result, size, fused = null, label = null) {
  try {
    const solved =
      fused ??
      solveRecognizeResult(result, {
        imageWidthPx: size.width,
        imageHeightPx: size.height,
      });
    const areaMm2 = solved.rooms.reduce((sum, room) => sum + polygonAreaMm2(room.polygon), 0);
    const diagonals = solved.walls
      .filter((w) => w.start.x !== w.end.x && w.start.y !== w.end.y)
      .map((w) => ({ angle: wallAngle(w), lenMm: Math.round(Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y)) }));
    // 每个标了帖数的房间：实际面积（帖） vs 标注（帖）。
    // 融合路径的房间顺序跟 VLM 的不一样，所以按房间名回查标注。
    const labelled = new Map(
      label
        ? label.rooms.map((r) => [r.name ?? '房间', r.tatamiCount ?? null])
        : result.rooms.map((r) => [r.name, r.tatamiCount ?? null]),
    );
    const rooms = solved.rooms.map((room, i) => ({
      name: room.name,
      points: room.polygon.length,
      tatamiActual: round(polygonAreaMm2(room.polygon) / 1_656_200, 1),
      tatamiLabelled: fused ? (labelled.get(room.name) ?? null) : (result.rooms[i]?.tatamiCount ?? null),
    }));
    return {
      rooms: solved.rooms.length,
      walls: solved.walls.length,
      diagonalWalls: diagonals.length,
      diagonalDetail: diagonals,
      openings: solved.openings.length,
      columns: solved.structures.length,
      scaleMethod: result.scale?.method ?? null,
      mmPerUnit: round(solved.mmPerUnit, 3),
      totalAreaM2: round(areaMm2 / 1_000_000, 2),
      totalTatami: round(areaMm2 / 1_656_200, 1),
      areaMismatchRooms: solved.areaMismatchRoomIds.length,
      roomAreas: rooms,
      warnings: solved.warnings,
    };
  } catch (err) {
    return { error: `solver 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

function round(v, digits) {
  const f = 10 ** digits;
  return Number.isFinite(v) ? Math.round(v * f) / f : null;
}

function costText(usage) {
  if (!usage) return '—';
  const tokens = `${usage.prompt_tokens ?? 0}+${usage.completion_tokens ?? 0}`;
  const cost = usage.total_cost ? ` / $${usage.total_cost.toFixed(6)}` : '';
  return `${tokens} tok${cost}`;
}

/** 一格的内容 */
function cellText(entry) {
  if (entry.error) return `❌ ${entry.error.replace(/\|/g, '\\|').slice(0, 120)}`;
  const s = entry.solver ?? {};
  if (s.error) return `⚠ ${s.error.replace(/\|/g, '\\|').slice(0, 120)}`;
  const flags = [];
  if (entry.structuredOutput === false) flags.push('降级');
  if (entry.retried) flags.push('重试');
  if (entry.refined) flags.push('校对');
  if (entry.pipelineRequested === 'hybrid' && entry.pipeline !== 'hybrid') flags.push('回退纯AI');
  const angles = (s.diagonalDetail ?? []).map((d) => `${d.angle}°`).join('/');
  const cv = entry.cv
    ? `CV ${entry.cv.walls} 段 / ${entry.cv.rooms} 区${
        entry.cv.matchedRooms !== undefined ? ` · 语义命中 ${entry.cv.matchedRooms}` : ''
      }${entry.cv.iouMountedRooms ? `（IoU ${entry.cv.iouMountedRooms}）` : ''}${
        entry.cv.thinBlobsRemoved || entry.cv.dashChainsRemoved || entry.cv.islandWallsRemoved
          ? ` · 虚线 ${entry.cv.dashChainsRemoved ?? 0}/细框 ${entry.cv.thinBlobsRemoved ?? 0}/孤岛 ${entry.cv.islandWallsRemoved ?? 0}`
          : ''
      }${entry.cv.unnamedMerged ? ` · 并块 ${entry.cv.unnamedMerged}` : ''}${
        entry.cv.ignoredSmallRooms ? ` · 忽略小隔间 ${entry.cv.ignoredSmallRooms}` : ''
      }${
        // M5：标注命中率 + 洞口/柱候选
        entry.cv.namedRooms !== undefined
          ? `<br>标注 ${entry.cv.namedRooms}/${entry.cv.rooms} 名 · ${entry.cv.tatamiRooms ?? 0} 帖数 · ` +
            `洞口 ${entry.cv.openingsPlaced ?? 0}/${entry.cv.openingCandidates ?? 0} · 柱 ${entry.cv.columnCandidates ?? 0} · ` +
            `${entry.cv.markerMode === 'text_list' ? '文字清单' : '标记图'}` +
            (entry.cv.mergedPieces
              ? `<br>M5.2 拼合 ${entry.cv.mergedPieces} 块 · 摘隔断 ${entry.cv.fakePartitionsRemoved ?? 0} 段 · 悬空 ${entry.cv.danglingEndsAfterMerge ?? '—'}`
              : '')
          : ''
      }`
    : 'CV —';
  return [
    `${s.rooms ?? 0} 房 / ${s.walls ?? 0} 墙 / ${s.columns ?? 0} 柱 / ${s.openings ?? 0} 洞`,
    `${(entry.ms / 1000).toFixed(1)}s · ${costText(entry.usage)}`,
    `${s.totalTatami ?? '?'} 帖 · scale=${s.scaleMethod ?? '?'}${flags.length ? ` · ${flags.join('+')}` : ''}`,
    `斜墙 ${s.diagonalWalls ?? 0}${angles ? `（${angles}）` : ''} · 面积存疑 ${s.areaMismatchRooms ?? 0} 房`,
    cv,
  ].join('<br>');
}

/** 列标签：只有一条管线时就用模型名，多条时带上管线 */
function columnLabel(model, pipeline, multiPipeline) {
  return multiPipeline ? `${model} · ${pipeline}` : model;
}

function buildSummary({ runId, models, pipelines, entries, skipped, refine, ignoreSmallRooms }) {
  const images = [...new Set(entries.map((e) => e.image))];
  const multi = pipelines.length > 1;
  const columns = pipelines.flatMap((pipeline) =>
    models.map((model) => ({ model, pipeline, label: columnLabel(model, pipeline, multi) })),
  );
  const lines = [
    `# 識別对比 · ${runId}`,
    '',
    `- 图片：${images.length} 张${skipped.length ? `（跳过 ${skipped.length} 张）` : ''}`,
    `- 模型：${models.map((m) => `\`${m}\``).join('、')}`,
    `- 管线：${pipelines.join('、')}`,
    `- 二次校对（refine）：${refine ? '开' : '关'}`,
    `- 小隔间（洗面所/トイレ/玄関…）：${ignoreSmallRooms ? '忽略' : '保留（--keep-small-rooms）'}`,
    `- 组合：${entries.length}（失败 ${entries.filter((e) => e.error).length}）`,
    '',
    '## 对比表',
    '',
    `| 图 | ${columns.map((c) => c.label).join(' | ')} |`,
    `| --- | ${columns.map(() => '---').join(' | ')} |`,
  ];

  for (const image of images) {
    const cells = columns.map((c) => {
      const entry = entries.find(
        (e) => e.image === image && e.model === c.model && e.pipelineRequested === c.pipeline,
      );
      return entry ? cellText(entry) : '—';
    });
    lines.push(`| ${image} | ${cells.join(' | ')} |`);
  }

  // 费用 / 耗时小计
  lines.push('', '## 小计', '', '| 组合 | 成功 | 总耗时 | 总 token | 总费用 |', '| --- | --- | --- | --- | --- |');
  for (const column of columns) {
    const model = column.label;
    const mine = entries.filter(
      (e) => e.model === column.model && e.pipelineRequested === column.pipeline,
    );
    const ok = mine.filter((e) => !e.error).length;
    const ms = mine.reduce((s, e) => s + (e.ms || 0), 0);
    const tok = mine.reduce((s, e) => s + (e.usage?.total_tokens || 0), 0);
    const cost = mine.reduce((s, e) => s + (e.usage?.total_cost || 0), 0);
    lines.push(`| ${model} | ${ok}/${mine.length} | ${(ms / 1000).toFixed(1)}s | ${tok} | $${cost.toFixed(6)} |`);
  }

  // warnings 汇总
  const warnCounts = new Map();
  for (const entry of entries) {
    for (const w of entry.solver?.warnings ?? []) {
      const key = w.replace(/「[^」]*」/g, '「…」').replace(/-?\d+(\.\d+)?/g, 'N');
      warnCounts.set(key, (warnCounts.get(key) ?? 0) + 1);
    }
  }
  lines.push('', '## solver warnings 汇总', '');
  if (warnCounts.size === 0) lines.push('（无）');
  else {
    for (const [w, n] of [...warnCounts.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- ×${n} ${w}`);
    }
  }

  if (skipped.length > 0) {
    lines.push('', '## 跳过的文件', '');
    for (const s of skipped) lines.push(`- ${s}`);
  }

  lines.push(
    '',
    '> 每格：房间/墙/柱/洞口数 · 耗时·token/费用 · 面积(帖)·比例来源 · 斜墙数(角度)·面积存疑房间数 · CV 提取的墙段/区域数。详细结果见同目录的 JSON。',
  );
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node --env-file=.env server/test-recognize.mjs [--models a,b,c] [--dir testdata] [--out testdata/results] [--only test2.jpg] [--refine] [--pipeline vlm|hybrid|both] [--keep-small-rooms]');
    console.log(`默认模型：${DEFAULT_RECOGNIZE_MODELS.join(', ')}`);
    console.log('--refine：识别后追加一轮「对照图片校对」，更准但耗时与费用翻倍');
    console.log('--only：只跑指定图片（逗号分隔文件名），用于小样验证控制成本');
    console.log('--pipeline：cv=轮廓提几何+AI 只标注（默认，M5），hybrid=CV 几何+VLM 语义融合（M4），vlm=纯 AI（M3），both=vlm+hybrid，all=三条都跑（费用翻三倍）');
    console.log('--keep-small-rooms：保留挂不上的小隔间（洗面所/トイレ/玄関…）的丢弃警告；默认安静忽略');
    return;
  }

  const models = args.models ?? [...DEFAULT_RECOGNIZE_MODELS];
  // 测试脚本可以指定 allowlist 之外的模型：把 allowlist 换成本次要跑的清单
  process.env.RECOGNIZE_MODELS = models.join(',');
  if (!process.env.RECOGNIZE_PROVIDER) process.env.RECOGNIZE_PROVIDER = 'openrouter';
  if (!process.env.OPENROUTER_APIKEY && process.env.RECOGNIZE_PROVIDER === 'openrouter') {
    console.error('缺少 OPENROUTER_APIKEY：请用 `node --env-file=.env server/test-recognize.mjs` 运行');
    process.exitCode = 1;
    return;
  }

  const dir = path.resolve(args.dir);
  let files;
  try {
    files = (await readdir(dir))
      .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
      .filter((f) => !args.only || args.only.includes(f))
      .sort();
  } catch {
    console.error(`读不到目录 ${dir}——请先把测试图放进去（见 testdata/README.md）`);
    process.exitCode = 1;
    return;
  }
  if (files.length === 0) {
    console.error(`${dir} 里没有 jpg / png / webp 图片`);
    process.exitCode = 1;
    return;
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.resolve(args.out, runId);
  await mkdir(outDir, { recursive: true });

  console.log(`run ${runId}`);
  console.log(`  图片 ${files.length} 张 ← ${dir}`);
  console.log(`  模型 ${models.length} 个：${models.join(', ')}`);
  console.log(`  管线：${args.pipelines.join(' + ')}`);
  console.log(`  二次校对 refine：${args.refine ? '开（费用与耗时翻倍）' : '关'}`);
  console.log(`  小隔间：${args.ignoreSmallRooms ? '忽略（默认）' : '保留（--keep-small-rooms）'}`);
  console.log(`  输出 → ${outDir}\n`);

  const entries = [];
  const skipped = [];

  for (const file of files) {
    const full = path.join(dir, file);
    const buf = await readFile(full);
    if (buf.length > MAX_IMAGE_BYTES) {
      const msg = `${file}（${(buf.length / 1024 / 1024).toFixed(1)}MB > 3MB，未压缩不发送）`;
      console.warn(`⚠ 跳过 ${msg}`);
      skipped.push(msg);
      continue;
    }
    const size = imageSize(buf);
    if (!size) {
      const msg = `${file}（读不出像素尺寸，文件可能损坏）`;
      console.warn(`⚠ 跳过 ${msg}`);
      skipped.push(msg);
      continue;
    }

    const mediaType = IMAGE_EXTS.get(path.extname(file).toLowerCase());
    const body = {
      imageDataUrl: `data:${mediaType};base64,${buf.toString('base64')}`,
      imageWidthPx: size.width,
      imageHeightPx: size.height,
      refine: args.refine,
      ignoreSmallRooms: args.ignoreSmallRooms,
    };

    for (const pipeline of args.pipelines) {
      for (const model of models) {
        const label = `${file} × ${model} × ${pipeline}`;
        process.stdout.write(`→ ${label} … `);
        /** @type {any} */
        const entry = { image: file, model, pipelineRequested: pipeline, pipeline, ms: 0 };
        let payload;
        try {
          const call = await recognizeDetailed({ ...body, model, pipeline });
          entry.ms = call.ms;
          entry.usage = call.usage;
          entry.structuredOutput = call.structuredOutput;
          entry.retried = call.retried;
          entry.refined = call.refined === true;
          entry.serverWarnings = call.warnings ?? [];
          entry.pipeline = call.pipeline ?? 'vlm';
          entry.cv = call.cv ?? null;
          entry.label = call.label ?? null;
          entry.solver = solverSummary(call.result, size, call.solved ?? null, call.label ?? null);
          payload = {
            image: file,
            imageWidthPx: size.width,
            imageHeightPx: size.height,
            model,
            provider: call.provider,
            upstream: call.upstream,
            ms: call.ms,
            usage: call.usage,
            structuredOutput: call.structuredOutput,
            retried: call.retried,
            refineRequested: args.refine,
            refined: entry.refined,
            pipelineRequested: pipeline,
            pipeline: entry.pipeline,
            ignoreSmallRooms: args.ignoreSmallRooms,
            cv: entry.cv,
            label: entry.label,
            serverWarnings: entry.serverWarnings,
            solver: entry.solver,
            recognize: call.result,
            solved: call.solved ?? null,
          };
          const s = entry.solver;
          const fellBack = pipeline === 'hybrid' && entry.pipeline !== 'hybrid';
          console.log(
            s.error
              ? `solver 失败（${(call.ms / 1000).toFixed(1)}s）`
              : `${s.rooms} 房 / ${s.walls} 墙 / ${s.columns} 柱${fellBack ? '（已回退纯 AI）' : ''}` +
                  `（${(call.ms / 1000).toFixed(1)}s, ${costText(call.usage)}）`,
          );
        } catch (err) {
          entry.error = err instanceof Error ? err.message : String(err);
          entry.code = err?.code ?? null;
          payload = { image: file, model, pipelineRequested: pipeline, error: entry.error, code: entry.code };
          console.log(`❌ ${entry.error}`);
        }
        entries.push(entry);
        await writeFile(
          path.join(outDir, `${path.parse(file).name}__${safeModelName(model)}__${pipeline}.json`),
          `${JSON.stringify(payload, null, 2)}\n`,
          'utf8',
        );
      }
    }
  }

  const summaryPath = path.join(outDir, 'summary.md');
  await writeFile(
    summaryPath,
    buildSummary({
      runId,
      models,
      pipelines: args.pipelines,
      entries,
      skipped,
      refine: args.refine,
      ignoreSmallRooms: args.ignoreSmallRooms,
    }),
    'utf8',
  );
  const totalCost = entries.reduce((s, e) => s + (e.usage?.total_cost || 0), 0);
  console.log(`\n完成：${entries.length} 个组合，失败 ${entries.filter((e) => e.error).length} 个，合计 $${totalCost.toFixed(6)}`);
  console.log(`汇总 → ${summaryPath}`);
}

// 直接运行时才 main（被 import 时只暴露工具函数）
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('test-recognize.mjs')) {
  await main();
}
