import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { connect, getState, tabApi } from './store.ts';
import '../common/base.css';
import './styles.css';
import './panels.css';
import './chat.css';
import './settings.css';

connect();
tabApi?.setProject(getState().projectId);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
