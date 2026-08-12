/**
 * 底图层 —— M2 实现（上传間取り图描摹）。
 *
 * doc.underlay 按 mmPerPixel / offset / rotation / opacity 渲染成一张 Konva.Image：
 * - `x/y = offset`、`scaleX/scaleY = mmPerPixel`、`rotation`
 *   （坐标约定见 utils/underlayImage.ts 顶部注释；Konva 节点坐标仍然是 mm）；
 * - locked（默认）→ `listening=false`，完全不挡画墙 / 选择等任何画布操作；
 * - 解锁且处于 select 工具 → 可点选（id='underlay'）、可拖动；
 * - 图片元素用 window.Image 异步加载并缓存，未加载完成时不渲染任何东西。
 *
 * 注意：返回 `<Group>` 而非 `<Layer>`——M1d 把 Stage 层数压到 5 层，
 * 本组件与 GridLayer 合用 PlanCanvas 的「背景 Layer」（渲染顺序不变：grid 在下）。
 */
import { useEffect, useState } from 'react';
import { Group, Image as KonvaImage } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { UNDERLAY_ID, roundPt } from '../../model/defaults';
import { usePlanStore } from '../../store/planStore';
import { useUiStore } from '../../store/uiStore';
import { NAME_UNDERLAY } from '../../utils/exportPng';
import { cachedImage, loadImageElement } from '../../utils/underlayImage';

/** 加载（并缓存）底图的 HTMLImageElement；加载完成前返回 null */
function useUnderlayImage(dataUrl: string | null): HTMLImageElement | null {
  const [image, setImage] = useState<HTMLImageElement | null>(() => cachedImage(dataUrl));

  useEffect(() => {
    if (!dataUrl) {
      setImage(null);
      return;
    }
    const hit = cachedImage(dataUrl);
    if (hit) {
      setImage(hit);
      return;
    }
    let alive = true;
    setImage(null);
    loadImageElement(dataUrl)
      .then((el) => {
        if (alive) setImage(el);
      })
      .catch(() => {
        if (alive) setImage(null);
      });
    return () => {
      alive = false;
    };
  }, [dataUrl]);

  return image;
}

export function UnderlayLayer() {
  const underlay = usePlanStore((s) => s.doc.underlay);
  const updateUnderlay = usePlanStore((s) => s.updateUnderlay);
  const activeTool = useUiStore((s) => s.activeTool);
  const opacityPreview = useUiStore((s) => s.underlayOpacityPreview);
  const image = useUnderlayImage(underlay?.imageDataUrl ?? null);

  if (!underlay || !image) return <Group />;

  // 只有「解锁 + 选择工具」时才吃事件：锁定时 listening=false 完全不挡描图
  const interactive = !underlay.locked && activeTool === 'select';

  const handleDragEnd = (e: KonvaEventObject<DragEvent>) => {
    const node = e.target;
    // 底图不吸附网格：描摹时需要能微调到任意位置
    const offset = roundPt({ x: node.x(), y: node.y() });
    node.position(offset);
    updateUnderlay({ offset });
  };

  return (
    <Group name={NAME_UNDERLAY}>
      <KonvaImage
        id={UNDERLAY_ID}
        image={image}
        x={underlay.offset.x}
        y={underlay.offset.y}
        scaleX={underlay.mmPerPixel}
        scaleY={underlay.mmPerPixel}
        rotation={underlay.rotation}
        opacity={opacityPreview ?? underlay.opacity}
        listening={interactive}
        draggable={interactive}
        onDragEnd={handleDragEnd}
        perfectDrawEnabled={false}
      />
    </Group>
  );
}

export default UnderlayLayer;
