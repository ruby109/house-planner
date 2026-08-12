/**
 * 墙体 + 门窗符号层 —— M1b。
 *
 * - 墙：中心线渲染为 WALL_VISUAL_WIDTH(100mm) 宽、lineCap=square 的线段，
 *   Konva `id = wall.id` 供 select 工具命中；选中态用强调色高亮；
 * - 门窗：每个开口一个 `<Group>`（位置=洞口中心、旋转=墙方向角），
 *   内部符号用局部坐标画（见 OpeningSymbol），命中矩形的 `id = opening.id`；
 * - select 工具下：选中的墙显示端点手柄可拖动改端点；选中的开口可沿墙拖动改 offset。
 *
 * **拖拽中间态不写 store**：拖拽过程只改 Konva 节点自身位置，
 * onDragEnd 才调用 updateWall / moveOpening（见 ARCHITECTURE.md 第 3 节）。
 *
 * 注意：返回 `<Group>` 而非 `<Layer>`——M1d 把 Stage 层数压到 5 层，
 * 本组件与 RoomsLayer 合用同一个 Layer（渲染顺序不变：rooms 在 walls 之下）。
 */
import { Fragment, useMemo } from 'react';
import { Circle, Group, Line, Rect } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { WALL_VISUAL_WIDTH } from '../../model/defaults';
import type { Pt, Wall } from '../../model/types';
import { usePlanStore } from '../../store/planStore';
import { useUiStore } from '../../store/uiStore';
import { pointSegProjection, snapPt, wallLen } from '../../utils/geometry';
import {
  clampOpeningOffset,
  hasOpeningConflict,
  pointAlongWall,
  wallAngleDeg,
} from '../../tools/wallGeometry';
import {
  HANDLE_FILL,
  HANDLE_RADIUS_MM,
  HANDLE_STROKE,
  HAIRLINE_PX,
  OPENING_HIT_DEPTH_MM,
  SELECTED_COLOR,
  SYMBOL_COLOR,
  WALL_COLOR,
  WALL_HIT_WIDTH_MM,
} from '../../tools/m1bStyle';
import { NAME_HANDLE } from '../../utils/exportPng';
import { OpeningSymbol } from './OpeningSymbol';

/** 命中用的透明填充：Konva 只看「有没有 fill」，颜色的 alpha 不影响命中 */
const HIT_FILL = 'rgba(0,0,0,0)';

export function WallsLayer() {
  const walls = usePlanStore((s) => s.doc.walls);
  const openings = usePlanStore((s) => s.doc.openings);
  const updateWall = usePlanStore((s) => s.updateWall);
  const moveOpening = usePlanStore((s) => s.moveOpening);
  const selection = useUiStore((s) => s.selection);
  const activeTool = useUiStore((s) => s.activeTool);

  const wallById = useMemo(() => {
    const m = new Map<string, Wall>();
    for (const w of walls) m.set(w.id, w);
    return m;
  }, [walls]);

  const selected = useMemo(() => new Set(selection), [selection]);
  const selectMode = activeTool === 'select';

  // ------------------------------------------------------------ 墙端点拖动
  const handleWallHandleDragEnd = (wall: Wall, which: 'start' | 'end') =>
    (e: KonvaEventObject<DragEvent>) => {
      const node = e.target;
      const step = useUiStore.getState().effectiveSnapStep();
      const p: Pt = snapPt({ x: node.x(), y: node.y() }, step);
      // 先把节点摆到最终位置，避免 React 因 props 未变而不复位
      node.position(p);
      updateWall(wall.id, which === 'start' ? { start: p } : { end: p });
    };

  // ------------------------------------------------------------ 开口沿墙拖动
  /** 把拖拽中的节点位置投影回墙，返回 clamp 后的 offset */
  const projectOntoWall = (node: { x(): number; y(): number }, wall: Wall, width: number) => {
    const proj = pointSegProjection({ x: node.x(), y: node.y() }, wall.start, wall.end);
    return clampOpeningOffset(proj.along, width, wallLen(wall));
  };

  return (
    <Group>
      {/* 1) 墙体 */}
      {walls.map((w) => (
        <Line
          key={w.id}
          id={w.id}
          points={[w.start.x, w.start.y, w.end.x, w.end.y]}
          stroke={selected.has(w.id) ? SELECTED_COLOR : WALL_COLOR}
          strokeWidth={WALL_VISUAL_WIDTH}
          hitStrokeWidth={WALL_HIT_WIDTH_MM}
          lineCap="square"
          perfectDrawEnabled={false}
        />
      ))}

      {/* 2) 门窗（含把墙擦出缺口） */}
      {openings.map((o) => {
        const wall = wallById.get(o.wallId);
        if (!wall) return null;
        const center = pointAlongWall(wall, o.offset);
        const isSelected = selected.has(o.id);
        const draggable = selectMode && isSelected;

        return (
          <Group
            key={o.id}
            x={center.x}
            y={center.y}
            rotation={wallAngleDeg(wall)}
            draggable={draggable}
            onDragMove={(e) => {
              const node = e.target;
              const offset = projectOntoWall(node, wall, o.width);
              node.position(pointAlongWall(wall, offset));
            }}
            onDragEnd={(e) => {
              const node = e.target;
              const offset = projectOntoWall(node, wall, o.width);
              const blocked =
                wallLen(wall) < o.width ||
                hasOpeningConflict(openings, o.wallId, offset, o.width, o.id);
              // 冲突则回到原位，不写 store
              const finalOffset = blocked ? o.offset : offset;
              node.position(pointAlongWall(wall, finalOffset));
              if (!blocked && finalOffset !== o.offset) moveOpening(o.id, finalOffset);
            }}
          >
            <OpeningSymbol
              type={o.type}
              width={o.width}
              swing={o.swing}
              color={isSelected ? SELECTED_COLOR : SYMBOL_COLOR}
              erase
            />
            {/* 命中区（id 必须是 opening.id） */}
            <Rect
              id={o.id}
              x={-o.width / 2}
              y={-OPENING_HIT_DEPTH_MM / 2}
              width={o.width}
              height={OPENING_HIT_DEPTH_MM}
              fill={HIT_FILL}
            />
          </Group>
        );
      })}

      {/* 3) 端点手柄（仅 select 工具 + 已选中的墙） */}
      {selectMode &&
        walls
          .filter((w) => selected.has(w.id))
          .map((w) => (
            <Fragment key={`h_${w.id}`}>
              {(['start', 'end'] as const).map((which) => {
                const p = w[which];
                return (
                  <Circle
                    key={which}
                    name={NAME_HANDLE}
                    x={p.x}
                    y={p.y}
                    radius={HANDLE_RADIUS_MM}
                    fill={HANDLE_FILL}
                    stroke={HANDLE_STROKE}
                    strokeWidth={HAIRLINE_PX * 1.5}
                    strokeScaleEnabled={false}
                    draggable
                    // 手柄没有 id：不能让 select 工具把它当成「点到空白」而清空选中
                    onMouseDown={(e) => {
                      e.cancelBubble = true;
                    }}
                    onDragEnd={handleWallHandleDragEnd(w, which)}
                  />
                );
              })}
            </Fragment>
          ))}
    </Group>
  );
}

export default WallsLayer;
