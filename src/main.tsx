import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { restoreDoc, startAutosave } from './utils/persist';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

// 先恢复本地存档再渲染：画布首次「适应视图」就能框住恢复出来的内容。
// restoreDoc 内部会 clearHistory，避免第一次 Ctrl+Z 撤销回空文档。
restoreDoc();
// 自动保存跟随应用生命周期，不需要取消
startAutosave();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
