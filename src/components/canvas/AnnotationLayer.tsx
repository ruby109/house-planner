/**
 * 标注层 —— M1b：每段墙自动标注长度。（doc.annotations 的渲染留给 M1d）
 *
 * - 尺寸线画在墙外侧（左法线方向）偏移 ANNOTATION_OFFSET_MM ≈ 300mm，
 *   两端带界线（witness line）与刻度，文字居中放在尺寸线外侧；
 * - 字号是 mm（随 Stage 缩放），屏幕上小于 MIN_LABEL_PX(8px) 时整层隐藏；
 * - 长度格式化用 utils/units 的 formatLength（跟随 uiStore.displayUnit）；
 * - 所有图形 listening={false}，不抢墙体的点击；整层 listening 按约定只在 select 工具开。
 *
 * 注意：返回 `<Group>` 而非 `<Layer>`——M1d 把 Stage 层数压到 5 层，
 * 原来加在 Layer 上的 listening 语义原样搬到这个 Group 上。
 */
import { Fragment } from 'react';
import { Group, Line, Text } from 'react-konva';
import { WALL_VISUAL_WIDTH } from '../../model/defaults';
import { usePlanStore } from '../../store/planStore';
import { useUiStore } from '../../store/uiStore';
import { wallLen, wallNormal } from '../../utils/geometry';
import { formatLength } from '../../utils/units';
import { readableAngleDeg, wallAngleDeg } from '../../tools/wallGeometry';
import {
  ANNOTATION_COLOR,
  ANNOTATION_OFFSET_MM,
  FONT_FAMILY,
  HAIRLINE_PX,
  LABEL_BOX_MM,
  LABEL_FONT_MM,
  MIN_LABEL_PX,
  TICK_HALF_MM,
  WITNESS_OVERSHOOT_MM,
} from '../../tools/m1bStyle';

const HALF_WALL = WALL_VISUAL_WIDTH / 2;

export function AnnotationLayer() {
  const walls = usePlanStore((s) => s.doc.walls);
  const displayUnit = useUiStore((s) => s.displayUnit);
  const activeTool = useUiStore((s) => s.activeTool);
  const scale = useUiStore((s) => s.scale);

  const listening = activeTool === 'select';
  // 文字太小就整层不画（既是可读性也是性能）
  if (!(LABEL_FONT_MM * scale >= MIN_LABEL_PX)) return <Group listening={false} />;

  return (
    <Group listening={listening}>
      {walls.map((w) => {
        const len = wallLen(w);
        if (len <= 0) return null;

        const n = wallNormal(w);
        const off = ANNOTATION_OFFSET_MM;
        // 尺寸线端点
        const a = { x: w.start.x + n.x * off, y: w.start.y + n.y * off };
        const b = { x: w.end.x + n.x * off, y: w.end.y + n.y * off };
        // 界线：从墙面拉到尺寸线之外一点
        const witness = (p: { x: number; y: number }) => [
          p.x + n.x * HALF_WALL,
          p.y + n.y * HALF_WALL,
          p.x + n.x * (off + WITNESS_OVERSHOOT_MM),
          p.y + n.y * (off + WITNESS_OVERSHOOT_MM),
        ];
        // 端部刻度（垂直于尺寸线的短线）
        const tick = (p: { x: number; y: number }) => [
          p.x - n.x * TICK_HALF_MM,
          p.y - n.y * TICK_HALF_MM,
          p.x + n.x * TICK_HALF_MM,
          p.y + n.y * TICK_HALF_MM,
        ];

        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const labelGap = LABEL_FONT_MM * 0.85;

        return (
          <Fragment key={w.id}>
            <Line
              points={witness(w.start)}
              stroke={ANNOTATION_COLOR}
              strokeWidth={HAIRLINE_PX}
              strokeScaleEnabled={false}
              listening={false}
              perfectDrawEnabled={false}
            />
            <Line
              points={witness(w.end)}
              stroke={ANNOTATION_COLOR}
              strokeWidth={HAIRLINE_PX}
              strokeScaleEnabled={false}
              listening={false}
              perfectDrawEnabled={false}
            />
            <Line
              points={[a.x, a.y, b.x, b.y]}
              stroke={ANNOTATION_COLOR}
              strokeWidth={HAIRLINE_PX}
              strokeScaleEnabled={false}
              listening={false}
              perfectDrawEnabled={false}
            />
            <Line
              points={tick(a)}
              stroke={ANNOTATION_COLOR}
              strokeWidth={HAIRLINE_PX}
              strokeScaleEnabled={false}
              listening={false}
              perfectDrawEnabled={false}
            />
            <Line
              points={tick(b)}
              stroke={ANNOTATION_COLOR}
              strokeWidth={HAIRLINE_PX}
              strokeScaleEnabled={false}
              listening={false}
              perfectDrawEnabled={false}
            />
            <Text
              x={mid.x + n.x * labelGap}
              y={mid.y + n.y * labelGap}
              text={formatLength(Math.round(len), displayUnit)}
              fontSize={LABEL_FONT_MM}
              fontFamily={FONT_FAMILY}
              fill={ANNOTATION_COLOR}
              align="center"
              width={LABEL_BOX_MM}
              offsetX={LABEL_BOX_MM / 2}
              offsetY={LABEL_FONT_MM / 2}
              rotation={readableAngleDeg(wallAngleDeg(w))}
              listening={false}
              perfectDrawEnabled={false}
            />
          </Fragment>
        );
      })}
    </Group>
  );
}

export default AnnotationLayer;
