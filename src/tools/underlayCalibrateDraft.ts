/**
 * 底图两点标定的绘制中间态（M2）。
 *
 * 与其它工具一致：中间态放在工具自己的小 zustand store 里，**不进 planStore 历史**。
 * `awaitingInput = true` 表示两点已定、正在等用户在小面板里输入实际长度，
 * 此时画布上的点击一律忽略。
 */
import { create } from 'zustand';
import type { Pt } from '../model/types';

export interface UnderlayCalibrateDraftState {
  /** 第一个端点（未吸附网格：标定精度直接决定描图质量） */
  a: Pt | null;
  /** 第二个端点 */
  b: Pt | null;
  /** 指针位置，用于第一点确定后的橡皮筋 */
  hover: Pt | null;
  /** 是否正在等待输入实际长度 */
  awaitingInput: boolean;
  begin: (p: Pt) => void;
  move: (p: Pt) => void;
  finish: (p: Pt) => void;
  reset: () => void;
}

export const useUnderlayCalibrateDraft = create<UnderlayCalibrateDraftState>()((set) => ({
  a: null,
  b: null,
  hover: null,
  awaitingInput: false,
  begin: (p) => set({ a: p, b: null, hover: p, awaitingInput: false }),
  move: (p) => set({ hover: p }),
  finish: (p) => set({ b: p, hover: p, awaitingInput: true }),
  reset: () => set({ a: null, b: null, hover: null, awaitingInput: false }),
}));
