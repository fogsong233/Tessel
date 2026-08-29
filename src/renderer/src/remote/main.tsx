import React from 'react';
import ReactDOM from 'react-dom/client';
import { RemoteWhiteboardApp } from './RemoteWhiteboardApp';
import './remote.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RemoteWhiteboardApp />
  </React.StrictMode>
);
