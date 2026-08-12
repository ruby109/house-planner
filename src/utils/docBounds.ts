/**
 * 文档内容的包围盒（mm）。
 * 「适应视图」与「PNG 导出」共用同一套内容点收集逻辑，避免两处口径不一致。
 *
 * M2：底图不是「内容」，所以默认不算进包围盒；调用方按需把底图的像素尺寸传进来
 * （尺寸来自 utils/underlayImage 的图片缓存，只有加载完成后才拿得到）：
 * - 适应视图：传（否则只有底图时 fit 不到东西）；
 * - PNG 导出：只有勾了「导出含底图」才传。
 */
import type { PlanDoc, Pt } from '../model/types';
import { boundsOf, rotatedRectCorners, type Bounds } from './geometry';
import { underlayCornersMm, type PixelSize } from './underlayImage';

/** 收集文档内所有内容点（墙端点、房间顶点、结构/家具的旋转后四角，可选底图四角） */
export function docContentPoints(doc: PlanDoc, underlayPx?: PixelSize | null): Pt[] {
  const pts: Pt[] = [];
  for (const w of doc.walls) pts.push(w.start, w.end);
  for (const r of doc.rooms) pts.push(...r.polygon);
  for (const s of doc.structures) {
    pts.push(...rotatedRectCorners(s.position, s.width, s.depth, s.rotation));
  }
  for (const f of doc.furniture) {
    pts.push(...rotatedRectCorners(f.position, f.size.w, f.size.d, f.rotation));
  }
  if (doc.underlay && underlayPx) {
    pts.push(...underlayCornersMm(doc.underlay, underlayPx));
  }
  return pts;
}

/** 内容包围盒 + 四周留白 mm；文档为空返回 null */
export function docBounds(
  doc: PlanDoc,
  paddingMm = 0,
  underlayPx?: PixelSize | null,
): Bounds | null {
  const b = boundsOf(docContentPoints(doc, underlayPx));
  if (!b) return null;
  return {
    minX: b.minX - paddingMm,
    minY: b.minY - paddingMm,
    maxX: b.maxX + paddingMm,
    maxY: b.maxY + paddingMm,
  };
}
