import type { CapacitorConfig } from '@capacitor/cli';

// The bundle ID and name are the iPhone trial's (spikes/capacitor-trial), the user's call (Nov 6): the free
// Personal Team already holds that ID, so this app installs over the trial. TODO(open-decision): a final ID and
// name with the paid Apple Developer account (PLAN-CLOUD.md, C5).
// No server.url: the app loads its own bundle (capacitor://localhost), the origin the API's CORS allows.
const config: CapacitorConfig = {
  appId: 'com.noahroy.alstrial',
  appName: 'ALS Trial',
  webDir: 'dist',
  ios: { contentInset: 'never' },
};

export default config;
