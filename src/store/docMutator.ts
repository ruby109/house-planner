import type { PlanDoc } from '../model/types';

/**
 * 领域 action 文件与 planStore 之间的唯一契约。
 *
 * `recipe` 必须是**纯函数**：接收当前 doc，返回新 doc（不可原地修改）。
 * 返回同一引用表示「无变化」，planStore 会跳过 set，从而不产生历史记录。
 * `updatedAt` 由 planStore 统一维护，recipe 不必关心。
 */
export type DocMutator = (recipe: (doc: PlanDoc) => PlanDoc) => void;
