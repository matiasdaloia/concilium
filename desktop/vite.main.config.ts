import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // Externalize nodejs-whisper to prevent bundling
      // This is necessary because nodejs-whisper uses __dirname to locate
      // its whisper.cpp binary and models, which breaks when bundled
      external: ['nodejs-whisper'],
    },
  },
});
