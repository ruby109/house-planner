import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { ChangeEvent, ReactElement, ReactNode } from 'react';
import { strings } from '../ui/strings';
import { useUiStore, type Tool } from '../store/uiStore';
import { canRedo, canUndo, planTemporal, redo, undo, usePlanStore } from '../store/planStore';
import { exportJson, importJsonFile } from '../utils/persist';
import { exportPng } from '../utils/exportPng';
import { UNDERLAY_ACCEPT, loadUnderlayFromFile } from '../utils/underlayUpload';
import { openRecognizeDialog } from './RecognizeDialog';

interface ToolDef {
  tool: Tool;
  label: string;
  shortcut: string;
  icon: ReactElement;
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const ICON_SIZE = 20;

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

const TOOLS: ToolDef[] = [
  {
    tool: 'select',
    label: strings.tools.select,
    shortcut: strings.toolShortcuts.select,
    icon: (
      <Svg>
        <path d="M5 3l14 8-6 1.5L10 19z" {...stroke} />
      </Svg>
    ),
  },
  {
    tool: 'wall',
    label: strings.tools.wall,
    shortcut: strings.toolShortcuts.wall,
    icon: (
      <Svg>
        <path d="M3 17h18" {...stroke} strokeWidth={3.2} />
        <circle cx="3" cy="17" r="1.8" {...stroke} />
        <circle cx="21" cy="17" r="1.8" {...stroke} />
      </Svg>
    ),
  },
  {
    tool: 'door',
    label: strings.tools.door,
    shortcut: strings.toolShortcuts.door,
    icon: (
      <Svg>
        <path d="M6 19V6h7v13" {...stroke} />
        <path d="M13 6a9 9 0 0 1 6 9" {...stroke} strokeDasharray="2.5 2.5" />
      </Svg>
    ),
  },
  {
    tool: 'sliding_door',
    label: strings.tools.sliding_door,
    shortcut: strings.toolShortcuts.sliding_door,
    icon: (
      <Svg>
        <path d="M3 9h10M11 15h10" {...stroke} strokeWidth={2.4} />
        <path d="M3 20h18M3 4h18" {...stroke} strokeWidth={1} />
      </Svg>
    ),
  },
  {
    tool: 'window',
    label: strings.tools.window,
    shortcut: strings.toolShortcuts.window,
    icon: (
      <Svg>
        <path d="M3 8h18M3 12h18M3 16h18" {...stroke} />
      </Svg>
    ),
  },
  {
    tool: 'column',
    label: strings.tools.column,
    shortcut: strings.toolShortcuts.column,
    icon: (
      <Svg>
        <rect x="8" y="8" width="8" height="8" fill="currentColor" />
      </Svg>
    ),
  },
  {
    tool: 'beam',
    label: strings.tools.beam,
    shortcut: strings.toolShortcuts.beam,
    icon: (
      <Svg>
        <rect x="3" y="9" width="18" height="6" {...stroke} strokeDasharray="3 2" />
      </Svg>
    ),
  },
  {
    tool: 'furniture_place',
    label: strings.tools.furniture_place,
    shortcut: strings.toolShortcuts.furniture_place,
    icon: (
      <Svg>
        <rect x="3" y="10" width="18" height="7" rx="1.5" {...stroke} />
        <path d="M5 10V7h14v3M5 17v2M19 17v2" {...stroke} />
      </Svg>
    ),
  },
];

function ActionIcon({
  name,
}: {
  name: 'undo' | 'redo' | 'import' | 'export' | 'png' | 'fit' | 'underlay' | 'recognize';
}) {
  switch (name) {
    case 'recognize':
      return (
        <Svg>
          <path d="M4 6h8M8 4v10" {...stroke} />
          <path d="M15 4l1.4 3.6L20 9l-3.6 1.4L15 14l-1.4-3.6L10 9l3.6-1.4z" {...stroke} />
          <path d="M4 19h16" {...stroke} />
        </Svg>
      );
    case 'underlay':
      return (
        <Svg>
          <rect x="3" y="5" width="18" height="14" rx="2" {...stroke} strokeDasharray="3 2" />
          <path d="M3 15l4-4 3 3 4-4 7 6" {...stroke} />
          <circle cx="9" cy="9" r="1.4" {...stroke} />
        </Svg>
      );
    case 'undo':
      return (
        <Svg>
          <path d="M9 7L4 12l5 5" {...stroke} />
          <path d="M4 12h9a6 6 0 0 1 0 12h-1" {...stroke} />
        </Svg>
      );
    case 'redo':
      return (
        <Svg>
          <path d="M15 7l5 5-5 5" {...stroke} />
          <path d="M20 12h-9a6 6 0 0 0 0 12h1" {...stroke} />
        </Svg>
      );
    case 'import':
      return (
        <Svg>
          <path d="M12 16V4M8 12l4 4 4-4M4 20h16" {...stroke} />
        </Svg>
      );
    case 'export':
      return (
        <Svg>
          <path d="M12 4v12M8 8l4-4 4 4M4 20h16" {...stroke} />
        </Svg>
      );
    case 'png':
      return (
        <Svg>
          <rect x="3" y="5" width="18" height="14" rx="2" {...stroke} />
          <path d="M3 16l5-5 4 4 3-3 6 6" {...stroke} />
        </Svg>
      );
    case 'fit':
      return (
        <Svg>
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" {...stroke} />
        </Svg>
      );
  }
}

/** 订阅 zundo 的 temporal store，让撤销/重做按钮的禁用态跟着历史走 */
function useTemporalFlags(): { undoable: boolean; redoable: boolean } {
  const subscribe = planTemporal.subscribe;
  const undoable = useSyncExternalStore(subscribe, canUndo, canUndo);
  const redoable = useSyncExternalStore(subscribe, canRedo, canRedo);
  return { undoable, redoable };
}

export function Toolbar() {
  const activeTool = useUiStore((s) => s.activeTool);
  const setActiveTool = useUiStore((s) => s.setActiveTool);
  const requestFit = useUiStore((s) => s.requestFit);
  const { undoable, redoable } = useTemporalFlags();

  const hasUnderlay = usePlanStore((s) => s.doc.underlay !== null);
  const exportWithUnderlay = useUiStore((s) => s.exportWithUnderlay);
  const setExportWithUnderlay = useUiStore((s) => s.setExportWithUnderlay);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const imageRef = useRef<HTMLInputElement | null>(null);

  const handlePickFile = useCallback(() => fileRef.current?.click(), []);
  const handleFileChange = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // 先清空 value，保证连续选同一个文件也能触发 change
    e.target.value = '';
    if (file) await importJsonFile(file);
  }, []);

  const handlePickImage = useCallback(() => imageRef.current?.click(), []);
  const handleImageChange = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await loadUnderlayFromFile(file);
  }, []);

  return (
    <nav className="toolbar" aria-label="工具栏">
      <div className="toolbar-group">
        {TOOLS.map((t) => (
          <button
            key={t.tool}
            type="button"
            className={`tool-btn${activeTool === t.tool ? ' is-active' : ''}`}
            title={`${t.label}（${t.shortcut}）`}
            aria-label={t.label}
            aria-pressed={activeTool === t.tool}
            onClick={() => setActiveTool(t.tool)}
          >
            {t.icon}
          </button>
        ))}
      </div>

      <div className="toolbar-sep" />

      <div className="toolbar-group">
        <button
          type="button"
          className="tool-btn"
          title={strings.actions.fitView}
          aria-label={strings.actions.fitView}
          onClick={requestFit}
        >
          <ActionIcon name="fit" />
        </button>
      </div>

      <div className="toolbar-sep" />

      <div className="toolbar-group">
        <button
          type="button"
          className="tool-btn"
          title={`${strings.m2.upload}：${strings.m2.uploadTip}`}
          aria-label={strings.m2.upload}
          onClick={handlePickImage}
        >
          <ActionIcon name="underlay" />
        </button>
        <input
          ref={imageRef}
          type="file"
          accept={UNDERLAY_ACCEPT}
          hidden
          onChange={handleImageChange}
        />
        <button
          type="button"
          className="tool-btn"
          title={`${strings.m3.toolbar}：${strings.m3.toolbarTip}`}
          aria-label={strings.m3.toolbar}
          onClick={openRecognizeDialog}
        >
          <ActionIcon name="recognize" />
        </button>
      </div>

      <div className="toolbar-sep" />

      <div className="toolbar-group">
        <button
          type="button"
          className="tool-btn"
          disabled={!undoable}
          title={`${strings.actions.undo}（${strings.actionShortcuts.undo}）`}
          aria-label={strings.actions.undo}
          onClick={() => undo()}
        >
          <ActionIcon name="undo" />
        </button>
        <button
          type="button"
          className="tool-btn"
          disabled={!redoable}
          title={`${strings.actions.redo}（${strings.actionShortcuts.redo}）`}
          aria-label={strings.actions.redo}
          onClick={() => redo()}
        >
          <ActionIcon name="redo" />
        </button>
      </div>

      <div className="toolbar-sep" />

      <div className="toolbar-group">
        <button
          type="button"
          className="tool-btn"
          title={strings.actions.importJson}
          aria-label={strings.actions.importJson}
          onClick={handlePickFile}
        >
          <ActionIcon name="import" />
        </button>
        <button
          type="button"
          className="tool-btn"
          title={strings.actions.exportJson}
          aria-label={strings.actions.exportJson}
          onClick={exportJson}
        >
          <ActionIcon name="export" />
        </button>
        <button
          type="button"
          className="tool-btn"
          title={strings.actions.exportPng}
          aria-label={strings.actions.exportPng}
          onClick={() => exportPng()}
        >
          <ActionIcon name="png" />
        </button>
        {hasUnderlay && (
          <label className="toolbar-check" title={strings.m2.exportWithUnderlay}>
            <input
              type="checkbox"
              checked={exportWithUnderlay}
              onChange={(e) => setExportWithUnderlay(e.target.checked)}
            />
            <span>底图</span>
          </label>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={handleFileChange}
        />
      </div>
    </nav>
  );
}

export default Toolbar;
