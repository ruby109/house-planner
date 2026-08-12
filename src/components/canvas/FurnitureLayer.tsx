/**
 * 家具层 —— M1c 实现。
 * 需求：圆角矩形 + 居中名称；节点 id = furniture.id；选中时挂 Transformer
 * （旋转 + 缩放手柄，transformEnd 把 scale 折算回 size 后重置 scale=1）；
 * 拖拽吸附、与其他家具/墙 SAT 碰撞时红色高亮（不阻止）；
 * locked 家具不可拖不可变换。
 *
 * 结构：每件家具是一个 Group（承担拖拽 / 变换），内部 Rect 带 id 供 select 工具命中，
 * 名称 Text 不参与命中。Group 原点即家具中心，旋转与缩放都绕中心。
 *
 * 注意：整层返回 `<Group>` 而非 `<Layer>`——M1d 把 Stage 层数压到 5 层，
 * 本组件与 StructureLayer 合用同一个 Layer（渲染顺序不变：furniture 在 structures 之上）。
 */
import { useEffect, useMemo, useRef } from 'react';
import { Group, Rect, Text, Transformer } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { Group as KonvaGroup } from 'konva/lib/Group';
import type { Transformer as KonvaTransformer } from 'konva/lib/shapes/Transformer';
import { roundPt } from '../../model/defaults';
import type { Furniture } from '../../model/types';
import { usePlanStore } from '../../store/planStore';
import { useUiStore } from '../../store/uiStore';
import { collidingFurnitureIds } from '../../tools/collision';
import {
  COLLISION_COLOR,
  FURNITURE_STROKE,
  LOCKED_COLOR,
  MIN_FURNITURE_SIZE,
  SELECT_COLOR,
  STROKE_ACTIVE_PX,
  STROKE_PX,
  cornerRadiusMm,
  labelFontSizeMm,
  labelVisible,
} from '../../ui/canvasStyle';
import { snapPt } from '../../utils/geometry';

const ROTATION_SNAPS = [0, 90, 180, 270];
const CORNER_ANCHORS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/**
 * 按在 Transformer 手柄上时阻止事件冒泡到 Stage。
 * 否则 PlanCanvas 会把这次 mousedown 路由给 select 工具，
 * 而手柄没有 id（targetId = null）会被当成「点空白」从而清空选中，
 * Transformer 随即卸载、变换中断。
 */
const stopBubble = (e: KonvaEventObject<MouseEvent>) => {
  e.cancelBubble = true;
};
/** 锁定家具的虚线描边（px，需 strokeScaleEnabled={false}） */
const LOCKED_DASH_PX = [4, 3];

interface ShapeProps {
  item: Furniture;
  selected: boolean;
  colliding: boolean;
  /** 是否处于 select 工具 */
  interactive: boolean;
  scale: number;
}

function FurnitureShape({ item, selected, colliding, interactive, scale }: ShapeProps) {
  const groupRef = useRef<KonvaGroup | null>(null);
  const trRef = useRef<KonvaTransformer | null>(null);
  const moveFurniture = usePlanStore((s) => s.moveFurniture);
  const transformFurniture = usePlanStore((s) => s.transformFurniture);

  const editable = interactive && !item.locked;
  const showTransformer = selected && editable;

  useEffect(() => {
    if (!showTransformer) return;
    const tr = trRef.current;
    const node = groupRef.current;
    if (!tr || !node) return;
    tr.nodes([node]);
    tr.forceUpdate();
    tr.getLayer()?.batchDraw();
  }, [showTransformer, item.id, item.size.w, item.size.d, item.rotation]);

  const handleDragEnd = (e: KonvaEventObject<DragEvent>) => {
    const node = e.target;
    const step = useUiStore.getState().effectiveSnapStep();
    const p = snapPt({ x: node.x(), y: node.y() }, step);
    node.position(p);
    moveFurniture(item.id, p);
  };

  /** 把 Transformer 的 scale 折算回 size（最小 100mm），并把 scale 重置为 1 */
  const handleTransformEnd = () => {
    const node = groupRef.current;
    if (!node) return;
    const sx = Math.abs(node.scaleX()) || 1;
    const sy = Math.abs(node.scaleY()) || 1;
    const w = Math.max(MIN_FURNITURE_SIZE, Math.round(item.size.w * sx));
    const d = Math.max(MIN_FURNITURE_SIZE, Math.round(item.size.d * sy));
    const rotation = node.rotation();
    const position = roundPt({ x: node.x(), y: node.y() });
    node.scaleX(1);
    node.scaleY(1);
    node.position(position);
    transformFurniture(item.id, position, { w, d }, rotation);
  };

  const { w, d } = item.size;
  const fontSize = labelFontSizeMm(w, d);
  const stroke = colliding
    ? COLLISION_COLOR
    : selected
      ? SELECT_COLOR
      : item.locked
        ? LOCKED_COLOR
        : FURNITURE_STROKE;

  return (
    <>
      <Group
        ref={groupRef}
        x={item.position.x}
        y={item.position.y}
        rotation={item.rotation}
        draggable={editable}
        onDragEnd={handleDragEnd}
        onTransformEnd={handleTransformEnd}
      >
        <Rect
          id={item.id}
          x={-w / 2}
          y={-d / 2}
          width={w}
          height={d}
          cornerRadius={cornerRadiusMm(w, d)}
          fill={item.color}
          stroke={stroke}
          strokeWidth={colliding || selected ? STROKE_ACTIVE_PX : STROKE_PX}
          strokeScaleEnabled={false}
          dash={item.locked ? LOCKED_DASH_PX : undefined}
          perfectDrawEnabled={false}
        />
        {labelVisible(fontSize, scale) && (
          <Text
            x={-w / 2}
            y={-d / 2}
            width={w}
            height={d}
            text={item.name}
            fontSize={fontSize}
            align="center"
            verticalAlign="middle"
            fill="#23303D"
            listening={false}
            perfectDrawEnabled={false}
          />
        )}
      </Group>
      {showTransformer && (
        <Transformer
          ref={trRef}
          rotateEnabled
          rotationSnaps={ROTATION_SNAPS}
          rotationSnapTolerance={8}
          enabledAnchors={CORNER_ANCHORS}
          keepRatio
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

export function FurnitureLayer() {
  const furniture = usePlanStore((s) => s.doc.furniture);
  const walls = usePlanStore((s) => s.doc.walls);
  const selection = useUiStore((s) => s.selection);
  const activeTool = useUiStore((s) => s.activeTool);
  const scale = useUiStore((s) => s.scale);

  // 家具 ≤ 100 件，直接全量算（见 M1c 需求）
  const colliding = useMemo(() => collidingFurnitureIds(furniture, walls), [furniture, walls]);
  const interactive = activeTool === 'select';

  return (
    <Group>
      {furniture.map((f) => (
        <FurnitureShape
          key={f.id}
          item={f}
          selected={selection.includes(f.id)}
          colliding={colliding.has(f.id)}
          interactive={interactive}
          scale={scale}
        />
      ))}
    </Group>
  );
}

export default FurnitureLayer;
