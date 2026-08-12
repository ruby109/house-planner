/**
 * M3：AI 识别間取り图的对话框（见 docs/AI-RECOGNITION.md 第 5 节）。
 *
 * 流程：选/拖图片 → 复用 M2 的压缩 → POST /api/recognize → solver →
 * （当前文档非空时）确认替换 → 写入文档 + 对齐底图 → 展示 warnings。
 *
 * 打开入口是导出的 `openRecognizeDialog()`（Toolbar 调用），
 * 开关状态放在一个极小的 zustand store 里，和 M2 的 `underlayCalibrateDraft` 同样的做法。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { create } from 'zustand';
import { applyRecognition, isDocEmpty, type RecognizedImage } from '../ai/applyRecognition';
import {
  RecognizeRequestError,
  fetchRecognizeInfo,
  requestRecognition,
  type RecognizeCvStats,
  type RecognizeErrorCode,
  type RecognizeInfo,
  type RecognizePipeline,
} from '../ai/recognizeClient';
import { solveRecognizeResult, type SolveResult } from '../ai/solve';
import { usePlanStore } from '../store/planStore';
import { strings } from '../ui/strings';
import { prepareRecognizeImage } from '../utils/underlayImage';
import { applyUnderlayFromDataUrl, isImageFile, pickImageFile } from '../utils/underlayUpload';
import './panels.css';

// ---------------------------------------------------------------------------
// 开关状态
// ---------------------------------------------------------------------------

interface RecognizeDialogState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useRecognizeDialogStore = create<RecognizeDialogState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function openRecognizeDialog(): void {
  useRecognizeDialogStore.getState().setOpen(true);
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

type Stage = 'pick' | 'running' | 'confirm' | 'done' | 'error';

interface PendingSolve {
  solved: SolveResult;
  image: RecognizedImage;
  /** 服务端侧的提示（二次校对失败等），与 solver warnings 一起展示 */
  serverWarnings: string[];
  /** 实际用到的管线 + CV 统计（完成面板里展示） */
  pipeline: RecognizePipeline;
  cv: RecognizeCvStats | null;
  /** 服务端没能走成轮廓提取，退成了纯 AI */
  fellBack: boolean;
}

