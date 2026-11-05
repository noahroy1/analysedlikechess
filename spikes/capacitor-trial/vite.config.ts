import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Relative base: the app loads from capacitor://localhost/ inside the iOS bundle.
export default defineConfig({
  base: './',
  plugins: [react()],
  define: { __REPORT_URL__: JSON.stringify(process.env.REPORT_URL ?? '') },
  build: { target: 'es2022' },
});
