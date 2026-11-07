import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installGlobalErrorHandlers } from './services/globalErrors';
import './index.css';

// Before the first render: any exception from startup must still be reported.
installGlobalErrorHandlers();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
