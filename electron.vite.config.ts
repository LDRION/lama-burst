import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    // Builds land here (package.json build.directories.output); the app checks it for updates.
    define: { __RELEASE_DIR__: JSON.stringify(resolve('release')) },
  },
  preload: {},
  renderer: {
    plugins: [react()],
    // Explicit IPv4 host: "localhost" may bind only to ::1, and 5173 is often taken by WSL/Docker.
    server: { host: '127.0.0.1', port: 5199 },
  },
});
