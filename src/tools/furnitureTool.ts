/**
 * 家具放置工具 —— M1c 实现。
 * 需求：
 * - 待放对象来自 uiStore.pendingFurniture（Sidebar 点击家具进入本模式）；
 * - 指针处显示尺寸预览 + 与已有家具/墙的 SAT 碰撞红色高亮（仅提示不阻止）；
 * - 点击提交 furnitureActions.addFurniture；连续放置，Esc 退出；
 * - pendingFurniture 为 null 时本工具不做任何事。
 *
 * 说明：预览中间态在 furniturePreview.tsx 的小 store 里，不进 planStore 历史。
 */
import { usePlanStore } from '../store/planStore';
import { useUiStore } from '../store/uiStore';
import { FurniturePreview, useFurniturePreviewStore } from './furniturePreview';
import type { ToolHandler } from './types';

export const furnitureTool: ToolHandler = {
  onPointerMove(ctx) {
    const preview = useFurniturePreviewStore.getState();
    if (!useUiStore.getState().pendingFurniture) {
      if (preview.center) preview.clear();
      return;
    }
    preview.setCenter(ctx.snapped);
  },

  onPointerDown(ctx) {
    const pending = useUiStore.getState().pendingFurniture;
    if (!pending) return;
    useFurniturePreviewStore.getState().setCenter(ctx.snapped);
    usePlanStore.getState().addFurniture({
      catalogId: pending.catalogId,
      name: pending.name,
      size: { w: pending.w, d: pending.d },
      position: ctx.snapped,
      rotation: 0,
      color: pending.color,
    });
    // pendingFurniture 保持不变 → 连续放置
  },

  onCancel() {
    useFurniturePreviewStore.getState().clear();
    // 切换工具时 uiStore.setActiveTool 已经清掉了 pendingFurniture，
    // 此时 activeTool 已不是 furniture_place；只有 Esc / 右键取消才会走到下面这句，
    // 于是「Esc = 退出放置模式并回到选择工具」。
    const ui = useUiStore.getState();
    if (ui.activeTool === 'furniture_place' && ui.pendingFurniture) ui.setPendingFurniture(null);
  },

  Preview: FurniturePreview,
};
