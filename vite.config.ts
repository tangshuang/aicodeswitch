import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    base: './',
    build: {
      outDir: 'dist/ui',
      emptyOutDir: true,
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './ui'),
      },
    },
    server: {
      port: env.PORT ? parseInt(env.PORT) + 1 : 4568,
      proxy: {
        '/api': {
          target: `http://${env.HOST || '127.0.0.1'}:${env.PORT || 4567}`,
          changeOrigin: true,
          ws: true, // 启用 WebSocket 代理支持
        },
      },
    },
  };
});
