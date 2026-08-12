/**
 * 结构层（柱/梁）—— M1c 实现。
 * 需求：柱=实心方块、梁=虚线描边半透明矩形；节点 id = structure.id；
 * select 工具下可拖动（onDragEnd 写 position，吸附）。
 *
 * 约定回顾（ARCHITECTURE.md）：
 * - Konva 坐标直接写 mm，mm→px 只由 Stage 的 scale/position 完成；
 * - 拖拽/旋转的中间态不 commit，只在 onDragEnd / onTransformEnd 写 store。
 *
 * 注意：返回 `<Group>` 而非 `<Layer>`——M1d 把 Stage 层数压到 5 层，
 * 本组件与 FurnitureLayer 合用同一个 Layer（渲染顺序不变：structures 在 furniture 之下）。
 */
import { useEffect, useRef } from 'react';
import { Group, Rect, Transformer } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { Rect as KonvaRect } from 'konva/lib/shapes/Rect';
import type { Transformer as KonvaTransformer } from 'konva/lib/shapes/Transformer';
import { roundPt } from '../../model/defaults';
import type { Structure } from '../../model/types';
import { usePlanStore } from '../../store/planStore';
import { useUiStore } from '../../store/uiStore';
import {
  BEAM_DASH_PX,
  SELECT_COLOR,
  STROKE_ACTIVE_PX,
  STROKE_PX,
  STRUCTURE_STROKE,
  structureFill,
} from '../../ui/canvasStyle';
import { snapPt } from '../../utils/geometry';

/** 旋转手柄的吸附角度（仍可自由旋转，只是靠近这些角度时吸附） */
const ROTATION_SNAPS = [0, 90, 180, 270];

/**
 * 按在 Transformer 手柄上时阻止冒泡到 Stage：手柄没有 id，
 * 否则 select 工具会把它当成「点空白」而清空选中，导致旋转中断。
 */
const stopBubble = (e: KonvaEventObject<MouseEvent>) => {
  e.cancelBubble = true;
};

interface ShapeProps {
  item: Structure;
  selected: boolean;
  /** 是否处于 select 工具（可拖动 / 可变换） */
  interactive: boolean;
}

function StructureShape({ item, selected, interactive }: ShapeProps) {
  const shapeRef = useRef<KonvaRect | null>(null);
  const trRef = useRef<KonvaTransformer | null>(null);
  const updateStructure = usePlanStore((s) => s.updateStructure);
  const moveStructure = usePlanStore((s) => s.moveStructure);

  const showTransformer = selected && interactive;

  useEffect(() => {
    if (!showTransformer) return;
    const tr = trRef.current;
    const node = shapeRef.current;
    if (!tr || !node) return;
    tr.nodes([node]);
    tr.forceUpdate();
    tr.getLayer()?.batchDraw();
  }, [showTransformer, item.id, item.width, item.depth, item.rotation]);

  const handleDragEnd = (e: KonvaEventObject<DragEvent>) => {
    const node = e.target;
    const step = useUiStore.getState().effectiveSnapStep();
    const p = snapPt({ x: node.x(), y: node.y() }, step);
    node.position(p);
    moveStructure(item.id, p);
  };

  const handleTransformEnd = () => {
    const node = shapeRef.current;
    if (!node) return;
    // 只开旋转，scale 理论上恒为 1；保险起见重置一次
    node.scaleX(1);
    node.scaleY(1);
    const position = roundPt({ x: node.x(), y: node.y() });
    node.position(position);
    updateStructure(item.id, { position, rotation: node.rotation() });
  };

  const stroke = selected ? SELECT_COLOR : STRUCTURE_STROKE;

  return (
    <>
      <Rect
        ref={shapeRef}
        id={item.id}
        x={item.position.x}
        y={item.position.y}
        offsetX={item.width / 2}
        offsetY={item.depth / 2}
        width={item.width}
        height={item.depth}
        rotation={item.rotation}
        fill={structureFill(item.kind)}
        stroke={stroke}
        strokeWidth={selected ? STROKE_ACTIVE_PX : STROKE_PX}
        strokeScaleEnabled={false}
        dash={item.kind === 'beam' ? BEAM_DASH_PX : undefined}
        draggable={interactive}
        onDragEnd={handleDragEnd}
        onTransformEnd={handleTransformEnd}
        perfectDrawEnabled={false}
      />
      {showTransformer && (
        <Transformer
          ref={trRef}
          resizeEnabled={false}
          rotateEnabled
          rotationSnaps={ROTATION_SNAPS}
          rotationSnapTolerance={8}
          onMouseDown={stopBubble}
          borderStroke={SELECT_COLOR}
          anchorStroke={SELECT_COLOR}
          anchorFill="#ffffff"
          anchorSize={8}
          ignoreStroke
        />
      )}
    </>
  );
}

export function StructureLayer() {
  const structures = usePlanStore((s) => s.doc.structures);
  const selection = useUiStore((s) => s.selection);
  const activeTool = useUiStore((s) => s.activeTool);
  const interactive = activeTool === 'select';

  return (
    <Group>
      {structures.map((s) => (
        <StructureShape
          key={s.id}
          item={s}
          selected={selection.includes(s.id)}
          interactive={interactive}
        />
      ))}
    </Group>
  );
}

export default StructureLayer;
