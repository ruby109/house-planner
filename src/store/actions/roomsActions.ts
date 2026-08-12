import { newId, roundPt } from '../../model/defaults';
import type { Room } from '../../model/types';
import type { DocMutator } from '../docMutator';

export type RoomInput = Omit<Room, 'id'>;

export interface RoomsActions {
  /** 新增房间（polygon 顶点会取整），返回新 id */
  addRoom: (input: RoomInput) => string;
  updateRoom: (id: string, patch: Partial<RoomInput>) => void;
  removeRoom: (id: string) => void;
  removeRooms: (ids: string[]) => void;
}

export function createRoomsActions(mutate: DocMutator): RoomsActions {
  return {
    addRoom(input) {
      const id = newId('r');
      mutate((doc) => ({
        ...doc,
        rooms: [...doc.rooms, { ...input, id, polygon: input.polygon.map(roundPt) }],
      }));
      return id;
    },

    updateRoom(id, patch) {
      mutate((doc) => {
        const idx = doc.rooms.findIndex((r) => r.id === id);
        if (idx < 0) return doc;
        const next: Room = { ...doc.rooms[idx], ...patch };
        if (patch.polygon) next.polygon = patch.polygon.map(roundPt);
        const rooms = doc.rooms.slice();
        rooms[idx] = next;
        return { ...doc, rooms };
      });
    },

    removeRoom(id) {
      mutate((doc) => {
        const rooms = doc.rooms.filter((r) => r.id !== id);
        return rooms.length === doc.rooms.length ? doc : { ...doc, rooms };
      });
    },

    removeRooms(ids) {
      mutate((doc) => {
        const set = new Set(ids);
        const rooms = doc.rooms.filter((r) => !set.has(r.id));
        return rooms.length === doc.rooms.length ? doc : { ...doc, rooms };
      });
    },
  };
}
