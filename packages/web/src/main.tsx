import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ProfileProvider } from './state/ProfileContext';
import { initSpotlight } from './lib/spotlight';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

initSpotlight();

createRoot(container).render(
  <StrictMode>
    {/* On GitHub Pages the app is served from /<repo>/, so the router has to
        strip that prefix before matching. Vite fills BASE_URL in from the
        build's `base`, which is '/' everywhere else. */}
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <ProfileProvider>
        <App />
      </ProfileProvider>
    </BrowserRouter>
  </StrictMode>,
);
