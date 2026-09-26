import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Served from GitHub Pages at /maker-arena/
export default defineConfig({
  plugins: [react()],
  base: process.env.PAGES_BASE ?? '/kalkan/',
})
