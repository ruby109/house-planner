/**
 * 门 / 引き戸 / 窗 / 无门开口的放置工具 —— M1b。
 * 工厂按类型产出 handler（registry.ts 中按 activeTool 分别注册）。
 *
 * 交互：
 * - 指针移动时找 500mm 内最近的墙（pointSegProjection），在墙上的投影处显示预览；
 * - offset 是洞口中心沿墙的距离，clamp 到洞口完全落在墙段内；
 * - 墙太短或与同一面墙上已有开口重叠 → 预览置灰、点击不提交；
 * - 找不到墙 → 预览跟随指针置灰。
 */
import type { Opening, Pt } from '../model/types';
import { usePlanStore } from '../store/planStore';
import { createOpeningDraftStore } from './openingDraft';
import { makeOpeningPreview } from './openingPreview';
import {
  computeOpeningCandidate,
  OPENING_DEFAULT_SWING,
  OPENING_DEFAULT_WIDTH,
  type OpeningCandidate,
} from './wallGeometry';
import type { ToolContext, ToolHandler } from './types';

function candidateFor(type: Opening['type'], p: Pt): OpeningCandidate | null {
  const { doc } = usePlanStore.getState();
  return computeOpeningCandidate(doc.walls, doc.openings, p, OPENING_DEFAULT_WIDTH[type]);
}

export function makeOpeningTool(type: Opening['type']): ToolHandler {
  const useDraft = createOpeningDraftStore();

  const refresh = (ctx: ToolContext): OpeningCandidate | null => {
    const candidate = candidateFor(type, ctx.snapped);
    useDraft.getState().set(candidate, candidate ? null : ctx.pt);
    return candidate;
  };

  return {
    onPointerMove(ctx) {
      refresh(ctx);
    },

    onPointerDown(ctx) {
      // 重新算一次，保证没有 move 事件（触摸板点按）时也能落位
      const candidate = refresh(ctx);
      if (!candidate || !candidate.valid) return;
      usePlanStore.getState().addOpening({
        wallId: candidate.wallId,
        type,
        offset: candidate.offset,
        width: candidate.width,
        ...(type === 'door' ? { swing: OPENING_DEFAULT_SWING } : null),
      });
    },

    onCancel() {
      useDraft.getState().reset();
    },

    Preview: makeOpeningPreview(useDraft, type),
  };
}

export default makeOpeningTool;
