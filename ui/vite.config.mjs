import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `base: './'` because the built page is opened from `file://` inside Electron, where
// an absolute `/assets/...` resolves against the filesystem root and finds nothing.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
})
