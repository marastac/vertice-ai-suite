import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // Fail loudly if 5173 is taken instead of silently drifting to 5174+.
    // The backend's CORS_ORIGIN is pinned to 5173, so a silent port change
    // here would otherwise surface as a confusing "can't connect" error in
    // the public chat rather than a clear startup failure.
    strictPort: true,
  },
})
