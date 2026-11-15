import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// Radix's scroll-lock style singleton reads this standard nonce accessor.
(globalThis as typeof globalThis & { __webpack_nonce__?: string }).__webpack_nonce__ =
  document.querySelector<HTMLMetaElement>('meta[name="csp-style-nonce"]')?.content;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
