import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import TerminalPopout from './terminal/TerminalPopout';
import { ToastProvider } from '@/ui';
import './index.css';

// Torn-off terminal windows load the same bundle with ?termPopout=<sessionId>
// and render only the lightweight popout shell — no tabs, no app chrome.
const params = new URLSearchParams(window.location.search);
const termPopoutId = params.get('termPopout');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {termPopoutId ? (
      <TerminalPopout sessionId={termPopoutId} initialLabel={params.get('label') || undefined} />
    ) : (
      <ToastProvider>
        <App />
      </ToastProvider>
    )}
  </StrictMode>,
);
