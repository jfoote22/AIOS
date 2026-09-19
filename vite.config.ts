import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: 'aios-production-csp',
    apply: 'build',
    transformIndexHtml: () => [{
      tag: 'meta', injectTo: 'head-prepend',
      attrs: { 'http-equiv': 'Content-Security-Policy', content: [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data:",
        "connect-src 'self' http://127.0.0.1:* https://api.github.com",
        "worker-src 'self' blob:",
        "media-src 'self' data: blob:",
        "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'",
      ].join('; ') },
    }],
  }],
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
