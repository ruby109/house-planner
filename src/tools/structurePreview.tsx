/**
 * 柱/梁工具的绘制预览（渲染在 OverlayLayer 内部，因此只返回图形节点，不返回 Layer）。
 *
 * 预览中间态由工具自己的小 zustand store 持有，**不进 planStore 历史**
 * （见 src/tools/types.ts 的约定）。
 */
import type { ComponentType } from 'react';
import { Rect } from 'react-konva';
import { create } from 'zustand';
import type { Pt, StructureKind } from '../model/types';
import {
  BEAM_DASH_PX,
  PREVIEW_OPACITY,
  STROKE_ACTIVE_PX,
  STRUCTURE_DEFAULT_SIZE,
  STRUCTURE_STROKE,
  structureFill,
} from '../ui/canvasStyle';

export interface StructurePreviewState {
  /** 预览矩形中心（吸附后），null = 不显示 */
  center: Pt | null;
  setCenter: (p: Pt) => void;
  clear: () => void;
}

export interface StructurePreview {
  useStore: ReturnType<typeof createStore>;
  Preview: ComponentType;
}

function createStore() {
  return create<StructurePreviewState>()((set) => ({
    center: null,
    setCenter: (p) => set({ center: p }),
    clear: () => set({ center: null }),
  }));
}

/** 为某一种结构（柱 / 梁）造一套「预览 store + 预览组件」 */
export function createStructurePreview(kind: StructureKind): StructurePreview {
  const useStore = createStore();
  const size = STRUCTURE_DEFAULT_SIZE[kind];

  const Preview: ComponentType = () => {
    const center = useStore((s) => s.center);
    if (!center) return null;
    return (
      <Rect
        x={center.x}
        y={center.y}
        offsetX={size.width / 2}
        offsetY={size.depth / 2}
        width={size.width}
        height={size.depth}
        fill={structureFill(kind)}
        stroke={STRUCTURE_STROKE}
        strokeWidth={STROKE_ACTIVE_PX}
        strokeScaleEnabled={false}
        dash={kind === 'beam' ? BEAM_DASH_PX : undefined}
        opacity={PREVIEW_OPACITY}
        listening={false}
        perfectDrawEnabled={false}
      />
    );
  };

  return { useStore, Preview };
}
