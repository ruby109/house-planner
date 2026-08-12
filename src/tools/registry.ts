/**
 * 工具注册表。M1b/M1c 的实现放在各自的工具文件里，本文件不需要再改。
 */
import type { Tool } from '../store/uiStore';
import { useUiStore } from '../store/uiStore';
import type { ToolHandler } from './types';
import { selectTool } from './selectTool';
import { wallTool } from './wallTool';
import { makeOpeningTool } from './openingTool';
import { makeStructureTool } from './structureTool';
import { furnitureTool } from './furnitureTool';
import { underlayCalibrateTool } from './underlayCalibrateTool';

export const toolRegistry: Record<Tool, ToolHandler> = {
  select: selectTool,
  wall: wallTool,
  door: makeOpeningTool('door'),
  sliding_door: makeOpeningTool('sliding_door'),
  window: makeOpeningTool('window'),
  column: makeStructureTool('column'),
  beam: makeStructureTool('beam'),
  furniture_place: furnitureTool,
  underlay_calibrate: underlayCalibrateTool,
};

export function activeToolHandler(): ToolHandler {
  return toolRegistry[useUiStore.getState().activeTool];
}

/** Esc / 切换工具时调用 */
export function cancelTool(tool: Tool): void {
  toolRegistry[tool].onCancel?.();
}
