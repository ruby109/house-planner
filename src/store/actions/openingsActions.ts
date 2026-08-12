import { newId } from '../../model/defaults';
import type { Opening } from '../../model/types';
import type { DocMutator } from '../docMutator';

export type OpeningInput = Omit<Opening, 'id'>;

export interface OpeningsActions {
  /** 在某面墙上新增开口，返回新 id */
  addOpening: (input: OpeningInput) => string;
  /** 局部更新开口（类型 / 宽度 / 开启方向等） */
  updateOpening: (id: string, patch: Partial<OpeningInput>) => void;
  /** 沿墙滑动：只改 offset */
  moveOpening: (id: string, offset: number) => void;
  removeOpening: (id: string) => void;
  removeOpenings: (ids: string[]) => void;
}

export function createOpeningsActions(mutate: DocMutator): OpeningsActions {
  const patchOpening = (id: string, patch: Partial<OpeningInput>) =>
    mutate((doc) => {
      const idx = doc.openings.findIndex((o) => o.id === id);
      if (idx < 0) return doc;
      const next: Opening = { ...doc.openings[idx], ...patch };
      if (patch.offset !== undefined) next.offset = Math.round(patch.offset);
      if (patch.width !== undefined) next.width = Math.max(1, Math.round(patch.width));
      const openings = doc.openings.slice();
      openings[idx] = next;
      return { ...doc, openings };
    });

  return {
    addOpening(input) {
      const id = newId('o');
      mutate((doc) => ({
        ...doc,
        openings: [
          ...doc.openings,
          {
            ...input,
            id,
            offset: Math.round(input.offset),
            width: Math.max(1, Math.round(input.width)),
          },
        ],
      }));
      return id;
    },

    updateOpening(id, patch) {
      patchOpening(id, patch);
    },

    moveOpening(id, offset) {
      patchOpening(id, { offset });
    },

    removeOpening(id) {
      mutate((doc) => {
        const openings = doc.openings.filter((o) => o.id !== id);
        return openings.length === doc.openings.length ? doc : { ...doc, openings };
      });
    },

    removeOpenings(ids) {
      mutate((doc) => {
        const set = new Set(ids);
        const openings = doc.openings.filter((o) => !set.has(o.id));
        return openings.length === doc.openings.length ? doc : { ...doc, openings };
      });
    },
  };
}
