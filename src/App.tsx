import { useEffect, useRef, useState } from 'react';
import PlanCanvas from './components/canvas/PlanCanvas';
import Sidebar from './components/Sidebar';
import StatusBar from './components/StatusBar';
import Toast from './components/Toast';
import Toolbar from './components/Toolbar';
import RecognizeDialog from './components/RecognizeDialog';
import UnderlayCalibrateDialog from './components/UnderlayCalibrateDialog';
import { useShortcuts } from './hooks/useShortcuts';
import { strings } from './ui/strings';
import { usePlanStore } from './store/planStore';

/**
 * 顶栏文档名：点击变输入框，回车 / 失焦提交，Esc 放弃。
 * 改名会进 undo 历史（M1d 取实现简单优先）。
 */
function DocNameField() {
  const name = usePlanStore((s) => s.doc.meta.name);
  const setDocName = usePlanStore((s) => s.setDocName);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const begin = () => {
    setText(name);
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const v = text.trim();
    if (v && v !== name) setDocName(v);
  };

  if (!editing) {
    return (
      <button type="button" className="appbar-doc" title={strings.m1d.docNameEdit} onClick={begin}>
        {name}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      className="appbar-doc-input"
      type="text"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          e.stopPropagation();
          setText(name);
          setEditing(false);
        }
      }}
    />
  );
}

export function App() {
  useShortcuts();

  return (
    <div className="app">
      <header className="appbar">
        <span className="appbar-brand">{strings.appName}</span>
        <span className="appbar-sub">{strings.appSubtitle}</span>
        <DocNameField />
      </header>
      <Toolbar />
      <main className="workspace">
        <PlanCanvas />
      </main>
      <Sidebar />
      <StatusBar />
      <UnderlayCalibrateDialog />
      <RecognizeDialog />
      <Toast />
    </div>
  );
}

export default App;
