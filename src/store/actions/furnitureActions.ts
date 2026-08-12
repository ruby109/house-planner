import { DEFAULT_FURNITURE_COLOR, newId, roundPt } from '../../model/defaults';
import type { Furniture, Pt } from '../../model/types';
import type { DocMutator } from '../docMutator';

export type FurnitureInput = Omit<Furniture, 'id' | 'color' | 'locked'> &
  Partial<Pick<Furniture, 'color' | 'locked'>>;

export interface FurnitureActions {
  addFurniture: (input: FurnitureInput) => string;
  updateFurniture: (id: string, patch: Partial<Omit<Furniture, 'id'>>) => void;
  /** 拖拽结束时调用（拖拽中间态不进历史） */
  moveFurniture: (id: string, position: Pt) => void;
  /** 变形结束时调用 */
  transformFurniture: (id: string, position: Pt, size: { w: number; d: number }, rotation: number) => void;
  rotateFurniture: (id: string, rotation: number) => void;
  /** 90° 步进旋转 */
  rotateFurnitureBy90: (id: string, steps?: number) => void;
  setFurnitureLocked: (id: string, locked: boolean) => void;
  removeFurniture: (id: string) => void;
  removeFurnitures: (ids: string[]) => void;
}

const normRotation = (deg: number): number => ((deg % 360) + 360) % 360;

export function createFurnitureActions(mutate: DocMutator): FurnitureActions {
  const patch = (id: string, p: Partial<Omit<Furniture, 'id'>>) =>
    mutate((doc) => {
      const idx = doc.furniture.findIndex((f) => f.id === id);
      if (idx < 0) return doc;
      const next: Furniture = { ...doc.furniture[idx], ...p };
      if (p.position) next.position = roundPt(p.position);
      if (p.size) {
        next.size = {
          w: Math.max(1, Math.round(p.size.w)),
          d: Math.max(1, Math.round(p.size.d)),
        };
      }
      if (p.rotation !== undefined) next.rotation = normRotation(p.rotation);
      const furniture = doc.furniture.slice();
      furniture[idx] = next;
      return { ...doc, furniture };
    });

  return {
    addFurniture(input) {
      const id = newId('f');
      mutate((doc) => ({
        ...doc,
        furniture: [
          ...doc.furniture,
          {
            catalogId: input.catalogId,
            name: input.name,
            size: {
              w: Math.max(1, Math.round(input.size.w)),
              d: Math.max(1, Math.round(input.size.d)),
            },
            position: roundPt(input.position),
            rotation: normRotation(input.rotation),
            color: input.color ?? DEFAULT_FURNITURE_COLOR,
            locked: input.locked ?? false,
            id,
          },
        ],
      }));
      return id;
    },

    updateFurniture(id, p) {
      patch(id, p);
    },

    moveFurniture(id, position) {
      patch(id, { position });
    },

    transformFurniture(id, position, size, rotation) {
      patch(id, { position, size, rotation });
    },

    rotateFurniture(id, rotation) {
      patch(id, { rotation });
    },

    rotateFurnitureBy90(id, steps = 1) {
      mutate((doc) => {
        const idx = doc.furniture.findIndex((f) => f.id === id);
        if (idx < 0) return doc;
        const current = doc.furniture[idx];
        const furniture = doc.furniture.slice();
        furniture[idx] = { ...current, rotation: normRotation(current.rotation + 90 * steps) };
        return { ...doc, furniture };
      });
    },

    setFurnitureLocked(id, locked) {
      patch(id, { locked });
    },

    removeFurniture(id) {
      mutate((doc) => {
        const furniture = doc.furniture.filter((f) => f.id !== id);
        return furniture.length === doc.furniture.length ? doc : { ...doc, furniture };
      });
    },

    removeFurnitures(ids) {
      mutate((doc) => {
        const set = new Set(ids);
        const furniture = doc.furniture.filter((f) => !set.has(f.id));
        return furniture.length === doc.furniture.length ? doc : { ...doc, furniture };
      });
    },
  };
}
