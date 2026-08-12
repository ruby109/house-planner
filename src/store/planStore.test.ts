/**
 * planStore 历史暂停 / 恢复（属性面板「实时预览 + 一步撤销」的底座）。
 *
 * 复刻 PropertiesPanel/NumberField 的提交时序：
 *   pause → 多次实时写（画布跟随，不进历史）
 *   → 复位到编辑前（仍在 pause，不留痕）→ resume → 写最终值
 * 于是整段编辑恰好一条历史，undo 一次即回到编辑前。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  canUndo,
  clearHistory,
  pauseHistory,
  planTemporal,
  resumeHistory,
  undo,
  usePlanStore,
} from './planStore';
import { wallDir, wallLen } from '../utils/geometry';

const store = () => usePlanStore.getState();
const pastCount = () => planTemporal.getState().pastStates.length;

const addTable = () =>
  store().addFurniture({
    catalogId: null,
    name: '桌',
    size: { w: 1000, d: 600 },
    position: { x: 0, y: 0 },
    rotation: 0,
  });

const furnitureX = () => store().doc.furniture[0].position.x;

beforeEach(() => {
  store().resetDoc();
  clearHistory();
  resumeHistory(); // 防止上一个用例失败时把历史留在暂停状态
});

describe('pauseHistory / resumeHistory', () => {
  it('暂停期间的多次写入生效但不进历史', () => {
    const id = addTable();
    clearHistory();

    pauseHistory();
    for (const x of [1, 12, 123, 1234]) store().updateFurniture(id, { position: { x, y: 0 } });

    expect(furnitureX()).toBe(1234); // 画布实时跟随
    expect(pastCount()).toBe(0); // 但一条历史都没留
    resumeHistory();
  });

  it('逐字编辑后提交：undo 一次回到编辑前', () => {
    const id = addTable();
    store().updateFurniture(id, { position: { x: 500, y: 0 } });
    clearHistory();
    const before = furnitureX();

    // --- 实时阶段
    pauseHistory();
    for (const x of [1, 12, 123, 1234]) store().updateFurniture(id, { position: { x, y: 0 } });
    // --- 提交：先复位（仍在暂停中）→ resume → 写最终值
    store().updateFurniture(id, { position: { x: before, y: 0 } });
    resumeHistory();
    store().updateFurniture(id, { position: { x: 1234, y: 0 } });

    expect(furnitureX()).toBe(1234);
    expect(pastCount()).toBe(1);

    undo();
    expect(furnitureX()).toBe(before);
    expect(canUndo()).toBe(false); // 只有一步，撤销后历史见底
  });

  it('放弃编辑（Esc）：复位后不留任何历史', () => {
    const id = addTable();
    clearHistory();
    const before = furnitureX();

    pauseHistory();
    store().updateFurniture(id, { position: { x: 777, y: 0 } });
    store().updateFurniture(id, { position: { x: before, y: 0 } });
    resumeHistory();

    expect(furnitureX()).toBe(before);
    expect(pastCount()).toBe(0);
    expect(canUndo()).toBe(false);
  });

  it('resume 之后历史恢复正常记录', () => {
    const id = addTable();
    clearHistory();

    pauseHistory();
    store().updateFurniture(id, { position: { x: 10, y: 0 } });
    resumeHistory();
    store().updateFurniture(id, { position: { x: 20, y: 0 } });
    store().updateFurniture(id, { position: { x: 30, y: 0 } });

    expect(pastCount()).toBe(2);
  });
});

describe('墙长度编辑：起点不动、终点沿原方向', () => {
  /** 与 PropertiesPanel.WallProps.setLength 同一套算法 */
  const setLength = (id: string, base: { start: { x: number; y: number }; end: { x: number; y: number } }, len: number) => {
    const d = wallDir(base);
    store().updateWall(id, { end: { x: base.start.x + d.x * len, y: base.start.y + d.y * len } });
  };

  it('改长度只影响终点，且 undo 一步回原长', () => {
    const id = store().addWall({ x: 0, y: 0 }, { x: 1000, y: 0 });
    clearHistory();
    const base = { start: { x: 0, y: 0 }, end: { x: 1000, y: 0 } };

    // 逐字输入 3640
    pauseHistory();
    for (const len of [3, 36, 364, 3640]) setLength(id, base, len);
    expect(wallLen(store().doc.walls[0])).toBeCloseTo(3640, 6);
    expect(pastCount()).toBe(0);

    // 提交
    store().updateWall(id, base);
    resumeHistory();
    setLength(id, base, 3640);

    const w = store().doc.walls[0];
    expect(w.start).toEqual({ x: 0, y: 0 }); // 起点不动
    expect(w.end).toEqual({ x: 3640, y: 0 });
    expect(pastCount()).toBe(1);

    undo();
    expect(wallLen(store().doc.walls[0])).toBe(1000);
  });

  it('斜墙改长度保持方向', () => {
    const id = store().addWall({ x: 100, y: 100 }, { x: 400, y: 500 }); // 长 500
    const base = { start: { x: 100, y: 100 }, end: { x: 400, y: 500 } };
    clearHistory();

    setLength(id, base, 1000);
    const w = store().doc.walls[0];
    expect(wallLen(w)).toBeCloseTo(1000, 6);
    expect(w.end).toEqual({ x: 700, y: 900 }); // 方向 (0.6, 0.8)
  });
});
