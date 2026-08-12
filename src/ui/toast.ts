/**
 * 极简一次性提示条（M1d）。
 *
 * 用途：房间未找到封闭区域、JSON 导入校验失败、门窗宽度非法等需要告知用户但
 * 不该打断操作的场景。不引第三方 UI 库，只有一条消息 + 自动消失。
 */
import { create } from 'zustand';

export type ToastKind = 'info' | 'error';

export interface ToastState {
  message: string | null;
  kind: ToastKind;
  /** 每次提示自增，用于让相同文案也能重新触发计时 */
  seq: number;
  show: (message: string, kind?: ToastKind) => void;
  dismiss: () => void;
}

export const useToastStore = create<ToastState>()((set) => ({
  message: null,
  kind: 'info',
  seq: 0,
  show: (message, kind = 'info') => set((s) => ({ message, kind, seq: s.seq + 1 })),
  dismiss: () => set({ message: null }),
}));

/** 在非组件代码（工具、持久化）里发提示 */
export function notify(message: string, kind: ToastKind = 'info'): void {
  useToastStore.getState().show(message, kind);
}
