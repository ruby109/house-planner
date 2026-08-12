/**
 * 工具系统契约（见 docs/ARCHITECTURE.md 第 4 节）。
 *
 * 每个工具一个模块，实现 ToolHandler 并在 registry.ts 注册。
 * PlanCanvas 只负责把指针事件路由给当前激活工具，不包含任何工具逻辑。
 *
 * 约定：
 * - 工具内部的绘制中间态（橡皮筋预览等）由工具模块自己持有
 *   （推荐每个工具文件里建一个自己的小 zustand store），不进 planStore 历史。
 * - 工具通过直接 import planStore / uiStore 来读写全局状态；
 *   ToolContext 只携带本次事件的数据。
 * - 画布上的可选中图形必须设置 Konva 的 `id` 为元素 id（w_/o_/s_/f_ 前缀），
 *   select 工具靠它做命中；装饰性图形不要设 id。
 */
import type { ComponentType } from 'react';
import type { Pt } from '../model/types';

export interface ToolContext {
  /** 指针文档坐标 mm（整数，未吸附） */
  pt: Pt;
  /** 按 uiStore.effectiveSnapStep() 吸附后的文档坐标 mm */
  snapped: Pt;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  /** 事件命中的 Konva 节点 id（未命中或未设 id 时为 null） */
  targetId: string | null;
}

export interface ToolHandler {
  /** 仅左键（button 0）事件会被路由到这里；平移/缩放由 PlanCanvas 自行消化 */
  onPointerDown?: (ctx: ToolContext) => void;
  onPointerMove?: (ctx: ToolContext) => void;
  onPointerUp?: (ctx: ToolContext) => void;
  /** 左键双击（M1d 起：select 工具用它把封闭区域变成房间） */
  onDoubleClick?: (ctx: ToolContext) => void;
  /** Esc 或切换工具时调用：丢弃绘制中间态 */
  onCancel?: () => void;
  /**
   * 绘制预览组件，渲染在 OverlayLayer 内部。
   * 必须返回 react-konva 图形节点（Group/Line/Rect…），**不要**返回 Layer。
   */
  Preview?: ComponentType;
}
