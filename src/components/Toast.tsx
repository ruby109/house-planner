/**
 * 一次性提示条（M1d）。3 秒后自动消失，点击可立刻关掉。
 * 消息来源见 ui/toast.ts（工具、持久化等非组件代码也能发）。
 */
import { useEffect } from 'react';
import { useToastStore } from '../ui/toast';

const AUTO_DISMISS_MS = 3200;

export function Toast() {
  const message = useToastStore((s) => s.message);
  const kind = useToastStore((s) => s.kind);
  const seq = useToastStore((s) => s.seq);
  const dismiss = useToastStore((s) => s.dismiss);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(dismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [message, seq, dismiss]);

  if (!message) return null;

  return (
    <div className={`toast toast-${kind}`} role="status" onClick={dismiss}>
      {message}
    </div>
  );
}

export default Toast;
