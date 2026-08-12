/**
 * 全局快捷键（M1d）—— 应用里唯一的键盘绑定入口，在 App 挂载一次。
 *
 * - V/W/D/S/N/C/B/F 切工具（与 Toolbar 按钮 title 的提示一致）；
 * - Esc：先取消当前工具的绘制中间态，再回到选择工具；
 * - Delete / Backspace：删除选中元素；
 * - Ctrl/Cmd+Z 撤销，Ctrl/Cmd+Shift+Z 与 Ctrl+Y 重做。
 *
 * 输入框（input/textarea/select/contenteditable）聚焦时**全部忽略**，
 * 否则在属性面板里打字会误触发工具切换。
 * 空格平移由 PlanCanvas 自己处理，不在这里。
 */
import { useEffect } from 'react';
import { redo, undo, usePlanStore } from '../store/planStore';
import { useUiStore, type Tool } from '../store/uiStore';
import { cancelTool } from '../tools/registry';

/** 字母 → 工具（大写；与 ui/strings.ts 的 toolShortcuts 一一对应） */
export const TOOL_KEYS: Record<string, Tool> = {
  V: 'select',
  W: 'wall',
  D: 'door',
  S: 'sliding_door',
  N: 'window',
  C: 'column',
  B: 'beam',
  F: 'furniture_place',
};

/** 事件目标是否是可输入控件 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return el.isContentEditable === true;
}

export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;

      const mod = e.ctrlKey || e.metaKey;

      // ---------------------------------------------------------- undo / redo
      if (mod && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === 'z') {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
          return;
        }
        if (key === 'y') {
          e.preventDefault();
          redo();
          return;
        }
      }

      if (mod || e.altKey) return;

      // ---------------------------------------------------------------- Esc
      if (e.key === 'Escape') {
        const ui = useUiStore.getState();
        // 先丢弃绘制中间态，再回到选择工具
        cancelTool(ui.activeTool);
        if (useUiStore.getState().activeTool !== 'select') {
          useUiStore.getState().setActiveTool('select');
        }
        return;
      }

      // ------------------------------------------------------------- 删除选中
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const ui = useUiStore.getState();
        if (ui.selection.length === 0) return;
        e.preventDefault();
        usePlanStore.getState().removeByIds(ui.selection);
        ui.clearSelection();
        return;
      }

      // ------------------------------------------------------------- 工具切换
      const tool = TOOL_KEYS[e.key.toUpperCase()];
      if (tool) {
        e.preventDefault();
        useUiStore.getState().setActiveTool(tool);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

export default useShortcuts;