export function RecognizeDialog() {
  const open = useRecognizeDialogStore((s) => s.open);
  const setOpen = useRecognizeDialogStore((s) => s.setOpen);

  const [stage, setStage] = useState<Stage>('pick');
  const [image, setImage] = useState<RecognizedImage | null>(null);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  /** M5：错误码——`cv_insufficient` 要额外给「转手动描摹」的出口 */
  const [errorCode, setErrorCode] = useState<RecognizeErrorCode | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [pending, setPending] = useState<PendingSolve | null>(null);
  /** 服务端配置（provider / 模型），只用于展示与模型下拉；拿不到就不显示 */
  const [info, setInfo] = useState<RecognizeInfo | null>(null);
  /** 用户在下拉里选的模型；空串 = 用服务端默认 */
  const [model, setModel] = useState('');
  /**
   * 二次校对：只对**纯 AI / hybrid** 管线有意义。M5 的默认管线（cv）里 AI 只答
   * 房间名和帖数，没什么可校对的，所以默认关掉。
   */
  const [refine, setRefine] = useState(false);
  /**
   * 识别管线。M5 起 UI **不再让用户选**——几何唯一来源就是轮廓提取，
   * 这里只是跟着服务端的默认值走（`vlm` / `hybrid` 仍在 API 与测试脚本里可用）。
   */
  const [pipeline, setPipeline] = useState<RecognizePipeline>('cv');
  /** 完成面板里展示的 CV 统计 */
  const [outcome, setOutcome] = useState<Pick<PendingSolve, 'pipeline' | 'cv' | 'fellBack'> | null>(
    null,
  );

  const fileRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setStage('pick');
    setImage(null);
    setPhase('');
    setError('');
    setErrorCode(null);
    setWarnings([]);
    setPending(null);
    setOutcome(null);
    setDragOver(false);
  }, []);

  const close = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setOpen(false);
    reset();
  }, [reset, setOpen]);

  // 打开时清空上一次的残留；Esc 关闭
  useEffect(() => {
    if (!open) return;
    reset();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, reset, close]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // 打开时查一次服务端配置（失败静默：只是少显示一行小字）
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetchRecognizeInfo(controller.signal).then((next) => {
      if (controller.signal.aborted || !next) return;
      setInfo(next);
      setModel((cur) => (cur && next.models.includes(cur) ? cur : ''));
      // 管线跟着服务端走（UI 不给选项，免得两边默认值漂移）
      setPipeline(next.pipeline);
    });
    return () => controller.abort();
  }, [open]);

  const acceptFile = useCallback(async (file: File) => {
    if (!isImageFile(file)) {
      setError(strings.m3.notImage);
      setErrorCode(null);
      setStage('error');
      return;
    }
    try {
      // M5：**尽量不重编码**——多一道 JPEG 有损压缩会让 CV 提不出房间（见 prepareRecognizeImage）
      const compressed = await prepareRecognizeImage(file);
      setImage({ dataUrl: compressed.dataUrl, width: compressed.width, height: compressed.height });
      setError('');
      setErrorCode(null);
      setStage('pick');
    } catch {
      setError(strings.m3.compressFailed);
      setErrorCode(null);
      setStage('error');
    }
  }, []);

  const handleFileChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (file) await acceptFile(file);
    },
    [acceptFile],
  );

  const handleDrop = useCallback(
    async (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const file = pickImageFile(e.dataTransfer);
      if (file) await acceptFile(file);
      else {
        setError(strings.m3.notImage);
        setErrorCode(null);
        setStage('error');
      }
    },
    [acceptFile],
  );

  const finish = useCallback(
    async (next: PendingSolve) => {
      await applyRecognition(next.solved, next.image);
      const all = [...next.serverWarnings, ...next.solved.warnings];
      setOutcome({ pipeline: next.pipeline, cv: next.cv, fellBack: next.fellBack });
      // hybrid 跑过就一定停在完成面板上（要给用户看提取统计 / 回退提示）
      if (all.length > 0 || next.cv) {
        setWarnings(all);
        setStage('done');
      } else {
        close();
      }
    },
    [close],
  );

  const start = useCallback(async () => {
    if (!image) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setStage('running');
    setError('');
    setErrorCode(null);
    setPhase(
      pipeline === 'cv'
        ? strings.m3.phaseLabel
        : refine
          ? strings.m3.phaseRecognizeRefine
          : strings.m3.phaseRecognize,
    );

    try {
      const response = await requestRecognition(
        {
          imageDataUrl: image.dataUrl,
          imageWidthPx: image.width,
          imageHeightPx: image.height,
          ...(model ? { model } : {}),
          refine,
          pipeline,
        },
        controller.signal,
      );

      setPhase(strings.m3.phaseSolve);
      // cv / hybrid 成功时几何已经在服务端融合好了，本地不再跑 solver
      const solved =
        response.solved ??
        solveRecognizeResult(response.result, {
          imageWidthPx: image.width,
          imageHeightPx: image.height,
        });
      const next: PendingSolve = {
        solved,
        image,
        serverWarnings: response.warnings,
        pipeline: response.pipeline,
        cv: response.cv,
        fellBack: pipeline !== 'vlm' && response.pipeline === 'vlm',
      };

      if (isDocEmpty(usePlanStore.getState().doc)) await finish(next);
      else {
        setPending(next);
        setStage('confirm');
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(
        err instanceof RecognizeRequestError
          ? err.message
          : `识别失败：${err instanceof Error ? err.message : String(err)}`,
      );
      setErrorCode(err instanceof RecognizeRequestError ? err.code : null);
      setStage('error');
    } finally {
      abortRef.current = null;
    }
  }, [image, model, refine, pipeline, finish]);

  /** M5：轮廓提取不达标时的出口——把这张图直接设为底图，转手动描摹 */
  const useAsUnderlay = useCallback(async () => {
    if (!image) return;
    await applyUnderlayFromDataUrl(image.dataUrl, { width: image.width, height: image.height });
    close();
  }, [image, close]);

  if (!open) return null;

  // 底部一行小字：当前 provider / 模型（openrouter 且有多个候选时给个下拉）
  const canPickModel = !!info && !info.mock && info.models.length > 1;
  const footer = info && (
    <div className="recognize-provider">
      {info.mock ? (
        strings.m3.mockInfo
      ) : canPickModel ? (
        <>
          <span>{strings.m3.providerInfo(info.provider, model || info.model)}</span>
          <label>
            {strings.m3.modelLabel}
            <select
              value={model}
              disabled={stage === 'running'}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">{info.model}</option>
              {info.models
                .filter((m) => m !== info.model)
                .map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
            </select>
          </label>
        </>
      ) : (
        strings.m3.providerInfo(info.provider, info.model)
      )}
    </div>
  );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="recognize-dialog" role="dialog" aria-label={strings.m3.title} aria-modal="true">
        <div className="recognize-title">{strings.m3.title}</div>

        {(stage === 'pick' || stage === 'error') && (
          <>
            {image ? (
              <img className="recognize-thumb" src={image.dataUrl} alt="" />
            ) : (
              <div
                className={`recognize-drop${dragOver ? ' is-over' : ''}`}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
              >
                <span>{strings.m3.dropHint}</span>
                <span className="recognize-note">{strings.m3.dropFormats}</span>
              </div>
            )}
            {stage === 'error' && (
              <>
                {errorCode === 'cv_insufficient' && (
                  <div className="recognize-status">{strings.m3.cvInsufficientTitle}</div>
                )}
                <div className="recognize-error">{error}</div>
                {errorCode === 'cv_insufficient' && (
                  <p className="recognize-note">{strings.m3.cvInsufficientHint}</p>
                )}
              </>
            )}
            <p className="recognize-note">{strings.m3.pipelineHint}</p>
            {pipeline !== 'cv' && (
              <label className="recognize-option">
                <input
                  type="checkbox"
                  checked={refine}
                  onChange={(e) => setRefine(e.target.checked)}
                />
                <span>{strings.m3.refineLabel}</span>
              </label>
            )}
            <p className="recognize-note">{strings.m3.costNotice}</p>
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!image}
                onClick={() => void start()}
              >
                {stage === 'error' && image ? strings.m3.retry : strings.m3.start}
              </button>
              {errorCode === 'cv_insufficient' && image && (
                <button type="button" className="btn" onClick={() => void useAsUnderlay()}>
                  {strings.m3.useAsUnderlay}
                </button>
              )}
              {image && (
                <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
                  {strings.m3.replaceImage}
                </button>
              )}
              <button type="button" className="btn" onClick={close}>
                {strings.m3.cancel}
              </button>
            </div>
          </>
        )}

        {stage === 'running' && (
          <>
            {image && <img className="recognize-thumb" src={image.dataUrl} alt="" />}
            <div className="recognize-status">
              <span className="spinner" aria-hidden="true" />
              <span>{phase}</span>
            </div>
            <div className="form-actions">
              <button type="button" className="btn" onClick={close}>
                {strings.m3.cancel}
              </button>
            </div>
          </>
        )}

        {stage === 'confirm' && pending && (
          <>
            <div className="recognize-status">{strings.m3.replaceTitle}</div>
            <p className="recognize-note">{strings.m3.replaceBody}</p>
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={() => void finish(pending)}>
                {strings.m3.replaceConfirm}
              </button>
              <button type="button" className="btn" onClick={close}>
                {strings.m3.cancel}
              </button>
            </div>
          </>
        )}

        {stage === 'done' && (
          <>
            <div className="recognize-status">{strings.m3.doneTitle}</div>
            {outcome?.cv && (
              <p className="recognize-note">
                {strings.m3.cvStats(
                  outcome.cv.walls,
                  outcome.cv.rooms,
                  outcome.cv.mmPerPixel ?? null,
                )}
              </p>
            )}
            {outcome?.pipeline === 'cv' && outcome.cv && (
              <p className="recognize-note">
                {strings.m3.cvExtras(
                  outcome.cv.openingsPlaced ?? 0,
                  outcome.cv.columnCandidates ?? 0,
                )}
              </p>
            )}
            {!!outcome?.cv?.ignoredSmallRooms && (
              <p className="recognize-note">
                {strings.m3.smallRoomsIgnored(outcome.cv.ignoredSmallRooms)}
              </p>
            )}
            {outcome?.fellBack && <p className="recognize-note">{strings.m3.cvFallback}</p>}
            <p className="recognize-note">{strings.m3.columnsHint}</p>
            {warnings.length > 0 && (
              <>
                <div className="recognize-note">{strings.m3.warningsTitle}</div>
                <ul className="recognize-warnings">
                  {warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </>
            )}
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={close}>
                {strings.m3.close}
              </button>
            </div>
          </>
        )}

        {footer}

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => void handleFileChange(e)}
        />
      </div>
    </div>
  );
}

export default RecognizeDialog;
