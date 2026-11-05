// Development-only page for tuning visual components (not part of the app build).
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PixelMark } from '../common/PixelMark.tsx';
import { KilnMark } from '../common/KilnMark.tsx';
import '../common/base.css';

function Lab() {
  const [working, setWorking] = useState(true);
  const [introKey, setIntroKey] = useState(0);
  return (
    <div style={{ padding: 32, display: 'flex', flexDirection: 'column', gap: 28, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', gap: 12 }}>
        <button onClick={() => setWorking(!working)} style={{ padding: '6px 12px', border: '1px solid #333', borderRadius: 8 }}>
          working: {String(working)}
        </button>
        <button onClick={() => setIntroKey(introKey + 1)} style={{ padding: '6px 12px', border: '1px solid #333', borderRadius: 8 }}>
          replay intro
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 40 }}>
        {[16, 22, 28, 40, 64, 96, 160].map((s) => (
          <div key={s} style={{ textAlign: 'center', color: '#888', fontSize: 12 }}>
            <PixelMark size={s} working={working} />
            <div>{s}px</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 40 }}>
        <PixelMark key={introKey} size={96} intro />
        <KilnMark size={96} />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Lab />);
