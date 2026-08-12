/**
 * uiStore —— 不可撤销的编辑器状态（见 docs/ARCHITECTURE.md 第 3 节）。
 * 这里的任何东西都**不进 undo 历史**。
 */
import { create } from 'zustand';
import { DEFAULT_SNAP_STEP, SNAP_STEPS, type SnapStep } from '../model/defaults';
import type { Pt } from '../model/types';
import type { DisplayUnit } from '../utils/units';

export type Tool =
  | 'select'
  | 'wall'
  | 'door'
  | 'sliding_door'
  | 'window'
  | 'column'
  | 'beam'
  | 'furniture_place'
  /** M2：底图两点比例标定（由底图面板进入，不在工具栏常驻） */
  | 'underlay_calibrate';

/** 家具放置模式的待放对象 */
export interface PendingFurniture {
  /** null = 自定义尺寸 */
  catalogId: string | null;
  name: string;
  w: number;
  d: number;
  color: string;
}

export interface UiState {
  activeTool: Tool;
  /** 选中元素 id，跨类型统一放一个数组 */
  selection: string[];
  snapStep: SnapStep;
  snapEnabled: boolean;
  displayUnit: DisplayUnit;
  pendingFurniture: PendingFurniture | null;

  /** 指针的文档坐标 mm（离开画布为 null），仅供 StatusBar 显示 */
  pointer: Pt | null;
  /** 当前 Stage scale（px/mm），由 PlanCanvas 回写，仅供 StatusBar 显示 */
  scale: number;
  /** 「适应视图」请求计数；PlanCanvas 监听其变化执行 fit */
  fitToken: number;

  /** M2：PNG 导出是否包含底图（默认不含——描完图导出的是干净平面图） */
  exportWithUnderlay: boolean;
  /**
   * M2：底图透明度滑条拖动中的实时值（null = 用文档里的值）。
   * 放在 UI 层是为了「拖动时实时预览、松手才写文档」＝ 一次调整只留一步撤销。
   */
  underlayOpacityPreview: number | null;

  setActiveTool: (tool: Tool) => void;
  setSelection: (ids: string[]) => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  setSnapStep: (step: SnapStep) => void;
  setSnapEnabled: (enabled: boolean) => void;
  toggleSnap: () => void;
  /** 实际生效的吸附步长：关闭吸附时为 1（自由） */
  effectiveSnapStep: () => number;
  setDisplayUnit: (unit: DisplayUnit) => void;
  toggleDisplayUnit: () => void;
  setPendingFurniture: (p: PendingFurniture | null) => void;
  setPointer: (p: Pt | null) => void;
  setScale: (scale: number) => void;
  /** 适应视图 */
  requestFit: () => void;
  setExportWithUnderlay: (on: boolean) => void;
  setUnderlayOpacityPreview: (v: number | null) => void;
}

export const useUiStore = create<UiState>()((set, get) => ({
  activeTool: 'select',
  selection: [],
  snapStep: DEFAULT_SNAP_STEP,
  snapEnabled: true,
  displayUnit: 'ja',
  pendingFurniture: null,
  pointer: null,
  scale: 0,
  fitToken: 0,
  exportWithUnderlay: false,
  underlayOpacityPreview: null,

  setActiveTool: (tool) =>
    set((s) => ({
      activeTool: tool,
      // 离开家具放置模式时清掉待放对象
      pendingFurniture: tool === 'furniture_place' ? s.pendingFurniture : null,
      // 切到非选择工具时清空选中
      selection: tool === 'select' ? s.selection : [],
    })),

  setSelection: (ids) => set({ selection: ids }),

  toggleSelection: (id) =>
    set((s) => ({
      selection: s.selection.includes(id)
        ? s.selection.filter((x) => x !== id)
        : [...s.selection, id],
    })),

  clearSelection: () => set({ selection: [] }),

  setSnapStep: (step) => set({ snapStep: step }),
  setSnapEnabled: (enabled) => set({ snapEnabled: enabled }),
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
  effectiveSnapStep: () => {
    const s = get();
    return s.snapEnabled ? s.snapStep : 1;
  },

  setDisplayUnit: (unit) => set({ displayUnit: unit }),
  toggleDisplayUnit: () => set((s) => ({ displayUnit: s.displayUnit === 'ja' ? 'metric' : 'ja' })),

  setPendingFurniture: (p) =>
    set({ pendingFurniture: p, activeTool: p ? 'furniture_place' : 'select' }),

  setPointer: (p) => set({ pointer: p }),
  setScale: (scale) => set({ scale }),
  requestFit: () => set((s) => ({ fitToken: s.fitToken + 1 })),
  setExportWithUnderlay: (on) => set({ exportWithUnderlay: on }),
  setUnderlayOpacityPreview: (v) => set({ underlayOpacityPreview: v }),
}));

export { SNAP_STEPS };
export type { SnapStep };
