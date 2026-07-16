import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import App from './App.jsx';

const root = document.getElementById('free-image-canvas-root');
if (root) {
  createRoot(root).render(<App />);
}
