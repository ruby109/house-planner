/**
 * M4-CV 阶段 A 的验收工具（见 docs/CV-PIPELINE.md 第 4 节）。
 *
 *   node server/cv-debug.mjs testdata/test2.jpg [--out 目录]
 *
 * 产出：
 *   <名>__overlay.png   原图 + 红色墙段（线宽 = 厚度）+ 房间半透明填色 + 蓝色文字块框
 *   <名>__steps.png     二值化 / wallMask / 骨架 / 封洞后 四张 mask 横向拼图
 *
 * 还会在 stdout 打印 {墙段数、房间数、被剔除文字块数、模式、耗时}。
 * 纯本地计算，不调任何 API，随便跑。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import './tsHooks.mjs';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg']);

function parseArgs(argv) {
  const opts = { inputs: [], out: 'testdata/cv-debug', deskew: true, mode: undefined, isolatePlan: undefined, json: false, full: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--no-deskew') opts.deskew = false;
    else if (a === '--mode') opts.mode = argv[++i];
    else if (a === '--no-isolate') opts.isolatePlan = false;
    else if (a === '--json') opts.json = true;
    // --full：JSON 里带上完整的 walls / rooms 几何（融合器单测的 fixture 就是这么生成的）
    else if (a === '--full') {
      opts.json = true;
      opts.full = true;
    }
    else if (a.startsWith('--')) throw new Error(`未知参数 ${a}`);
    else opts.inputs.push(a);
  }
  return opts;
}

function expandInputs(inputs) {
  const files = [];
  for (const input of inputs) {
    const p = resolve(input);
    if (!existsSync(p)) throw new Error(`找不到 ${input}`);
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) {
        if (IMAGE_EXT.has(extname(f).toLowerCase())) files.push(join(p, f));
      }
    } else {
      files.push(p);
    }
  }
  return files;
}

function fmt(n, digits = 1) {
  return Number.isFinite(n) ? n.toFixed(digits) : String(n);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.inputs.length === 0) {
    console.error('用法: node server/cv-debug.mjs <图片路径…> [--out 目录] [--no-deskew] [--mode clean|photo] [--no-isolate] [--json] [--full]');
    process.exit(1);
  }

  const { decodeImage, encodePng } = await import('../src/cv/decode.ts');
  const { extractGeometry } = await import('../src/cv/pipeline.ts');
  const { renderOverlay, renderSteps } = await import('../src/cv/debug.ts');
  const { ensureCv } = await import('../src/cv/cvRuntime.ts');
  const cv = await ensureCv();

  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });

  const files = expandInputs(opts.inputs);
  const summary = [];

  for (const file of files) {
    const name = basename(file, extname(file));
    const image = decodeImage(readFileSync(file));
    const extract = await extractGeometry(image, {
      debug: true,
      deskew: opts.deskew,
      mode: opts.mode,
      isolatePlan: opts.isolatePlan,
    });

    const overlay = renderOverlay(cv, image, extract);
    const overlayPath = join(outDir, `${name}__overlay.png`);
    writeFileSync(overlayPath, encodePng(overlay.data, overlay.width, overlay.height));

    let stepsPath = null;
    if (extract.debug) {
      const steps = renderSteps(extract.debug);
      stepsPath = join(outDir, `${name}__steps.png`);
      writeFileSync(stepsPath, encodePng(steps.data, steps.width, steps.height));
    }

    const row = {
      file: basename(file),
      size: `${extract.stats.imageWidthPx}×${extract.stats.imageHeightPx}`,
      walls: extract.walls.length,
      rooms: extract.rooms.length,
      openings: extract.openings.length,
      exteriorOpenings: extract.openings.filter((o) => o.exterior).length,
      columns: extract.columns.length,
      textBlocks: extract.stats.textBlocksRemoved,
      dashChains: extract.stats.dashChainsRemoved,
      thinBlobs: extract.stats.thinBlobsRemoved,
      islandWalls: extract.stats.islandWallsRemoved,
      // M5.1 墙网闭合
      outsideWalls: extract.stats.outsideWallsRemoved,
      gapMerged: extract.stats.gapMergedWalls,
      extended: extract.stats.danglingExtended,
      scrapWalls: extract.stats.scrapWallsRemoved,
      danglingBefore: extract.stats.danglingEndsBefore,
      dangling: extract.stats.danglingEnds,
      mode: extract.stats.mode,
      strokePx: +fmt(extract.stats.wallStrokePx, 2),
      deskewDeg: +fmt(extract.deskewDeg, 2),
      elapsedMs: extract.stats.elapsedMs,
      overlay: overlayPath,
      steps: stepsPath,
      warnings: extract.warnings,
    };
    if (opts.full) {
      const r3 = (v) => Math.round(v * 1000) / 1000;
      row.extract = {
        walls: extract.walls.map((w) => ({
          x1: r3(w.x1),
          y1: r3(w.y1),
          x2: r3(w.x2),
          y2: r3(w.y2),
          thicknessPx: r3(w.thicknessPx),
        })),
        rooms: extract.rooms.map((rm) => ({
          polygon: rm.polygon.map((p) => ({ x: r3(p.x), y: r3(p.y) })),
          areaPx: r3(rm.areaPx),
        })),
        openings: extract.openings.map((o) => ({
          x1: r3(o.x1),
          y1: r3(o.y1),
          x2: r3(o.x2),
          y2: r3(o.y2),
          exterior: o.exterior,
          ...(o.onWallIndex === undefined ? {} : { onWallIndex: o.onWallIndex }),
        })),
        columns: extract.columns.map((c) => ({
          x: r3(c.x),
          y: r3(c.y),
          wPx: r3(c.wPx),
          hPx: r3(c.hPx),
        })),
        deskewDeg: extract.deskewDeg,
        stats: extract.stats,
        warnings: extract.warnings,
        textBoxes: extract.textBoxes.map((b) => ({ x: r3(b.x), y: r3(b.y), w: r3(b.w), h: r3(b.h) })),
        dashBoxes: extract.dashBoxes.map((b) => ({ x: r3(b.x), y: r3(b.y), w: r3(b.w), h: r3(b.h) })),
        outsideBoxes: (extract.outsideBoxes ?? []).map((b) => ({ x: r3(b.x), y: r3(b.y), w: r3(b.w), h: r3(b.h) })),
      };
    }
    summary.push(row);

    if (!opts.json) {
      console.log(
        `${row.file.padEnd(14)} ${row.size.padStart(10)}  墙段 ${String(row.walls).padStart(3)}  房间 ${String(row.rooms).padStart(3)}  ` +
          `洞口 ${String(row.openings).padStart(3)}（外 ${String(row.exteriorOpenings).padStart(2)}）  柱 ${String(row.columns).padStart(2)}  ` +
          `文字块 ${String(row.textBlocks).padStart(4)}  虚线 ${String(row.dashChains).padStart(2)}/细框 ${String(row.thinBlobs).padStart(3)}/孤岛 ${String(row.islandWalls).padStart(3)}  ` +
          `模式 ${row.mode.padEnd(5)}  笔画 ${String(row.strokePx).padStart(5)}px  ` +
          `deskew ${String(row.deskewDeg).padStart(5)}°  ${String(row.elapsedMs).padStart(5)}ms`,
      );
      console.log(
        `   M5.1 轮廓外 ${String(row.outsideWalls).padStart(2)}  跨洞合墙 −${String(row.gapMerged).padStart(2)}  ` +
          `T接延伸 ${String(row.extended).padStart(2)}  碎屑 ${String(row.scrapWalls).padStart(2)}  ` +
          `悬空端点 ${String(row.danglingBefore).padStart(3)} → ${String(row.dangling).padStart(3)}`,
      );
      for (const w of row.warnings) console.log(`   ! ${w}`);
      console.log(`   → ${overlayPath}`);
      if (stepsPath) console.log(`   → ${stepsPath}`);
    }
  }

  if (opts.json) console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
