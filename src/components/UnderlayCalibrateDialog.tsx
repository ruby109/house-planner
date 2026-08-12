/**
 * 底图标定的输入小面板（M2）。
 *
 * 两点都落下后浮在画布上方，让用户输入这段的实际长度（默认 1820mm = 1 間）。
 * 确认 → 重算 mmPerPixel 并回到 select 工具；取消 / Esc → 放弃本次标定。
 */
import { useEffect, useRef, useState } from 'react';
import { GRID } from '../model/defaults';
import { strings } from '../ui/strings';
import {
  cancelUnderlayCalibration,
  commitUnderlayCalibration,
} from '../tools/underlayCalibrateTool';
import { useUnderlayCalibrateDraft } from '../tools/underlayCalibrateDraft';
import { UNDERLAY_DEFAULT_KNOWN_MM } from '../utils/underlayImage';
import { formatInt } from '../utils/units';
import './panels.css';

/** 常用长度（半間 / 1 間 / 1.5 間 / 2 間） */
const PRESETS = [GRID / 2, GRID, GRID * 2, GRID * 3, GRID * 4].map(Math.round);

export function UnderlayCalibrateDialog() {
  const awaitingInput = useUnderlayCalibrateDraft((s) => s.awaitingInput);
  const [text, setText] = useState(String(UNDERLAY_DEFAULT_KNOWN_MM));
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (awaitingInput) {
      setText(String(UNDERLAY_DEFAULT_KNOWN_MM));
      // 自动聚焦并全选，输入实际长度后直接回车
      const t = setTimeout(() => inputRef.current?.select(), 0);
      return () => clearTimeout(t);
    }
  }, [awaitingInput]);

  if (!awaitingInput) return null;

  const value = Number(text);
  const valid = Number.isFinite(value) && value > 0;

  const submit = () => {
    if (valid) commitUnderlayCalibration(value);
  };

  return (
    <div className="calibrate-dialog" role="dialog" aria-label={strings.m2.calibrateTitle}>
      <div className="calibrate-title">{strings.m2.calibrateTitle}</div>
      <div className="calibrate-row">
        <input
          ref={inputRef}
          className="text-input"
          type="number"
          min={1}
          step={10}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              cancelUnderlayCalibration();
            }
          }}
        />
        <span className="muted">mm</span>
      </div>
      <div className="chip-row">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className={`chip${Number(text) === p ? ' is-active' : ''}`}
            onClick={() => setText(String(p))}
          >
            {formatInt(p)}
          </button>
        ))}
      </div>
      <div className="form-actions">
        <button type="button" className="btn btn-primary" disabled={!valid} onClick={submit}>
          {strings.m2.calibrateConfirm}
        </button>
        <button type="button" className="btn" onClick={cancelUnderlayCalibration}>
          {strings.m2.calibrateCancel}
        </button>
      </div>
    </div>
  );
}

export default UnderlayCalibrateDialog;
