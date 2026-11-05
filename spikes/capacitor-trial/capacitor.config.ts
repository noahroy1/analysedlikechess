import type { CapacitorConfig } from '@capacitor/cli';

// No server.url: the app loads its own bundle (capacitor://localhost), not a dev server.
const config: CapacitorConfig = {
  appId: 'com.noahroy.alstrial',
  appName: 'ALS Trial',
  webDir: 'dist',
};

export default config;
