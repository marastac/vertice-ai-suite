import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Dev-only: exposes migrateLocalDataToSupabase() on window for one-time,
// manual data migration from the console. Dead-code-eliminated from
// production builds since import.meta.env.DEV is statically false there.
if (import.meta.env.DEV) {
  import('./migration/local-to-supabase')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
