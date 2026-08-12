/**
 * 持久化与 JSON 导入导出（见 docs/ARCHITECTURE.md 第 6 节）。
 *
 * - 自动保存：planStore.subscribe → debounce 800ms → localStorage['house-planner:doc']；
 * - 启动恢复：zod safeParse，失败则丢弃（并清掉坏存档），成功后 **clearHistory**，
 *   否则第一次 Ctrl+Z 会把用户撤销回空文档；
 * - JSON 导出：下载 `<文档名>-YYYYMMDD.json`；
 * - JSON 导入：先 zod 校验，失败只提示、绝不覆盖当前文档；成功后 clearHistory + requestFit。
 *
 * 保存状态给 StatusBar 用，放在独立的小 store 里（不进 undo 历史）。
 */
import { create } from 'zustand';
import { PlanDocSchema } from '../model/schema';
import type { PlanDoc } from '../model/types';
import { clearHistory, usePlanStore } from '../store/planStore';
import { useUiStore } from '../store/uiStore';
import { strings } from '../ui/strings';
import { notify } from '../ui/toast';

export const STORAGE_KEY = 'house-planner:doc';
export const AUTOSAVE_DEBOUNCE_MS = 800;

// ---------------------------------------------------------------------------
// 保存状态
// ---------------------------------------------------------------------------

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface SaveState {
  status: SaveStatus;
  /** 最近一次保存成功的时刻（epoch ms） */
  savedAt: number | null;
  set: (status: SaveStatus, savedAt?: number | null) => void;
}

export const useSaveStatus = create<SaveState>()((set) => ({
  status: 'idle',
  savedAt: null,
  set: (status, savedAt) =>
    set((s) => ({ status, savedAt: savedAt === undefined ? s.savedAt : savedAt })),
}));

/** 「已保存 HH:MM」里的 HH:MM */
export function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// localStorage 读写
// ---------------------------------------------------------------------------

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 解析任意来源的文本为 PlanDoc；不合法返回 null */
export function parsePlanDoc(text: string): PlanDoc | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const result = PlanDocSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * 是否是 localStorage 配额写满的错误（M2：底图 dataURL 可能把配额撑爆）。
 * 各浏览器的报法不一样：Chrome/Safari 用 DOMException 名 + code 22，
 * Firefox 用 NS_ERROR_DOM_QUOTA_REACHED / code 1014。
 */
export function isQuotaExceededError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown };
  return (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    e.code === 22 ||
    e.code === 1014
  );
}

/** 配额提示只在「连续失败」的第一次弹，避免每 800ms 刷一条 */
let quotaNotified = false;

function writeNow(doc: PlanDoc): void {
  const ls = safeLocalStorage();
  if (!ls) {
    useSaveStatus.getState().set('error');
    return;
  }
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(doc));
    useSaveStatus.getState().set('saved', Date.now());
    quotaNotified = false;
  } catch (err) {
    // 配额满 / 隐私模式：状态栏标红，并且**明确告知**而不是静默丢文档
    useSaveStatus.getState().set('error');
    if (isQuotaExceededError(err) && !quotaNotified) {
      quotaNotified = true;
      notify(strings.m2.quotaExceeded, 'error');
    }
  }
}

/**
 * 启动恢复。返回是否成功恢复了一份存档。
 * 必须在 React 渲染前调用，这样画布首次 fit 就能框住恢复出来的内容。
 */
export function restoreDoc(): boolean {
  const ls = safeLocalStorage();
  if (!ls) return false;
  const text = ls.getItem(STORAGE_KEY);
  if (!text) return false;

  const doc = parsePlanDoc(text);
  if (!doc) {
    ls.removeItem(STORAGE_KEY);
    notify(strings.m1d.restoreInvalid, 'error');
    return false;
  }

  usePlanStore.getState().replaceDoc(doc);
  // 恢复不是一次「编辑」，不能留在历史里
  clearHistory();
  useSaveStatus.getState().set('saved', Date.now());
  return true;
}

/** 清掉本地存档（供「新建」之类的场景使用） */
export function clearSavedDoc(): void {
  safeLocalStorage()?.removeItem(STORAGE_KEY);
  useSaveStatus.getState().set('idle', null);
}

// ---------------------------------------------------------------------------
// 自动保存
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: PlanDoc | null = null;

/** 立刻落盘尚未写入的改动 */
export function flushAutosave(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending) {
    const doc = pending;
    pending = null;
    writeNow(doc);
  }
}

/**
 * 订阅 planStore 的 doc 变化，debounce 800ms 写入 localStorage。
 * 返回取消订阅函数（应用生命周期内一般不需要调用）。
 */
export function startAutosave(): () => void {
  const schedule = (doc: PlanDoc) => {
    pending = doc;
    useSaveStatus.getState().set('saving');
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const next = pending;
      pending = null;
      if (next) writeNow(next);
    }, AUTOSAVE_DEBOUNCE_MS);
  };

  const unsubscribe = usePlanStore.subscribe((state, prev) => {
    if (state.doc === prev.doc) return;
    schedule(state.doc);
  });

  const onBeforeUnload = () => flushAutosave();
  if (typeof window !== 'undefined') window.addEventListener('beforeunload', onBeforeUnload);

  return () => {
    unsubscribe();
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', onBeforeUnload);
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

// ---------------------------------------------------------------------------
// JSON 导入 / 导出
// ---------------------------------------------------------------------------

/** 文件名里不允许出现的字符 */
const UNSAFE_FILENAME = /[\\/:*?"<>|\s]+/g;

/** `<文档名>-YYYYMMDD.json` */
export function jsonFileName(docName: string, at: Date = new Date()): string {
  const safe = docName.trim().replace(UNSAFE_FILENAME, '_').slice(0, 40) || 'house-plan';
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${safe}-${y}${m}${d}.json`;
}

/** 触发浏览器下载 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 在部分浏览器会打断下载，延后一点
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 导出当前文档为 .json 下载 */
export function exportJson(): void {
  const { doc } = usePlanStore.getState();
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  downloadBlob(blob, jsonFileName(doc.meta.name));
}

/**
 * 导入 JSON 文件。校验不通过时提示并保持当前文档不变。
 * 成功后清空历史（不允许撤销回导入前的文档）并请求适应视图。
 */
export async function importJsonFile(file: File): Promise<boolean> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    notify(strings.m1d.importFailed, 'error');
    return false;
  }

  const doc = parsePlanDoc(text);
  if (!doc) {
    notify(strings.m1d.importInvalid, 'error');
    return false;
  }

  usePlanStore.getState().replaceDoc(doc);
  clearHistory();
  const ui = useUiStore.getState();
  ui.clearSelection();
  ui.requestFit();
  notify(strings.m1d.importDone);
  return true;
}
