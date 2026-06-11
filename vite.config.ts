import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        // Desktop renderer + the standalone 3D brain page the mobile gateway
        // serves to the companion app's WebView (/brain3d/).
        index: path.resolve(__dirname, 'index.html'),
        'brain-mobile': path.resolve(__dirname, 'brain-mobile.html'),
      },
    },
  },
  server: {
    port: 3000,
  },
});
