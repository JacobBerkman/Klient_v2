import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const apiOrigin = process.env.KLIENT_API_ORIGIN || 'http://127.0.0.1:3000'

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: false
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': apiOrigin,
      '/health': apiOrigin,
      '/ready': apiOrigin,
      '/system': apiOrigin,
      '/legacy': apiOrigin,
      '/legacy/portal': apiOrigin
    }
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true
  }
})
