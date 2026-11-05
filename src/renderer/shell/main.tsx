import { createRoot } from 'react-dom/client';
import { Shell } from './Shell.tsx';
import '../common/base.css';
import './shell.css';

createRoot(document.getElementById('root')!).render(<Shell />);
