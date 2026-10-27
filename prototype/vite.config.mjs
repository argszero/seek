import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The prototype builds with the same two tools the window does, because it builds the same
 * files. `base: './'` is not a preference: Electron loads this page off `file://`, where a
 * root-absolute `/assets/…` resolves to the filesystem root and every script 404s.
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
})
