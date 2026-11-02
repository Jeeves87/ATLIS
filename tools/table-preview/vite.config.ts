// Dev-only: renders the game table from recorded Forge states, no Electron.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve(__dirname, '../../src/renderer/src') } },
  server: { port: 5199, strictPort: true, fs: { allow: [resolve(__dirname, '../..')] } }
})
