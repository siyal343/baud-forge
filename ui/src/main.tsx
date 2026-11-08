import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installGlobalErrorHandlers } from './services/globalErrors';
import { useSettingsStore } from './store/useSettingsStore';
import { useWorkstationStore } from './store/useWorkstationStore';
import { plotEngine } from './plot/engine';
import { applyTheme } from './utils/theme';
import './index.css';

// Before the first render: any exception from startup must still be reported.
installGlobalErrorHandlers();

// Plot Forge data engine: feed from the workstation store for the whole app
// lifetime (started before render so history accumulates even while the panel
// is closed). Data lives in engine rings; no React re-renders are involved.
plotEngine.start({
  getSourcePackets: () => useWorkstationStore.getState().packets,
  subscribe: (fn) => useWorkstationStore.subscribe(fn),
});

// Resolve the persisted theme before the first paint (belt to index.html's
// suspenders — the inline pre-paint script already set the attributes).
const bootSettings = useSettingsStore.getState().settings;
applyTheme(bootSettings.theme, bootSettings.themeMode);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
