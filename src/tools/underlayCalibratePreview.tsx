/**
 * 底图标定的画布预览（渲染在 OverlayLayer 内部，listening=false）。
 * 第一点：圆点标记；移动：虚线橡皮筋 + 当前长度；第二点：实线 + 两端标记。
 */
import { Circle, Group, Line, Text } from 'react-konva';
import { ACCENT } from '../model/defaults';
import type { Pt } from '../model/types';
import { useUiStore } from '../store/uiStore';
import { formatMm } from '../utils/units';
import { useUnderlayCalibrateDraft } from './underlayCalibrateDraft';

/** 屏幕像素 → mm（Konva 坐标一律 mm，装饰件要保持视觉尺寸恒定就得除以 scale） */
function px(scale: number, v: number): number {
  return scale > 0 ? v / scale : v;
}

function Marker({ p, scale }: { p: Pt; scale: number }) {
  const r = px(scale, 5);
  return (
    <>
      <Circle
        x={p.x}
        y={p.y}
        radius={r}
        fill="#FFFFFF"
        stroke={ACCENT}
        strokeWidth={2}
        strokeScaleEnabled={false}
        listening={false}
      />
      <Circle x={p.x} y={p.y} radius={px(scale, 1.2)} fill={ACCENT} listening={false} />
    </>
  );
}

export function UnderlayCalibratePreview() {
  const a = useUnderlayCalibrateDraft((s) => s.a);
  const b = useUnderlayCalibrateDraft((s) => s.b);
  const hover = useUnderlayCalibrateDraft((s) => s.hover);
  const scale = useUiStore((s) => s.scale);

  if (!a) return null;
  const end = b ?? hover;
  if (!end) return <Marker p={a} scale={scale} />;

  const len = Math.hypot(end.x - a.x, end.y - a.y);
  const fontSize = px(scale, 12);

  return (
    <Group listening={false}>
      <Line
        points={[a.x, a.y, end.x, end.y]}
        stroke={ACCENT}
        strokeWidth={1.5}
        strokeScaleEnabled={false}
        dash={b ? undefined : [6, 4]}
        dashEnabled={!b}
        listening={false}
      />
      <Marker p={a} scale={scale} />
      <Marker p={end} scale={scale} />
      {len > 0 && (
        <Text
          x={(a.x + end.x) / 2 + px(scale, 8)}
          y={(a.y + end.y) / 2 - px(scale, 18)}
          text={formatMm(len)}
          fontSize={fontSize}
          fill={ACCENT}
          listening={false}
        />
      )}
    </Group>
  );
}

export default UnderlayCalibratePreview;
