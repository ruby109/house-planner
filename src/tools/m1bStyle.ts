/**
 * M1b（墙与开口）的视觉常量与就近文案。
 *
 * 只被 wallTool / openingTool 的预览与 WallsLayer / AnnotationLayer 使用。
 * 通用配色在 model/defaults.ts；这里只放 M1b 专属的、不值得进全局的量。
 */
import { ACCENT, WALL_VISUAL_WIDTH } from '../model/defaults';

// ---------------------------------------------------------------------------
// 颜色
// ---------------------------------------------------------------------------

/** 墙体填充色 */
export const WALL_COLOR = '#37414F';
/** 选中态高亮（强调色） */
export const SELECTED_COLOR = ACCENT;
/** 门窗符号线色 */
export const SYMBOL_COLOR = '#4B5563';
/** 无门开口的示意虚线（浅色） */
export const OPENING_DASH_COLOR = '#AEB7C2';
/** 绘制预览：可提交 */
export const PREVIEW_OK_COLOR = ACCENT;
/** 绘制预览：不可提交（置灰） */
export const PREVIEW_OFF_COLOR = '#A3ACB8';
/** 尺寸标注线色 */
export const ANNOTATION_COLOR = '#93A0AE';
/** 端点手柄 */
export const HANDLE_FILL = '#FFFFFF';
export const HANDLE_STROKE = ACCENT;

// ---------------------------------------------------------------------------
// 尺寸（mm，除非注明 px）
// ---------------------------------------------------------------------------

/** 标注 / 长度标签字号，单位 mm（随 Stage 缩放） */
export const LABEL_FONT_MM = 260;
/** 标签在屏幕上小于该像素高度时隐藏 */
export const MIN_LABEL_PX = 8;
/** 尺寸线相对墙中心线的法向偏移 */
export const ANNOTATION_OFFSET_MM = 300;
/** 尺寸线端部界线（witness line）超出尺寸线的长度 */
export const WITNESS_OVERSHOOT_MM = 90;
/** 尺寸线端部刻度的半长 */
export const TICK_HALF_MM = 70;
/** 文字排版用的名义宽度（配合 align=center + offsetX 居中） */
export const LABEL_BOX_MM = 4000;
/** 墙端点手柄半径 */
export const HANDLE_RADIUS_MM = 110;
/** 墙的点击命中宽度（比视觉宽度大一些，便于选中） */
export const WALL_HIT_WIDTH_MM = Math.max(WALL_VISUAL_WIDTH, 280);
/** 开口的点击命中区域厚度 */
export const OPENING_HIT_DEPTH_MM = 280;
/** 引き戸两片门板相对墙中心线的错位量 */
export const SLIDING_PANEL_OFFSET_MM = WALL_VISUAL_WIDTH / 4;

/** 细线（px，恒定屏幕宽度，`strokeScaleEnabled={false}`） */
export const HAIRLINE_PX = 1;
/** 符号主线（px） */
export const SYMBOL_LINE_PX = 2;

export const FONT_FAMILY = 'system-ui, sans-serif';

// ---------------------------------------------------------------------------
// 就近文案（M1b 只有一处画布内文字提示，不占用全局 strings）
// ---------------------------------------------------------------------------

export const m1bText = {
  /** 门窗贴不上墙时的预览提示 */
  noWall: '靠近墙体放置',
} as const;
