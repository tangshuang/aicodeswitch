import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import os from 'os';
import dotenv from 'dotenv';
import fs from 'fs';

export default defineConfig(({ mode }) => {
  const envPath = path.join(os.homedir(), '.aicodeswitch', 'aicodeswitch.conf');
  const env = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};
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
      port: 17808,
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
