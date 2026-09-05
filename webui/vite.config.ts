/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // base "./"：产物同时兼容 web 与 Electron file:// 加载（GUI 复用同一 dist）
  base: "./",
  plugins: [react()],
  // vitest：render.ts 是纯 TS 渲染助手（无 DOM），用 node 环境即可。
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
