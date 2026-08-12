/**
 * 柱/梁放置工具 —— M1c 实现。工厂函数按 kind 产出 handler。
 * 需求：
 * - 指针处显示默认尺寸预览（柱 105×105，梁 910×300，常量在 model/defaults），
 *   点击提交 structuresActions.addStructure；
 * - 吸附用 ctx.snapped；旋转在放置后通过属性面板/Transformer 调整。
 *
 * 说明：预览中间态放在本工具自己的 store 里（见 structurePreview.tsx），不进历史。
 * 点击后不清空预览，从而支持连续放置。
 */
import type { StructureKind } from '../model/types';
import { usePlanStore } from '../store/planStore';
import { STRUCTURE_DEFAULT_SIZE } from '../ui/canvasStyle';
import { createStructurePreview } from './structurePreview';
import type { ToolHandler } from './types';

export function makeStructureTool(kind: StructureKind): ToolHandler {
  const { useStore, Preview } = createStructurePreview(kind);
  const size = STRUCTURE_DEFAULT_SIZE[kind];

  return {
    onPointerMove(ctx) {
      useStore.getState().setCenter(ctx.snapped);
    },

    onPointerDown(ctx) {
      // 预览跟随到落点，保证「点击即所见」，随后可继续放置
      useStore.getState().setCenter(ctx.snapped);
      usePlanStore.getState().addStructure({
        kind,
        position: ctx.snapped,
        width: size.width,
        depth: size.depth,
        rotation: 0,
      });
    },

    onCancel() {
      useStore.getState().clear();
    },

    Preview,
  };
}
