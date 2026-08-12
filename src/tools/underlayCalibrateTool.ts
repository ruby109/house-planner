/**
 * 底图两点比例标定工具（M2）。
 *
 * 交互：
 * - 激活后画布提示「在底图上点击一段已知长度的两端」；
 * - 第一次点击落下端点 A（显示标记），移动出橡皮筋，第二次点击落下端点 B（显示连线）；
 * - 随后弹出小面板（UnderlayCalibrateDialog）输入实际长度 mm（默认 1820）；
 * - 确认后重算 mmPerPixel，并**围绕两点中点保持位置**（标定后图不跳走），
 *   然后自动回到 select 工具；
 * - Esc / 右键 / 切换工具随时取消。
 *
 * 关键约定：两点取 `ctx.pt` 而**不是** `ctx.snapped`——标定精度直接决定描图质量，
 * 吸附到 455 网格会引入几十 mm 的系统误差。
 */
import { usePlanStore } from '../store/planStore';
import { useUiStore } from '../store/uiStore';
import { strings } from '../ui/strings';
import { notify } from '../ui/toast';
import { calibrateUnderlay } from '../utils/underlayImage';
import { useUnderlayCalibrateDraft } from './underlayCalibrateDraft';
import { UnderlayCalibratePreview } from './underlayCalibratePreview';
import type { ToolHandler } from './types';

export const underlayCalibrateTool: ToolHandler = {
  onPointerDown(ctx) {
    const draft = useUnderlayCalibrateDraft.getState();
    if (draft.awaitingInput) return; // 面板开着时不再取点
    if (!draft.a) {
      draft.begin(ctx.pt);
      return;
    }
    draft.finish(ctx.pt);
  },

  onPointerMove(ctx) {
    const draft = useUnderlayCalibrateDraft.getState();
    if (!draft.a || draft.awaitingInput) return;
    draft.move(ctx.pt);
  },

  onCancel() {
    useUnderlayCalibrateDraft.getState().reset();
  },

  Preview: UnderlayCalibratePreview,
};

/** 进入标定工具（没有底图时只提示） */
export function startUnderlayCalibration(): void {
  if (!usePlanStore.getState().doc.underlay) {
    notify(strings.m2.calibrateNeedUnderlay, 'error');
    return;
  }
  useUnderlayCalibrateDraft.getState().reset();
  useUiStore.getState().setActiveTool('underlay_calibrate');
}

/** 放弃本次标定并回到选择工具 */
export function cancelUnderlayCalibration(): void {
  useUnderlayCalibrateDraft.getState().reset();
  if (useUiStore.getState().activeTool === 'underlay_calibrate') {
    useUiStore.getState().setActiveTool('select');
  }
}

/**
 * 确认标定：把「两点之间实际有多长」换算成新的 mmPerPixel，并保持中点不动。
 * 成功返回 true，随后自动回到 select 工具。
 */
export function commitUnderlayCalibration(realLengthMm: number): boolean {
  const draft = useUnderlayCalibrateDraft.getState();
  const plan = usePlanStore.getState();
  const underlay = plan.doc.underlay;
  if (!underlay || !draft.a || !draft.b) return false;

  const result = calibrateUnderlay(underlay, draft.a, draft.b, realLengthMm);
  if (!result) {
    notify(strings.m2.calibrateInvalid, 'error');
    return false;
  }

  plan.updateUnderlay(result);
  notify(strings.m2.calibrateDone(result.mmPerPixel));
  cancelUnderlayCalibration();
  return true;
}

export default underlayCalibrateTool;
