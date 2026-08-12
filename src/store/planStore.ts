/**
 * planStore —— 可撤销的文档状态（见 docs/ARCHITECTURE.md 第 3 节）。
 *
 * - 只装 `doc: PlanDoc` 与修改它的 action，**绝不放 UI 状态**。
 * - 用 zundo 的 temporal 中间件包裹，`partialize` 保证只有 doc 进历史。
 * - 拖拽中间态不 commit：拖拽过程用 Konva 节点自身位置，onDragEnd/onTransformEnd 才写 store。
 */
import { create } from 'zustand';
import { temporal } from 'zundo';
import { UNDERLAY_ID, createEmptyDoc, idPrefix } from '../model/defaults';
import type { PlanDoc } from '../model/types';
import type { DocMutator } from './docMutator';
import { createUnderlayActions, type UnderlayActions } from './actions/underlayActions';
import { createWallsActions, type WallsActions } from './actions/wallsActions';
import { createOpeningsActions, type OpeningsActions } from './actions/openingsActions';
import { createStructuresActions, type StructuresActions } from './actions/structuresActions';
import { createFurnitureActions, type FurnitureActions } from './actions/furnitureActions';
import { createRoomsActions, type RoomsActions } from './actions/roomsActions';

export interface PlanDocState {
  doc: PlanDoc;
  /** 整篇替换（导入 JSON / 恢复本地存档） */
  replaceDoc: (doc: PlanDoc) => void;
  /** 清空为新文档 */
  resetDoc: () => void;
  setDocName: (name: string) => void;
  /** 按 id 前缀分派删除，供选择工具统一调用 */
  removeByIds: (ids: string[]) => void;
}

export type PlanStore = PlanDocState &
  UnderlayActions &
  WallsActions &
  OpeningsActions &
  StructuresActions &
  FurnitureActions &
  RoomsActions;

export const usePlanStore = create<PlanStore>()(
  temporal(
    (set) => {
      const mutate: DocMutator = (recipe) =>
        set((state) => {
          const next = recipe(state.doc);
          if (next === state.doc) return state;
          return {
            doc: { ...next, meta: { ...next.meta, updatedAt: new Date().toISOString() } },
          };
        });

      const underlay = createUnderlayActions(mutate);
      const walls = createWallsActions(mutate);
      const openings = createOpeningsActions(mutate);
      const structures = createStructuresActions(mutate);
      const furniture = createFurnitureActions(mutate);
      const rooms = createRoomsActions(mutate);

      return {
        doc: createEmptyDoc(),

        replaceDoc: (doc) => set({ doc }),
        resetDoc: () => set({ doc: createEmptyDoc() }),
        setDocName: (name) =>
          mutate((doc) => ({ ...doc, meta: { ...doc.meta, name } })),

        removeByIds: (ids) => {
          const buckets: Record<string, string[]> = { w: [], o: [], s: [], r: [], f: [], a: [] };
          for (const id of ids) {
            // 底图是单例，没有 id 前缀，单独分派
            if (id === UNDERLAY_ID) {
              underlay.setUnderlay(null);
              continue;
            }
            const p = idPrefix(id);
            if (p) buckets[p].push(id);
          }
          if (buckets.w.length) walls.removeWalls(buckets.w);
          if (buckets.o.length) openings.removeOpenings(buckets.o);
          if (buckets.s.length) structures.removeStructures(buckets.s);
          if (buckets.f.length) furniture.removeFurnitures(buckets.f);
          if (buckets.r.length) rooms.removeRooms(buckets.r);
          if (buckets.a.length) {
            mutate((doc) => {
              const set2 = new Set(buckets.a);
              const annotations = doc.annotations.filter((a) => !set2.has(a.id));
              return annotations.length === doc.annotations.length
                ? doc
                : { ...doc, annotations };
            });
          }
        },

        ...underlay,
        ...walls,
        ...openings,
        ...structures,
        ...furniture,
        ...rooms,
      };
    },
    {
      limit: 200,
      // 只把 doc 记入历史；任何 UI 状态都不会被 undo 影响
      partialize: (state) => ({ doc: state.doc }),
      equality: (a, b) => a.doc === b.doc,
    },
  ),
);

// ---------------------------------------------------------------------------
// temporal（undo / redo）访问入口
//
// zundo 会在 store 上挂 `.temporal`。这里用一层最小接口做类型收敛，
// 既避免到处写 zundo 的内部泛型，也让 M1d 接线 undo/redo 时只依赖这几个方法。
// ---------------------------------------------------------------------------

export interface TemporalStateLike {
  pastStates: unknown[];
  futureStates: unknown[];
  undo: (steps?: number) => void;
  redo: (steps?: number) => void;
  clear: () => void;
  pause: () => void;
  resume: () => void;
}

export interface TemporalApi {
  getState: () => TemporalStateLike;
  subscribe: (listener: (state: TemporalStateLike) => void) => () => void;
}

export const planTemporal = (usePlanStore as unknown as { temporal: TemporalApi }).temporal;

export const undo = (steps = 1): void => planTemporal.getState().undo(steps);
export const redo = (steps = 1): void => planTemporal.getState().redo(steps);
export const clearHistory = (): void => planTemporal.getState().clear();

/**
 * 暂停 / 恢复历史记录。
 *
 * 用于「实时预览 + 一步撤销」：输入框逐字修改时 `pauseHistory()`，
 * 中间态照常写 store（画布实时跟随）但不进历史；提交时先把 store 复位到
 * 编辑前的值（仍在暂停中，不留痕），再 `resumeHistory()` 并写入最终值，
 * 于是整段编辑只产生**一条**历史（编辑前 → 最终值）。
 *
 * 调用方必须保证成对：组件卸载 / 切换选中时若仍在暂停，务必 resume，
 * 否则历史会永久停摆。
 */
export const pauseHistory = (): void => planTemporal.getState().pause();
export const resumeHistory = (): void => planTemporal.getState().resume();
export const canUndo = (): boolean => planTemporal.getState().pastStates.length > 0;
export const canRedo = (): boolean => planTemporal.getState().futureStates.length > 0;
