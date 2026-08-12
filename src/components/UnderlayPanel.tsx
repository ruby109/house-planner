/**
 * 底图控制面板（M2）。
 *
 * 出现位置（互斥，避免同一套控件出现两遍）：
 * - Sidebar：有底图但当前没选中底图时，作为独立小面板常驻；
 * - PropertiesPanel：选中底图（id='underlay'）时作为该元素的属性面板。
 *
 * 交互要点：
 * - 透明度滑条拖动时只改 uiStore 的实时预览值，松手（原生 change）才写文档，
 *   保证「一次调整 = 一步撤销」；
 * - 锁定时底图 listening=false，完全不挡描图；解锁后可拖动 + 用角度输入框旋转，
 *   旋转围绕图片中心（offsetKeepingCenter），图不会跳走；
 * - 「重新标定」切到 underlay_calibrate 工具。
 */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { usePlanStore } from '../store/planStore';
import { useUiStore } from '../store/uiStore';
import { strings } from '../ui/strings';
import { formatInt, formatMm } from '../utils/units';
import {
  UNDERLAY_MAX_OPACITY,
  UNDERLAY_MIN_OPACITY,
  cachedImageSize,
  offsetKeepingCenter,
} from '../utils/underlayImage';
import { startUnderlayCalibration } from '../tools/underlayCalibrateTool';
import { UNDERLAY_ACCEPT, loadUnderlayFromFile, removeUnderlay } from '../utils/underlayUpload';
import './panels.css';

/** 透明度滑条：拖动实时预览，松手提交（同 PropertiesPanel 里 ColorField 的思路） */
function OpacitySlider({ value }: { value: number }) {
  const updateUnderlay = usePlanStore((s) => s.updateUnderlay);
  const setPreview = useUiStore((s) => s.setUnderlayOpacityPreview);
  const [local, setLocal] = useState(value);
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => setLocal(value), [value]);
  // 卸载时清掉预览值，避免残留
  useEffect(() => () => setPreview(null), [setPreview]);

  const commit = (v: number) => {
    setPreview(null);
    if (v !== value) updateUnderlay({ opacity: v });
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onChange = () => commit(Number(el.value));
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  });

  return (
    <label className="prop-row">
      <span>{strings.m2.opacity}</span>
      <span className="range-cell">
        <input
          ref={ref}
          className="range-input"
          type="range"
          min={UNDERLAY_MIN_OPACITY}
          max={UNDERLAY_MAX_OPACITY}
          step={0.05}
          value={local}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const v = Number(e.target.value);
            setLocal(v);
            setPreview(v);
          }}
        />
        <em className="mono">{Math.round(local * 100)}%</em>
      </span>
    </label>
  );
}

/** 旋转角度输入：失焦 / 回车提交，围绕图片中心旋转 */
function RotationField({ value, disabled }: { value: number; disabled: boolean }) {
  const updateUnderlay = usePlanStore((s) => s.updateUnderlay);
  const underlay = usePlanStore((s) => s.doc.underlay);
  const [text, setText] = useState(String(Math.round(value)));

  useEffect(() => setText(String(Math.round(value))), [value]);

  const commit = () => {
    const n = Number(text);
    if (!underlay || !Number.isFinite(n) || n === value) {
      setText(String(Math.round(value)));
      return;
    }
    const size = cachedImageSize(underlay.imageDataUrl);
    updateUnderlay(
      size
        ? { rotation: n, offset: offsetKeepingCenter(underlay, { rotation: n }, size) }
        : { rotation: n },
    );
  };

  return (
    <label className="prop-row">
      <span>{strings.m2.rotation}</span>
      <input
        className="text-input"
        type="number"
        step={1}
        disabled={disabled}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

export function UnderlayPanel() {
  const underlay = usePlanStore((s) => s.doc.underlay);
  const updateUnderlay = usePlanStore((s) => s.updateUnderlay);
  const exportWithUnderlay = useUiStore((s) => s.exportWithUnderlay);
  const setExportWithUnderlay = useUiStore((s) => s.setExportWithUnderlay);
  const fileRef = useRef<HTMLInputElement | null>(null);

  if (!underlay) return null;

  const size = cachedImageSize(underlay.imageDataUrl);

  return (
    <div className="props">
      <div className="props-kind">
        <b>{strings.m2.title}</b>
        <span className="props-id">
          {size ? `${formatInt(size.width)}×${formatInt(size.height)} px` : '…'}
        </span>
      </div>

      <OpacitySlider value={underlay.opacity} />

      <label className="prop-row-inline">
        <input
          type="checkbox"
          checked={underlay.locked}
          onChange={(e) => updateUnderlay({ locked: e.target.checked })}
        />
        <span className="muted">{strings.m2.locked}</span>
      </label>

      <RotationField value={underlay.rotation} disabled={underlay.locked} />

      <div className="prop-static">
        <span>{strings.m2.scale}</span>
        <span className="mono">
          {underlay.mmPerPixel.toFixed(3)} {strings.m2.scaleUnit}
        </span>
      </div>
      {size && (
        <div className="prop-static">
          <span>{strings.m2.widthMm}</span>
          <span className="mono">{formatMm(size.width * underlay.mmPerPixel)}</span>
        </div>
      )}

      <button type="button" className="btn btn-primary btn-block" onClick={startUnderlayCalibration}>
        {strings.m2.recalibrate}
      </button>

      <div className="underlay-actions">
        <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
          {strings.m2.replace}
        </button>
        <button type="button" className="btn btn-danger" onClick={removeUnderlay}>
          {strings.m2.remove}
        </button>
      </div>

      <label className="prop-row-inline">
        <input
          type="checkbox"
          checked={exportWithUnderlay}
          onChange={(e) => setExportWithUnderlay(e.target.checked)}
        />
        <span className="muted">{strings.m2.exportWithUnderlay}</span>
      </label>

      {!underlay.locked && <p className="muted underlay-hint">{strings.m2.unlockToEdit}</p>}

      <input
        ref={fileRef}
        type="file"
        accept={UNDERLAY_ACCEPT}
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) await loadUnderlayFromFile(file);
        }}
      />
    </div>
  );
}

export default UnderlayPanel;
