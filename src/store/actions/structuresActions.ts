import { BEAM_DEFAULT_SIZE, COLUMN_DEFAULT_SIZE, newId, roundPt } from '../../model/defaults';
import type { Pt, Structure } from '../../model/types';
import type { DocMutator } from '../docMutator';

export type StructureInput = Omit<Structure, 'id'>;

export interface StructuresActions {
  addStructure: (input: StructureInput) => string;
  /** 便捷：按默认尺寸放一根柱（105×105） */
  addColumn: (position: Pt, rotation?: number) => string;
  /** 便捷：按默认尺寸放一根梁（910×300） */
  addBeam: (position: Pt, rotation?: number) => string;
  updateStructure: (id: string, patch: Partial<StructureInput>) => void;
  moveStructure: (id: string, position: Pt) => void;
  removeStructure: (id: string) => void;
  removeStructures: (ids: string[]) => void;
}

export function createStructuresActions(mutate: DocMutator): StructuresActions {
  const add = (input: StructureInput): string => {
    const id = newId('s');
    mutate((doc) => ({
      ...doc,
      structures: [
        ...doc.structures,
        {
          ...input,
          id,
          position: roundPt(input.position),
          width: Math.max(1, Math.round(input.width)),
          depth: Math.max(1, Math.round(input.depth)),
        },
      ],
    }));
    return id;
  };

  const patch = (id: string, p: Partial<StructureInput>) =>
    mutate((doc) => {
      const idx = doc.structures.findIndex((s) => s.id === id);
      if (idx < 0) return doc;
      const next: Structure = { ...doc.structures[idx], ...p };
      if (p.position) next.position = roundPt(p.position);
      if (p.width !== undefined) next.width = Math.max(1, Math.round(p.width));
      if (p.depth !== undefined) next.depth = Math.max(1, Math.round(p.depth));
      const structures = doc.structures.slice();
      structures[idx] = next;
      return { ...doc, structures };
    });

  return {
    addStructure: add,

    addColumn(position, rotation = 0) {
      return add({
        kind: 'column',
        position,
        width: COLUMN_DEFAULT_SIZE.width,
        depth: COLUMN_DEFAULT_SIZE.depth,
        rotation,
      });
    },

    addBeam(position, rotation = 0) {
      return add({
        kind: 'beam',
        position,
        width: BEAM_DEFAULT_SIZE.width,
        depth: BEAM_DEFAULT_SIZE.depth,
        rotation,
      });
    },

    updateStructure(id, p) {
      patch(id, p);
    },

    moveStructure(id, position) {
      patch(id, { position });
    },

    removeStructure(id) {
      mutate((doc) => {
        const structures = doc.structures.filter((s) => s.id !== id);
        return structures.length === doc.structures.length ? doc : { ...doc, structures };
      });
    },

    removeStructures(ids) {
      mutate((doc) => {
        const set = new Set(ids);
        const structures = doc.structures.filter((s) => !set.has(s.id));
        return structures.length === doc.structures.length ? doc : { ...doc, structures };
      });
    },
  };
}
