/**
 * 门窗放置预览（渲染在 OverlayLayer 内）。
 *
 * 三种状态：
 * - 命中墙且合法 → 在墙上的投影位置画正常色符号；
 * - 命中墙但非法（墙太短 / 与已有开口重叠）→ 同位置置灰；
 * - 未命中墙 → 跟随指针置灰。
 */
import type { ComponentType } from 'react';
import { Group, Line, Text } from 'react-konva';
import { WALL_VISUAL_WIDTH } from '../model/defaults';
import type { OpeningType } from '../model/types';
import { useUiStore } from '../store/uiStore';
import { OpeningSymbol } from '../components/canvas/OpeningSymbol';
import type { OpeningDraftStore } from './openingDraft';
import { pointAlongWall, wallAngleDeg } from './wallGeometry';
import {
  FONT_FAMILY,
  HAIRLINE_PX,
  LABEL_BOX_MM,
  LABEL_FONT_MM,
  MIN_LABEL_PX,
  PREVIEW_OFF_COLOR,
  PREVIEW_OK_COLOR,
  m1bText,
} from './m1bStyle';

/** 工厂：把某个类型的 draft store 绑成无 props 的 Preview 组件（ToolHandler.Preview 的签名） */
export function makeOpeningPreview(
  useDraft: OpeningDraftStore,
  type: OpeningType,
): ComponentType {
  function OpeningPreview() {
    const candidate = useDraft((s) => s.candidate);
    const pointer = useDraft((s) => s.pointer);
    const scale = useUiStore((s) => s.scale);

    if (candidate) {
      const color = candidate.valid ? PREVIEW_OK_COLOR : PREVIEW_OFF_COLOR;
      const center = pointAlongWall(candidate, candidate.offset);
      return (
        <Group
          x={center.x}
          y={center.y}
          rotation={wallAngleDeg({ start: candidate.start, end: candidate.end })}
          listening={false}
        >
          {/* 洞口范围底色 */}
          <Line
            points={[-candidate.width / 2, 0, candidate.width / 2, 0]}
            stroke={color}
            strokeWidth={WALL_VISUAL_WIDTH}
            lineCap="butt"
            opacity={0.22}
            listening={false}
            perfectDrawEnabled={false}
          />
          <OpeningSymbol
            type={type}
            width={candidate.width}
            swing="in_left"
            color={color}
            erase={false}
          />
        </Group>
      );
    }

    if (!pointer) return null;

    const showHint = LABEL_FONT_MM * scale >= MIN_LABEL_PX;
    return (
      <Group x={pointer.x} y={pointer.y} listening={false}>
        <Line
          points={[-455, 0, 455, 0]}
          stroke={PREVIEW_OFF_COLOR}
          strokeWidth={WALL_VISUAL_WIDTH}
          lineCap="butt"
          opacity={0.18}
          listening={false}
          perfectDrawEnabled={false}
        />
        <Line
          points={[-455, 0, 455, 0]}
          stroke={PREVIEW_OFF_COLOR}
          strokeWidth={HAIRLINE_PX}
          strokeScaleEnabled={false}
          dash={[120, 100]}
          listening={false}
          perfectDrawEnabled={false}
        />
        {showHint && (
          <Text
            x={0}
            y={-WALL_VISUAL_WIDTH - LABEL_FONT_MM}
            text={m1bText.noWall}
            fontSize={LABEL_FONT_MM}
            fontFamily={FONT_FAMILY}
            fill={PREVIEW_OFF_COLOR}
            align="center"
            width={LABEL_BOX_MM}
            offsetX={LABEL_BOX_MM / 2}
            listening={false}
            perfectDrawEnabled={false}
          />
        )}
      </Group>
    );
  }

  OpeningPreview.displayName = `OpeningPreview(${type})`;
  return OpeningPreview;
}
