/**
 * 底图（M2）的文档 action。
 *
 * 底图进 undo 历史（架构决策：M2 允许「撤销上传 / 撤销标定」，代价是历史里会
 * 多躺几份 dataURL 引用——zundo 存的是同一个字符串引用，不复制内容）。
 */
import { roundPt } from '../../model/defaults';
import type { Underlay } from '../../model/types';
import type { DocMutator } from '../docMutator';

export interface UnderlayActions {
  /** 设置 / 更换 / 移除（传 null）底图 */
  setUnderlay: (underlay: Underlay | null) => void;
  /** 局部修改底图；没有底图时什么都不做 */
  updateUnderlay: (patch: Partial<Underlay>) => void;
}

export function createUnderlayActions(mutate: DocMutator): UnderlayActions {
  return {
    setUnderlay(underlay) {
      mutate((doc) => (doc.underlay === underlay ? doc : { ...doc, underlay }));
    },

    updateUnderlay(patch) {
      mutate((doc) => {
        if (!doc.underlay) return doc;
        const next: Underlay = { ...doc.underlay, ...patch };
        if (patch.offset) next.offset = roundPt(patch.offset);
        return { ...doc, underlay: next };
      });
    },
  };
}
