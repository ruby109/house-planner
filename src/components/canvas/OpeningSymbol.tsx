/**
 * 门窗符号（M1b）。
 *
 * **局部坐标系约定**：调用方把本组件放进一个
 * `<Group x={洞口中心.x} y={洞口中心.y} rotation={墙方向角}>` 里，于是
 * - 局部 +x = 墙 start→end 方向；
 * - 局部 +y = 墙的左法线方向（wallNormal），本文件把它当作「室内侧」(in)。
 *
 * 这样四种 swing 只是 hinge 在 ±x、开启侧在 ±y 的组合，不必在世界坐标里算三角。
 * 单元只画符号，不含命中矩形（由调用方按需附加，且 id 必须是 opening.id）。
 */
import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { Line } from 'react-konva';
import { WALL_VISUAL_WIDTH } from '../../model/defaults';
import type { OpeningSwing, OpeningType } from '../../model/types';
import { arcPoints, doorSwingGeometry } from '../../tools/wallGeometry';
import {
  HAIRLINE_PX,
  OPENING_DASH_COLOR,
  SLIDING_PANEL_OFFSET_MM,
  SYMBOL_LINE_PX,
} from '../../tools/m1bStyle';

const HALF_WALL = WALL_VISUAL_WIDTH / 2;

export interface OpeningSymbolProps {
  type: OpeningType;
  width: number;
  swing?: OpeningSwing;
  /** 符号线色 */
  color: string;
  /**
   * 是否在墙上「挖洞」。
   * 画布层（WallsLayer）传 true —— 用 destination-out 把墙擦出缺口；
   * 预览层（OverlayLayer）必须传 false，否则会把预览自己擦掉。
   */
  erase?: boolean;
  /** 预览用的整体透明度 */
  opacity?: number;
}

export function OpeningSymbol({
  type,
  width,
  swing,
  color,
  erase = false,
  opacity = 1,
}: OpeningSymbolProps) {
  const half = width / 2;

  /** 洞口两端的门框短线（贴墙厚方向） */
  const jambs = (
    <Fragment>
      <Line
        points={[-half, -HALF_WALL, -half, HALF_WALL]}
        stroke={color}
        strokeWidth={HAIRLINE_PX}
        strokeScaleEnabled={false}
        opacity={opacity}
        listening={false}
        perfectDrawEnabled={false}
      />
      <Line
        points={[half, -HALF_WALL, half, HALF_WALL]}
        stroke={color}
        strokeWidth={HAIRLINE_PX}
        strokeScaleEnabled={false}
        opacity={opacity}
        listening={false}
        perfectDrawEnabled={false}
      />
    </Fragment>
  );

  /** 把墙擦出缺口（本层画布的 destination-out，不影响下层网格） */
  const cut = erase ? (
    <Line
      points={[-half, 0, half, 0]}
      stroke="#000000"
      strokeWidth={WALL_VISUAL_WIDTH + 2}
      lineCap="butt"
      globalCompositeOperation="destination-out"
      listening={false}
      perfectDrawEnabled={false}
    />
  ) : null;

  let symbol: ReactNode = null;

  if (type === 'door') {
    const g = doorSwingGeometry(width, swing);
    symbol = (
      <Fragment>
        {/* 门板 */}
        <Line
          points={[g.hingeX, 0, g.leafTip.x, g.leafTip.y]}
          stroke={color}
          strokeWidth={SYMBOL_LINE_PX}
          strokeScaleEnabled={false}
          opacity={opacity}
          listening={false}
          perfectDrawEnabled={false}
        />
        {/* 90° 开启弧 */}
        <Line
          points={arcPoints(g.hingeX, 0, width, g.arcFrom, g.arcTo)}
          stroke={color}
          strokeWidth={HAIRLINE_PX}
          strokeScaleEnabled={false}
          opacity={opacity}
          listening={false}
          perfectDrawEnabled={false}
        />
      </Fragment>
    );
  } else if (type === 'sliding_door') {
    const d = SLIDING_PANEL_OFFSET_MM;
    symbol = (
      <Fragment>
        <Line
          points={[-half, d, 0, d]}
          stroke={color}
          strokeWidth={SYMBOL_LINE_PX}
          strokeScaleEnabled={false}
          opacity={opacity}
          listening={false}
          perfectDrawEnabled={false}
        />
        <Line
          points={[0, -d, half, -d]}
          stroke={color}
          strokeWidth={SYMBOL_LINE_PX}
          strokeScaleEnabled={false}
          opacity={opacity}
          listening={false}
          perfectDrawEnabled={false}
        />
      </Fragment>
    );
  } else if (type === 'window') {
    symbol = (
      <Fragment>
        {[-HALF_WALL, 0, HALF_WALL].map((y, i) => (
          <Line
            key={i}
            points={[-half, y, half, y]}
            stroke={color}
            strokeWidth={HAIRLINE_PX}
            strokeScaleEnabled={false}
            opacity={opacity}
            listening={false}
            perfectDrawEnabled={false}
          />
        ))}
      </Fragment>
    );
  } else {
    // 'opening'：垂れ壁なし开口，墙断开 + 浅色虚线示意
    symbol = (
      <Line
        points={[-half, 0, half, 0]}
        stroke={OPENING_DASH_COLOR}
        strokeWidth={HAIRLINE_PX}
        strokeScaleEnabled={false}
        dash={[160, 120]}
        opacity={opacity}
        listening={false}
        perfectDrawEnabled={false}
      />
    );
  }

  return (
    <Fragment>
      {cut}
      {jambs}
      {symbol}
    </Fragment>
  );
}

export default OpeningSymbol;
