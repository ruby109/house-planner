/**
 * 门窗工具的预览中间态。
 *
 * makeOpeningTool 每种类型创建一个独立的 store 实例（门/引き戸/窗互不干扰），
 * 同样**不进 planStore 历史**。
 */
import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { Pt } from '../model/types';
import type { OpeningCandidate } from './wallGeometry';

export interface OpeningDraftState {
  /** 命中墙时的放置候选（valid=false 表示墙太短或与已有开口重叠） */
  candidate: OpeningCandidate | null;
  /** 未命中墙时的指针位置（预览跟随指针并置灰） */
  pointer: Pt | null;
  set: (candidate: OpeningCandidate | null, pointer: Pt | null) => void;
  reset: () => void;
}

export type OpeningDraftStore = UseBoundStore<StoreApi<OpeningDraftState>>;

export function createOpeningDraftStore(): OpeningDraftStore {
  return create<OpeningDraftState>()((set) => ({
    candidate: null,
    pointer: null,
    set: (candidate, pointer) => set({ candidate, pointer }),
    reset: () => set({ candidate: null, pointer: null }),
  }));
}
