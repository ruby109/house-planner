/**
 * 底图上传流程（M2）：选文件 / 拖放 → 压缩 → 写入 doc.underlay → 适应视图。
 *
 * 与 `underlayImage.ts` 的分工：那边是「纯数学 + 浏览器图片 API」，不认识 store；
 * 这里负责串起 store / 提示，供 Toolbar、画布拖放、底图面板共用。
 */
import { usePlanStore } from '../store/planStore';
import { useUiStore } from '../store/uiStore';
import { strings } from '../ui/strings';
import { notify } from '../ui/toast';
import { compressImageFile, createUnderlay, loadImageElement } from './underlayImage';

/** `<input type="file">` 的 accept */
export const UNDERLAY_ACCEPT = 'image/*';

export function isImageFile(file: File | null | undefined): boolean {
  if (!file) return false;
  if (file.type) return file.type.startsWith('image/');
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
}

/** 从 DataTransfer 里取第一个图片文件 */
export function pickImageFile(dt: DataTransfer | null): File | null {
  if (!dt?.files) return null;
  for (const f of Array.from(dt.files)) {
    if (isImageFile(f)) return f;
  }
  return null;
}

/**
 * 读一张图片作为底图（已有底图时视为「更换图片」，沿用原透明度 / 锁定状态）。
 * 上传成功后默认让图片宽度 ≈9100mm、居中、opacity 0.5、locked。
 */
export async function loadUnderlayFromFile(file: File): Promise<boolean> {
  if (!isImageFile(file)) {
    notify(strings.m2.notImage, 'error');
    return false;
  }

  try {
    const compressed = await compressImageFile(file);
    // 预热图片元素缓存：适应视图 / 渲染都要同步拿到像素尺寸
    await loadImageElement(compressed.dataUrl);

    const prev = usePlanStore.getState().doc.underlay;
    usePlanStore
      .getState()
      .setUnderlay(
        createUnderlay(
          compressed.dataUrl,
          { width: compressed.width, height: compressed.height },
          prev ? { opacity: prev.opacity, locked: prev.locked } : null,
        ),
      );

    const ui = useUiStore.getState();
    ui.clearSelection();
    ui.requestFit();

    notify(compressed.withinBudget ? strings.m2.uploadDone : strings.m2.oversize,
      compressed.withinBudget ? 'info' : 'error');
    return true;
  } catch {
    notify(strings.m2.uploadFailed, 'error');
    return false;
  }
}

/**
 * 直接用一张**已经压缩好**的图片当底图（M5：AI 识别失败后「转手动描摹」的一键入口）。
 *
 * 与 `loadUnderlayFromFile` 的区别只是省掉压缩那一步——识别对话框里的图早就压过了，
 * 再压一次纯属浪费，还会二次损质。
 */
export async function applyUnderlayFromDataUrl(
  dataUrl: string,
  size: { width: number; height: number },
): Promise<boolean> {
  try {
    await loadImageElement(dataUrl);
    const prev = usePlanStore.getState().doc.underlay;
    usePlanStore
      .getState()
      .setUnderlay(
        createUnderlay(dataUrl, size, prev ? { opacity: prev.opacity, locked: prev.locked } : null),
      );
    const ui = useUiStore.getState();
    ui.clearSelection();
    ui.requestFit();
    notify(strings.m2.uploadDone);
    return true;
  } catch {
    notify(strings.m2.uploadFailed, 'error');
    return false;
  }
}

/** 移除底图 */
export function removeUnderlay(): void {
  usePlanStore.getState().setUnderlay(null);
  useUiStore.getState().clearSelection();
}
