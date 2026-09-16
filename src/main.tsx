import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './compact-results.css';
import './compact-layout.css';

document.documentElement.classList.add('compact-ui');

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
