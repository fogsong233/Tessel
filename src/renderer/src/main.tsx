import React from 'react';
import ReactDOM from 'react-dom/client';
import 'katex/dist/katex.min.css';
import 'primereact/resources/primereact.min.css';
import 'primeicons/primeicons.css';
import 'pdfjs-dist/web/pdf_viewer.css';
import './styles.css';
import { App } from './App';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
