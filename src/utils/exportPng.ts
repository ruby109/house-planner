/**
 * PNG 导出（见 docs/ARCHITECTURE.md 第 6 节）。
 *
 * - 取值范围 = 文档内容包围盒 + 300mm 边距（不是当前视口）；
 * - 导出前临时隐藏 Grid / Overlay / 选中手柄（Transformer、墙端点手柄），
 *   并在最底层 Layer 的最底部垫一张白底矩形；导出后原样还原
 *   （刻意不新建 Layer：Stage 层数已经卡在建议上限 5）；
 * - pixelRatio 按「长边至少 2000px」推算，并夹住上限防止画布过大。
 *
 * Konva 的 `toDataURL({x,y,width,height})` 会把整个场景重绘到一张新画布上，
 * 所以视口外的内容也能导出，不需要先把视图移过去。
 */
import { Rect as KonvaRect } from 'konva/lib/shapes/Rect';
import type { Node as KonvaNode } from 'konva/lib/Node';
import type { Stage as KonvaStage } from 'konva/lib/Stage';
import { usePlanStore } from '../store/planStore';
import { useUiStore } from '../store/uiStore';
import { strings } from '../ui/strings';
import { notify } from '../ui/toast';
import { docBounds } from './docBounds';
import { downloadDataUrl, jsonFileName } from './persist';
import { cachedImageSize } from './underlayImage';

/** 内容四周留白 mm */
export const PNG_PADDING_MM = 300;
/** 长边目标像素 */
export const PNG_MIN_LONG_EDGE_PX = 2000;
/** 长边上限像素（避免超大画布把标签页拖垮） */
export const PNG_MAX_LONG_EDGE_PX = 8000;

/** Konva 节点 name：导出时需要隐藏的装饰层 */
export const NAME_GRID = 'grid';
export const NAME_OVERLAY = 'overlay';
/** 仅编辑期可见的手柄（墙端点等） */
export const NAME_HANDLE = 'edit-handle';
/** M2：底图，只有勾了「导出含底图」才保留 */
export const NAME_UNDERLAY = 'underlay-image';

// ---------------------------------------------------------------------------
// Stage 注册（PlanCanvas 挂载时登记，导出时取用）
// ---------------------------------------------------------------------------

let stageRef: KonvaStage | null = null;

export function registerStage(stage: KonvaStage | null): void {
  stageRef = stage;
}

/** 只返回仍挂在文档上的 Stage：被销毁 / 已卸载的一律当成没有 */
export function getStage(): KonvaStage | null {
  const s = stageRef;
  if (!s) return null;
  const content = (s as unknown as { content?: HTMLElement | null }).content;
  return content && content.isConnected ? s : null;
}

// ---------------------------------------------------------------------------
// 纯计算：pixelRatio
// ---------------------------------------------------------------------------

/**
 * 由「导出区域的屏幕像素尺寸」推 pixelRatio，保证长边 ≥ PNG_MIN_LONG_EDGE_PX，
 * 同时不超过 PNG_MAX_LONG_EDGE_PX。
 */
export function pixelRatioFor(widthPx: number, heightPx: number): number {
  const longEdge = Math.max(widthPx, heightPx);
  if (!Number.isFinite(longEdge) || longEdge <= 0) return 1;
  const ratio = Math.max(1, PNG_MIN_LONG_EDGE_PX / longEdge);
  const capped = PNG_MAX_LONG_EDGE_PX / longEdge;
  return Math.min(ratio, Math.max(1, capped));
}

/** `<文档名>-YYYYMMDD.png` */
export function pngFileName(docName: string, at: Date = new Date()): string {
  return jsonFileName(docName, at).replace(/\.json$/, '.png');
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

function hideAll(nodes: KonvaNode[]): KonvaNode[] {
  const hidden: KonvaNode[] = [];
  for (const n of nodes) {
    if (n.isVisible()) {
      n.hide();
      hidden.push(n);
    }
  }
  return hidden;
}

export interface ExportPngOptions {
  /** 是否把底图一起导出；默认取 uiStore.exportWithUnderlay（默认 false） */
  withUnderlay?: boolean;
}

export function exportPng(options: ExportPngOptions = {}): boolean {
  const stage = getStage();
  if (!stage) {
    notify(strings.m1d.exportPngFailed, 'error');
    return false;
  }

  const { doc } = usePlanStore.getState();
  const withUnderlay = options.withUnderlay ?? useUiStore.getState().exportWithUnderlay;
  // 含底图时底图也算进导出范围；不含时保持「干净平面图」的包围盒
  const underlayPx =
    withUnderlay && doc.underlay ? cachedImageSize(doc.underlay.imageDataUrl) : null;
  const b = docBounds(doc, PNG_PADDING_MM, underlayPx);
  if (!b) {
    notify(strings.m1d.exportEmpty, 'error');
    return false;
  }

  const scale = stage.scaleX() || 1;
  const t = stage.getAbsoluteTransform();
  const topLeft = t.point({ x: b.minX, y: b.minY });
  const widthPx = Math.max(1, Math.round((b.maxX - b.minX) * scale));
  const heightPx = Math.max(1, Math.round((b.maxY - b.minY) * scale));

  // 白底：临时塞进最底层 Layer 的最底部（不新建 Layer，避免触发 Konva 的层数告警）。
  // 图形跟随 Stage 变换，所以直接写 mm 坐标。
  const bg = new KonvaRect({
    x: b.minX,
    y: b.minY,
    width: b.maxX - b.minX,
    height: b.maxY - b.minY,
    fill: '#FFFFFF',
    listening: false,
  });
  const bottomLayer = stage.getLayers()[0];
  if (!bottomLayer) {
    notify(strings.m1d.exportPngFailed, 'error');
    return false;
  }
  bottomLayer.add(bg);
  bg.moveToBottom();

  const hidden = hideAll([
    ...stage.find(`.${NAME_GRID}`),
    ...stage.find(`.${NAME_OVERLAY}`),
    ...stage.find(`.${NAME_HANDLE}`),
    ...stage.find('Transformer'),
    ...(withUnderlay ? [] : stage.find(`.${NAME_UNDERLAY}`)),
  ]);

  try {
    const dataUrl = stage.toDataURL({
      x: Math.round(topLeft.x),
      y: Math.round(topLeft.y),
      width: widthPx,
      height: heightPx,
      pixelRatio: pixelRatioFor(widthPx, heightPx),
      mimeType: 'image/png',
    });
    downloadDataUrl(dataUrl, pngFileName(doc.meta.name));
    return true;
  } catch {
    notify(strings.m1d.exportPngFailed, 'error');
    return false;
  } finally {
    for (const n of hidden) n.show();
    bg.destroy();
    stage.batchDraw();
  }
}
