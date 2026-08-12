/**
 * 覆盖层：渲染当前激活工具的绘制预览（橡皮筋、吸附指示、碰撞高亮等）。
 * 内容由工具模块的 Preview 组件提供，本文件不需要再改。
 *
 * 这是 Stage 上最后一层，保持 `listening={false}`；`name` 供 PNG 导出时临时隐藏。
 */
import { Layer } from 'react-konva';
import { useUiStore } from '../../store/uiStore';
import { toolRegistry } from '../../tools/registry';
import { NAME_OVERLAY } from '../../utils/exportPng';

export function OverlayLayer() {
  const activeTool = useUiStore((s) => s.activeTool);
  const Preview = toolRegistry[activeTool].Preview;
  return (
    <Layer name={NAME_OVERLAY} listening={false}>
      {Preview ? <Preview /> : null}
    </Layer>
  );
}

export default OverlayLayer;
