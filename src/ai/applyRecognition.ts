/**
 * M3：把 solver 的结果写进文档（见 docs/AI-RECOGNITION.md 第 5 节第 4~5 步）。
 *
 * 与 `solve.ts` 的分工：那边是纯几何，这里负责串 store / 历史 / 视图 / 提示。
 * 语义是**整篇替换**（不做合并模式）：清空文档 → 写入识别结果 + 对齐好的底图 →
 * clearHistory（undo 不能退回空文档）→ requestFit → 柱全部选中，提示用户逐个确认。
 */
import { createEmptyDoc } from '../model/defaults';
import type { PlanDoc, Underlay } from '../model/types';
import { clearHistory, usePlanStore } from '../store/planStore';
import { useUiStore } from '../store/uiStore';
import { strings } from '../ui/strings';
import { notify } from '../ui/toast';
import { loadImageElement } from '../utils/underlayImage';
import type { SolveResult } from './solve';

/** 识别出的底图默认透明度：比手动上传（0.5）再淡一点，让生成的墙线更清楚 */
export const RECOGNIZED_UNDERLAY_OPACITY = 0.4;

export interface RecognizedImage {
  dataUrl: string;
  width: number;
  height: number;
}

/** 文档是不是「什么都没有」——用来决定要不要弹替换确认 */
export function isDocEmpty(doc: PlanDoc): boolean {
  return (
    doc.underlay === null &&
    doc.walls.length === 0 &&
    doc.openings.length === 0 &&
    doc.structures.length === 0 &&
    doc.rooms.length === 0 &&
    doc.furniture.length === 0 &&
    doc.annotations.length === 0
  );
}

/** 由识别结果拼出完整的 PlanDoc（纯函数，便于单测） */
export function buildRecognizedDoc(
  solved: SolveResult,
  image: RecognizedImage,
  baseName: string,
): PlanDoc {
  const underlay: Underlay = {
    imageDataUrl: image.dataUrl,
    opacity: RECOGNIZED_UNDERLAY_OPACITY,
    mmPerPixel: solved.underlay.mmPerPixel,
    offset: solved.underlay.offset,
    // M4-CV：融合路径会把 CV 的 deskew 校正角写进来，底图得跟着转才对得上
    rotation: solved.underlay.rotation ?? 0,
    locked: true,
  };
  return {
    ...createEmptyDoc(baseName),
    underlay,
    walls: solved.walls,
    openings: solved.openings,
    structures: solved.structures,
    rooms: solved.rooms,
  };
}

/** 「识别完成：N 房间 / N 墙 / N 柱」＋ 梁的手动补充提示 */
export function recognitionSummary(solved: SolveResult): string {
  const columns = solved.structures.filter((s) => s.kind === 'column').length;
  return strings.m3.applyDone(solved.rooms.length, solved.walls.length, columns);
}

/**
 * 应用识别结果。图片会先预热到缓存里，保证 fit / 渲染能同步拿到像素尺寸。
 */
export async function applyRecognition(
  solved: SolveResult,
  image: RecognizedImage,
): Promise<void> {
  try {
    await loadImageElement(image.dataUrl);
  } catch {
    // 图片加载失败不影响几何结果，底图只是会渲染不出来
  }

  const plan = usePlanStore.getState();
  const doc = buildRecognizedDoc(solved, image, plan.doc.meta.name);
  plan.replaceDoc(doc);
  // 识别不是一次「编辑」：撤销不能把用户退回空文档
  clearHistory();

  const ui = useUiStore.getState();
  ui.setActiveTool('select');
  // 柱 + 面积与帖数标注对不上的房间，以选中态高亮，提示用户逐个确认
  const roomIds = new Set(doc.rooms.map((r) => r.id));
  ui.setSelection([
    ...doc.structures.filter((s) => s.kind === 'column').map((s) => s.id),
    ...solved.areaMismatchRoomIds.filter((id) => roomIds.has(id)),
  ]);
  ui.requestFit();

  notify(recognitionSummary(solved));
}
