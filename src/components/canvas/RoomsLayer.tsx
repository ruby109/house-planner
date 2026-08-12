/**
 * 房间层 —— M1d 实现。
 *
 * - 半透明填充（按 floor 类型配色）+ 房间名 + 面积标签（畳 / ㎡ 跟随 displayUnit）；
 * - 多边形节点的 Konva `id = room.id`，select 工具靠它命中（前缀 r_）；
 * - 只在 select 工具下 listening，避免画墙 / 放家具时抢事件；
 * - 房间由「双击封闭区域」生成（见 tools/selectTool.ts），本层只负责渲染。
 *
 * 注意：本组件返回 `<Group>` 而不是 `<Layer>`——为了把 Stage 的层数压到 5 层以内，
 * rooms 与 walls 合并进 PlanCanvas 的同一个 Layer（渲染顺序不变：rooms 在 walls 之下）。
 */
import { Group, Line, Text } from 'react-konva';
import type { Pt, Room } from '../../model/types';
import { usePlanStore } from '../../store/planStore';
import { useUiStore } from '../../store/uiStore';
import { boundsOf, polygonAreaMm2 } from '../../utils/geometry';
import { formatArea, type DisplayUnit } from '../../utils/units';
import {
  FONT_FAMILY,
} from '../../tools/m1bStyle';
import {
  ROOM_FILL,
  ROOM_LABEL_COLOR,
  ROOM_SELECTED_STROKE_PX,
  SELECT_COLOR,
  labelVisible,
  roomLabelFontMm,
} from '../../ui/canvasStyle';

/** 多边形面积重心；退化时退回包围盒中心 */
export function polygonCentroid(poly: readonly Pt[]): Pt | null {
  if (poly.length === 0) return null;
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const cross = p.x * q.y - q.x * p.y;
    a2 += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a2) < 1e-6) {
    const b = boundsOf([...poly]);
    return b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : null;
  }
  return { x: cx / (3 * a2), y: cy / (3 * a2) };
}

function flatPoints(poly: readonly Pt[]): number[] {
  const out: number[] = [];
  for (const p of poly) out.push(p.x, p.y);
  return out;
}

interface RoomShapeProps {
  room: Room;
  selected: boolean;
  scale: number;
  unit: DisplayUnit;
}

function RoomShape({ room, selected, scale, unit }: RoomShapeProps) {
  if (room.polygon.length < 3) return null;

  const b = boundsOf(room.polygon);
  const center = polygonCentroid(room.polygon);
  const areaMm2 = polygonAreaMm2(room.polygon);
  const fontSize = b ? roomLabelFontMm(b.maxX - b.minX, b.maxY - b.minY) : 200;
  const showLabel = !!center && labelVisible(fontSize, scale);
  // 文字排版用的名义宽度（配合 align=center + offsetX 居中）
  const boxW = b ? Math.max(1, b.maxX - b.minX) : 1;

  return (
    <Group>
      <Line
        id={room.id}
        points={flatPoints(room.polygon)}
        closed
        fill={ROOM_FILL[room.floor]}
        stroke={selected ? SELECT_COLOR : undefined}
        strokeWidth={selected ? ROOM_SELECTED_STROKE_PX : 0}
        strokeScaleEnabled={false}
        perfectDrawEnabled={false}
      />
      {showLabel && center && (
        <Text
          x={center.x}
          y={center.y}
          text={`${room.name}\n${formatArea(areaMm2, unit)}`}
          fontSize={fontSize}
          fontFamily={FONT_FAMILY}
          lineHeight={1.25}
          fill={ROOM_LABEL_COLOR}
          align="center"
          width={boxW}
          offsetX={boxW / 2}
          offsetY={fontSize * 1.25}
          listening={false}
          perfectDrawEnabled={false}
        />
      )}
    </Group>
  );
}

export function RoomsLayer() {
  const rooms = usePlanStore((s) => s.doc.rooms);
  const selection = useUiStore((s) => s.selection);
  const activeTool = useUiStore((s) => s.activeTool);
  const displayUnit = useUiStore((s) => s.displayUnit);
  const scale = useUiStore((s) => s.scale);

  return (
    <Group listening={activeTool === 'select'}>
      {rooms.map((r) => (
        <RoomShape
          key={r.id}
          room={r}
          selected={selection.includes(r.id)}
          scale={scale}
          unit={displayUnit}
        />
      ))}
    </Group>
  );
}

export default RoomsLayer;
