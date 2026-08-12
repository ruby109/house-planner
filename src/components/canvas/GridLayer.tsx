import { useMemo } from 'react';
import { Group, Line } from 'react-konva';
import {
  GRID,
  GRID_AXIS_COLOR,
  GRID_MAJOR_COLOR,
  GRID_MINOR_COLOR,
  HALF_GRID,
} from '../../model/defaults';
import { NAME_GRID } from '../../utils/exportPng';

export interface ViewTransform {
  /** px/mm */
  scale: number;
  /** Stage x 偏移（px） */
  x: number;
  /** Stage y 偏移（px） */
  y: number;
}

interface GridLayerProps {
  view: ViewTransform;
  /** Stage 像素尺寸 */
  width: number;
  height: number;
}

/** 次线（455）在屏幕上小于该像素间距时隐藏 */
const MIN_MINOR_PX = 8;
/** 主线（910）在屏幕上小于该像素间距时隐藏 */
const MIN_MAJOR_PX = 5;
/** 单方向最多画多少条线，防止极端缩放下卡顿 */
const MAX_LINES_PER_AXIS = 2000;

function multiplesIn(min: number, max: number, step: number): number[] {
  const first = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = first; v <= max; v += step) {
    out.push(v);
    if (out.length > MAX_LINES_PER_AXIS) return [];
  }
  return out;
}

/**
 * 910 主网格 + 455 次网格。
 *
 * 注意：Konva 节点坐标直接写 mm，mm→px 只由 Stage 的 scale/position 完成。
 * 本组件读 view 仅用于推算**可见的 mm 范围**与决定线密度，不做坐标换算。
 * 线宽用 `strokeScaleEnabled={false}` 保持恒定 1px，同样避免手写 1/scale。
 *
 * 返回 `<Group>` 而非 `<Layer>`（M1d 把 Stage 压到 5 层）；`name={NAME_GRID}`
 * 供 PNG 导出时临时隐藏。
 */
interface GridLines {
  minor: number[][];
  major: number[][];
  axis: number[][];
}

export function GridLayer({ view, width, height }: GridLayerProps) {
  const lines = useMemo<GridLines>(() => {
    const { scale, x, y } = view;
    if (!Number.isFinite(scale) || scale <= 0 || width <= 0 || height <= 0) {
      return { minor: [], major: [], axis: [] };
    }

    // 可见区域的 mm 范围
    const left = (0 - x) / scale;
    const right = (width - x) / scale;
    const top = (0 - y) / scale;
    const bottom = (height - y) / scale;

    const showMinor = HALF_GRID * scale >= MIN_MINOR_PX;
    const showMajor = GRID * scale >= MIN_MAJOR_PX;

    const minor: number[][] = [];
    const major: number[][] = [];

    if (showMinor) {
      for (const vx of multiplesIn(left, right, HALF_GRID)) {
        if (vx % GRID === 0) continue; // 与主线重合的跳过
        minor.push([vx, top, vx, bottom]);
      }
      for (const vy of multiplesIn(top, bottom, HALF_GRID)) {
        if (vy % GRID === 0) continue;
        minor.push([left, vy, right, vy]);
      }
    }

    if (showMajor) {
      for (const vx of multiplesIn(left, right, GRID)) {
        if (vx === 0) continue; // 轴线单独画
        major.push([vx, top, vx, bottom]);
      }
      for (const vy of multiplesIn(top, bottom, GRID)) {
        if (vy === 0) continue;
        major.push([left, vy, right, vy]);
      }
    }

    const axis: number[][] = [];
    if (left <= 0 && right >= 0) axis.push([0, top, 0, bottom]);
    if (top <= 0 && bottom >= 0) axis.push([left, 0, right, 0]);

    return { minor, major, axis };
  }, [view, width, height]);

  return (
    <Group name={NAME_GRID} listening={false}>
      {lines.minor.map((pts, i) => (
        <Line
          key={`mi${i}`}
          points={pts}
          stroke={GRID_MINOR_COLOR}
          strokeWidth={1}
          strokeScaleEnabled={false}
          perfectDrawEnabled={false}
          listening={false}
        />
      ))}
      {lines.major.map((pts, i) => (
        <Line
          key={`ma${i}`}
          points={pts}
          stroke={GRID_MAJOR_COLOR}
          strokeWidth={1}
          strokeScaleEnabled={false}
          perfectDrawEnabled={false}
          listening={false}
        />
      ))}
      {lines.axis.map((pts, i) => (
        <Line
          key={`ax${i}`}
          points={pts}
          stroke={GRID_AXIS_COLOR}
          strokeWidth={1.5}
          strokeScaleEnabled={false}
          perfectDrawEnabled={false}
          listening={false}
        />
      ))}
    </Group>
  );
}

export default GridLayer;
