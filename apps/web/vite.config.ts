import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const apiOrigin = process.env.KLIENT_API_ORIGIN || 'http://127.0.0.1:3000'
const apiProxy: ProxyOptions = {
  target: apiOrigin,
  changeOrigin: false,
  secure: false,
  xfwd: true,
  configure(proxy) {
    proxy.on('proxyReq', (proxyReq) => {
      proxyReq.setHeader('x-forwarded-proto', 'http')
      proxyReq.setHeader('x-forwarded-host', '127.0.0.1:5173')
    })
  }
}

export default defineConfig({
  plugins: [react()],
  // Emits public/theme-init.js -- the render-blocking pre-paint theme script.
  // It is a served file rather than an inline <script> so the Content-Security-
  // Policy can stay script-src 'self' with no 'unsafe-inline' and no fragile hash.
  publicDir: resolve(__dirname, 'public'),
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: false
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': apiProxy,
      '/health': apiProxy,
      '/ready': apiProxy,
      '/system': apiProxy
    }
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true
  }
})
