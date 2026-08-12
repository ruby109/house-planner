/**
 * 选择工具：点击命中元素选中（Shift 加选/减选），点击空白清空。
 * 元素的拖拽移动由各 Layer 的图形自身（draggable + onDragEnd）实现，
 * 不经过本工具——见 ARCHITECTURE.md「拖拽中间态不进历史」约定。
 *
 * M1d 追加：**双击墙体围合的封闭区域 → 生成房间**。
 * 环检测是 utils/roomDetect 里的纯函数（墙段图求平面图的面），本文件只做串联。
 */
import { usePlanStore } from '../store/planStore';
import { useUiStore } from '../store/uiStore';
import { strings } from '../ui/strings';
import { notify } from '../ui/toast';
import { findLoopAt, pointInPolygon } from '../utils/roomDetect';
import type { ToolHandler } from './types';

export const selectTool: ToolHandler = {
  onPointerDown(ctx) {
    const ui = useUiStore.getState();
    if (ctx.targetId) {
      if (ctx.shiftKey) ui.toggleSelection(ctx.targetId);
      else ui.setSelection([ctx.targetId]);
    } else if (!ctx.shiftKey) {
      ui.clearSelection();
    }
  },

  onDoubleClick(ctx) {
    const ui = useUiStore.getState();
    const plan = usePlanStore.getState();

    // 已经有房间覆盖这里 → 选中它，不重复生成
    const existing = plan.doc.rooms.find((r) => pointInPolygon(ctx.pt, r.polygon));
    if (existing) {
      ui.setSelection([existing.id]);
      return;
    }

    const loop = findLoopAt(plan.doc.walls, ctx.pt);
    if (!loop) {
      notify(strings.m1d.roomNotFound, 'error');
      return;
    }

    const id = plan.addRoom({
      name: strings.m1d.roomDefaultName,
      polygon: loop.polygon,
      floor: 'flooring',
    });
    ui.setSelection([id]);
  },
};
