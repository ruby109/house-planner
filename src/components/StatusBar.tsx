import { BASE_SCALE, SNAP_STEPS } from '../model/defaults';
import { useUiStore } from '../store/uiStore';
import { strings } from '../ui/strings';
import { formatInt, formatZoom } from '../utils/units';
import { formatClock, useSaveStatus } from '../utils/persist';

/** 自动保存指示：「保存中…」/「已保存 HH:MM」/「保存失败」 */
function AutosaveIndicator() {
  const status = useSaveStatus((s) => s.status);
  const savedAt = useSaveStatus((s) => s.savedAt);

  const text =
    status === 'saving'
      ? strings.statusBar.autosaveSaving
      : status === 'error'
        ? strings.statusBar.autosaveError
        : status === 'saved' && savedAt !== null
          ? strings.statusBar.autosaveSaved(formatClock(savedAt))
          : strings.statusBar.autosaveIdle;

  return (
    <span className={`status-item status-right${status === 'error' ? '' : ' muted'}`}>
      <b>{strings.statusBar.autosave}</b>
      {text}
    </span>
  );
}

export function StatusBar() {
  const pointer = useUiStore((s) => s.pointer);
  const scale = useUiStore((s) => s.scale);
  const snapStep = useUiStore((s) => s.snapStep);
  const snapEnabled = useUiStore((s) => s.snapEnabled);
  const displayUnit = useUiStore((s) => s.displayUnit);
  const setSnapStep = useUiStore((s) => s.setSnapStep);
  const toggleSnap = useUiStore((s) => s.toggleSnap);
  const setDisplayUnit = useUiStore((s) => s.setDisplayUnit);

  return (
    <footer className="statusbar">
      {/* 数字用等宽定宽槽位：指针移动时状态栏其余项不会左右晃动 */}
      <span className="status-item mono" title="指针的文档坐标（mm）">
        <b>{strings.statusBar.pointer}</b>
        <span className="status-axis">X</span>
        <span className="status-num">{pointer ? formatInt(pointer.x) : '—'}</span>
        <span className="status-axis">Y</span>
        <span className="status-num">{pointer ? formatInt(pointer.y) : '—'}</span>
      </span>

      <span className="status-item mono">
        <b>{strings.statusBar.zoom}</b>
        <span className="status-num status-num-zoom">{formatZoom(scale, BASE_SCALE)}</span>
      </span>

      <span className="status-item">
        <b>{strings.statusBar.snap}</b>
        <button
          type="button"
          className={`chip${snapEnabled ? ' is-active' : ''}`}
          onClick={toggleSnap}
          title="开关吸附"
        >
          {snapEnabled ? strings.statusBar.snapOn : strings.statusBar.snapOff}
        </button>
        <span className="chip-row">
          {SNAP_STEPS.map((step) => (
            <button
              key={step}
              type="button"
              className={`chip${snapEnabled && snapStep === step ? ' is-active' : ''}`}
              disabled={!snapEnabled}
              onClick={() => setSnapStep(step)}
              title={`吸附步长 ${step} mm`}
            >
              {step === 1 ? '自由' : step}
            </button>
          ))}
        </span>
      </span>

      <span className="status-item">
        <b>{strings.statusBar.unit}</b>
        <span className="chip-row">
          <button
            type="button"
            className={`chip${displayUnit === 'ja' ? ' is-active' : ''}`}
            onClick={() => setDisplayUnit('ja')}
          >
            {strings.statusBar.unitJa}
          </button>
          <button
            type="button"
            className={`chip${displayUnit === 'metric' ? ' is-active' : ''}`}
            onClick={() => setDisplayUnit('metric')}
          >
            {strings.statusBar.unitMetric}
          </button>
        </span>
      </span>

      <AutosaveIndicator />
    </footer>
  );
}

export default StatusBar;
