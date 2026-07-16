import React from 'react';
import ReactDOM from 'react-dom/client';
import { CanvasApp } from './CanvasApp';

declare global {
  interface Window {
    yaliCanvasRuntime?: Record<string, unknown>;
  }
}

if (!window.yaliCanvasRuntime) {
  window.yaliCanvasRuntime = {};
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CanvasApp />
  </React.StrictMode>
);
