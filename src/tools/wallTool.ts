/**
 * 画墙工具 —— M1b。
 *
 * 交互：
 * - 第一次点击落起点；移动出橡皮筋预览（WallPreview，渲染在 OverlayLayer）；
 * - 再次点击提交一段墙，并**以终点为新起点连续画**；
 * - 默认正交锁 0/90°（取 dx/dy 较大者的方向），按住 Shift 自由角度；
 * - 坐标一律取 ctx.snapped；长度为 0 的段不提交；
 * - Esc / 右键 / 切换工具触发 onCancel，结束本次连画。
 *
 * 绘制中间态放在 wallDraft 这个工具自有的小 store 里，不进 planStore 历史。
 */
import type { Pt } from '../model/types';
import { usePlanStore } from '../store/planStore';
import { useWallDraft } from './wallDraft';
import { constrainWallEnd, isZeroLengthSegment } from './wallGeometry';
import { WallPreview } from './wallPreview';
import type { ToolContext, ToolHandler } from './types';

/** 由当前指针位置推出本段的终点（正交约束 + 取整） */
function resolveEnd(start: Pt, ctx: ToolContext): Pt {
  return constrainWallEnd(start, ctx.snapped, ctx.shiftKey);
}

export const wallTool: ToolHandler = {
  onPointerDown(ctx) {
    const draft = useWallDraft.getState();
    const start = draft.start;

    if (!start) {
      draft.begin(ctx.snapped);
      return;
    }

    const end = resolveEnd(start, ctx);
    // 零长度不产生墙体（原地重复点击时保持当前起点不变）
    if (isZeroLengthSegment(start, end)) return;

    usePlanStore.getState().addWall(start, end);
    // 连续画：终点变成下一段的起点
    draft.begin(end);
  },

  onPointerMove(ctx) {
    const draft = useWallDraft.getState();
    if (!draft.start) return;
    draft.move(resolveEnd(draft.start, ctx), ctx.shiftKey);
  },

  onCancel() {
    useWallDraft.getState().reset();
  },

  Preview: WallPreview,
};

export default wallTool;
