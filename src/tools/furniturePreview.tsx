/**
 * 家具放置工具的绘制预览（渲染在 OverlayLayer 内部，只返回图形节点）。
 *
 * 预览半透明矩形 + 居中名称；与已有家具或墙发生 SAT 碰撞时描红
 * （见 docs/ARCHITECTURE.md 第 5 节：碰撞只提示不阻止）。
 */
import { Group, Rect, Text } from 'react-konva';
import { create } from 'zustand';
import type { Pt } from '../model/types';
import { usePlanStore } from '../store/planStore';
import { useUiStore } from '../store/uiStore';
import {
  COLLISION_COLOR,
  PREVIEW_OPACITY,
  SELECT_COLOR,
  STROKE_ACTIVE_PX,
  cornerRadiusMm,
  labelFontSizeMm,
  labelVisible,
} from '../ui/canvasStyle';
import { rectCollides } from './collision';

export interface FurniturePreviewState {
  /** 预览中心（吸附后），null = 不显示 */
  center: Pt | null;
  setCenter: (p: Pt) => void;
  clear: () => void;
}

export const useFurniturePreviewStore = create<FurniturePreviewState>()((set) => ({
  center: null,
  setCenter: (p) => set({ center: p }),
  clear: () => set({ center: null }),
}));

export function FurniturePreview() {
  const center = useFurniturePreviewStore((s) => s.center);
  const pending = useUiStore((s) => s.pendingFurniture);
  const scale = useUiStore((s) => s.scale);
  const walls = usePlanStore((s) => s.doc.walls);
  const furniture = usePlanStore((s) => s.doc.furniture);

  if (!center || !pending) return null;

  const { w, d } = pending;
  const colliding = rectCollides({ position: center, w, d, rotation: 0 }, walls, furniture);
  const fontSize = labelFontSizeMm(w, d);

  return (
    <Group x={center.x} y={center.y} listening={false} opacity={PREVIEW_OPACITY}>
      <Rect
        x={-w / 2}
        y={-d / 2}
        width={w}
        height={d}
        cornerRadius={cornerRadiusMm(w, d)}
        fill={pending.color}
        stroke={colliding ? COLLISION_COLOR : SELECT_COLOR}
        strokeWidth={STROKE_ACTIVE_PX}
        strokeScaleEnabled={false}
        listening={false}
        perfectDrawEnabled={false}
      />
      {labelVisible(fontSize, scale) && (
        <Text
          x={-w / 2}
          y={-d / 2}
          width={w}
          height={d}
          text={pending.name}
          fontSize={fontSize}
          align="center"
          verticalAlign="middle"
          fill={colliding ? COLLISION_COLOR : '#23303D'}
          listening={false}
          perfectDrawEnabled={false}
        />
      )}
    </Group>
  );
}

export default FurniturePreview;
