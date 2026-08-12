/**
 * 画墙工具的橡皮筋预览，渲染在 OverlayLayer 内（返回图形节点，不是 Layer）。
 */
import { Circle, Line, Text } from 'react-konva';
import { WALL_VISUAL_WIDTH } from '../model/defaults';
import { useUiStore } from '../store/uiStore';
import { wallLen, wallNormal } from '../utils/geometry';
import { formatLength } from '../utils/units';
import { useWallDraft } from './wallDraft';
import { readableAngleDeg, wallAngleDeg } from './wallGeometry';
import {
  ANNOTATION_OFFSET_MM,
  FONT_FAMILY,
  HANDLE_FILL,
  HAIRLINE_PX,
  LABEL_BOX_MM,
  LABEL_FONT_MM,
  MIN_LABEL_PX,
  PREVIEW_OK_COLOR,
} from './m1bStyle';

export function WallPreview() {
  const start = useWallDraft((s) => s.start);
  const end = useWallDraft((s) => s.end);
  const scale = useUiStore((s) => s.scale);
  const displayUnit = useUiStore((s) => s.displayUnit);

  if (!start || !end) return null;

  const seg = { start, end };
  const len = wallLen(seg);
  const drawing = len > 0;
  const n = wallNormal(seg);
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const labelOffset = ANNOTATION_OFFSET_MM + LABEL_FONT_MM * 0.9;
  const showLabel = drawing && LABEL_FONT_MM * scale >= MIN_LABEL_PX;

  return (
    <>
      {drawing && (
        <>
          {/* 墙体宽度示意 */}
          <Line
            points={[start.x, start.y, end.x, end.y]}
            stroke={PREVIEW_OK_COLOR}
            strokeWidth={WALL_VISUAL_WIDTH}
            lineCap="square"
            opacity={0.25}
            listening={false}
            perfectDrawEnabled={false}
          />
          {/* 中心线 */}
          <Line
            points={[start.x, start.y, end.x, end.y]}
            stroke={PREVIEW_OK_COLOR}
            strokeWidth={HAIRLINE_PX}
            strokeScaleEnabled={false}
            dash={[180, 120]}
            listening={false}
            perfectDrawEnabled={false}
          />
        </>
      )}

      {/* 起点标记 */}
      <Circle
        x={start.x}
        y={start.y}
        radius={WALL_VISUAL_WIDTH / 2}
        fill={HANDLE_FILL}
        stroke={PREVIEW_OK_COLOR}
        strokeWidth={HAIRLINE_PX * 1.5}
        strokeScaleEnabled={false}
        listening={false}
      />

      {showLabel && (
        <Text
          x={mid.x + n.x * labelOffset}
          y={mid.y + n.y * labelOffset}
          text={formatLength(Math.round(len), displayUnit)}
          fontSize={LABEL_FONT_MM}
          fontFamily={FONT_FAMILY}
          fill={PREVIEW_OK_COLOR}
          align="center"
          width={LABEL_BOX_MM}
          offsetX={LABEL_BOX_MM / 2}
          offsetY={LABEL_FONT_MM / 2}
          rotation={readableAngleDeg(wallAngleDeg(seg))}
          listening={false}
          perfectDrawEnabled={false}
        />
      )}
    </>
  );
}

export default WallPreview;
