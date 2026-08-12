import { newId, roundPt } from '../../model/defaults';
import type { Pt, Wall } from '../../model/types';
import type { DocMutator } from '../docMutator';

export interface WallsActions {
  /** 新增一段墙（中心线 start→end），返回新墙 id */
  addWall: (start: Pt, end: Pt) => string;
  /** 局部更新墙的端点 */
  updateWall: (id: string, patch: Partial<Omit<Wall, 'id'>>) => void;
  /** 删除墙，并级联删除其上的开口 */
  removeWall: (id: string) => void;
  /** 批量删除墙（同样级联删除开口） */
  removeWalls: (ids: string[]) => void;
}

export function createWallsActions(mutate: DocMutator): WallsActions {
  const removeMany = (ids: string[]) =>
    mutate((doc) => {
      const set = new Set(ids);
      const walls = doc.walls.filter((w) => !set.has(w.id));
      if (walls.length === doc.walls.length) return doc;
      return {
        ...doc,
        walls,
        openings: doc.openings.filter((o) => !set.has(o.wallId)),
      };
    });

  return {
    addWall(start, end) {
      const id = newId('w');
      mutate((doc) => ({
        ...doc,
        walls: [...doc.walls, { id, start: roundPt(start), end: roundPt(end) }],
      }));
      return id;
    },

    updateWall(id, patch) {
      mutate((doc) => {
        const idx = doc.walls.findIndex((w) => w.id === id);
        if (idx < 0) return doc;
        const current = doc.walls[idx];
        const next: Wall = {
          ...current,
          ...(patch.start ? { start: roundPt(patch.start) } : null),
          ...(patch.end ? { end: roundPt(patch.end) } : null),
        };
        const walls = doc.walls.slice();
        walls[idx] = next;
        return { ...doc, walls };
      });
    },

    removeWall(id) {
      removeMany([id]);
    },

    removeWalls(ids) {
      removeMany(ids);
    },
  };
}
