/**
 * 画墙工具的绘制中间态。
 *
 * 按 tools/types.ts 的约定，绘制中间态由工具自己持有的小 zustand store 保存，
 * **不进 planStore 历史**。WallPreview 订阅它渲染橡皮筋。
 */
import { create } from 'zustand';
import type { Pt } from '../model/types';

export interface WallDraftState {
  /** 当前段起点；null = 未开始连画 */
  start: Pt | null;
  /** 当前段（已做正交约束的）终点 */
  end: Pt | null;
  /** 自由角度（按住 Shift）——仅用于预览提示 */
  free: boolean;
  begin: (p: Pt) => void;
  move: (p: Pt, free: boolean) => void;
  reset: () => void;
}

export const useWallDraft = create<WallDraftState>()((set) => ({
  start: null,
  end: null,
  free: false,
  begin: (p) => set({ start: p, end: p }),
  move: (p, free) => set({ end: p, free }),
  reset: () => set({ start: null, end: null, free: false }),
}));
