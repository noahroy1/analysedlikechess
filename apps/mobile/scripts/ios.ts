// Builds and runs the iPhone app (PLAN-CLOUD.md, C5).
//   node scripts/ios.ts build <staging|local>                       the web bundle for that backend, then `cap sync ios`
//   node scripts/ios.ts run <staging|local> [--simulator [<name>]]  build, then install and launch on the plugged-in
//                                                                  iPhone (default) or a simulator
// staging is the deployed backend (the phone's); local is `pnpm dev` on this Mac, which only the simulator reaches.
// The phone is signed by the free Personal Team in ios/App/App.xcodeproj; its builds stop opening after 7 days.
// CHECK_BRIDGE=<url> builds in the simulator checks' command bridge (scripts/sim-checks.mjs); never for the phone.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(APP_DIR, '../..');
const BUNDLE_ID = 'com.noahroy.alstrial';
const DEFAULT_SIMULATOR = 'iPhone 17';

const [command, target, ...rest] = process.argv.slice(2);
if (!['build', 'run'].includes(command ?? '') || !['staging', 'local'].includes(target ?? '')) {
  console.error('usage: node scripts/ios.ts <build|run> <staging|local> [--simulator [<name>]]');
  process.exit(2);
}
const simIndex = rest.indexOf('--simulator');
const simulator = simIndex >= 0 ? (rest[simIndex + 1] && !rest[simIndex + 1]!.startsWith('--') ? rest[simIndex + 1]! : DEFAULT_SIMULATOR) : undefined;
if (target === 'local' && command === 'run' && !simulator) {
  console.error('local needs --simulator: the phone cannot reach this Mac’s 127.0.0.1.');
  process.exit(2);
}

const sh = (cmd: string, args: string[], cwd = APP_DIR, env: Record<string, string> = {}) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
const out = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8' });

/** The backend's settings: staging's from apps/api (wrangler.jsonc and .env.staging), local's from what `pnpm dev` wrote. */
const bridge = process.env.CHECK_BRIDGE ?? '';
if (bridge && !simulator && command === 'run') {
  console.error('CHECK_BRIDGE is for simulator builds only.');
  process.exit(2);
}
const checks = { VITE_CHECK_BRIDGE: bridge, VITE_CHECK_HOOKS: bridge ? 'true' : 'false' };

async function backend(): Promise<Record<string, string>> {
  if (target === 'staging') {
    const { loadEnvironment } = await import(join(ROOT, 'apps/api/scripts/environments.ts'));
    const e = loadEnvironment('staging');
    return { VITE_ENV_NAME: 'staging', VITE_API_ORIGIN: e.apiOrigin, VITE_SUPABASE_URL: e.supabaseUrl, VITE_SUPABASE_PUBLISHABLE_KEY: e.publishableKey, ...checks };
  }
  const vars = new Map<string, string>();
  for (const line of readFileSync(join(ROOT, 'apps/web/.env.development.local'), 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) vars.set(m[1]!, m[2]!);
  }
  return {
    VITE_ENV_NAME: 'local',
    VITE_API_ORIGIN: 'http://127.0.0.1:8790',
    VITE_SUPABASE_URL: vars.get('VITE_SUPABASE_URL')!,
    VITE_SUPABASE_PUBLISHABLE_KEY: vars.get('VITE_SUPABASE_PUBLISHABLE_KEY')!,
    ...checks,
  };
}

sh('pnpm', ['exec', 'vite', 'build'], APP_DIR, await backend());
sh('pnpm', ['exec', 'cap', 'sync', 'ios']);
if (command === 'build') process.exit(0);

const derived = join(APP_DIR, 'ios/App/build');
const project = ['-project', join(APP_DIR, 'ios/App/App.xcodeproj'), '-scheme', 'App', '-configuration', 'Debug', '-derivedDataPath', derived];
if (simulator) {
  sh('xcodebuild', [...project, '-destination', `platform=iOS Simulator,name=${simulator}`, '-quiet', 'build']);
  try {
    sh('xcrun', ['simctl', 'boot', simulator]);
  } catch {
    // Already booted.
  }
  sh('open', ['-a', 'Simulator']);
  sh('xcrun', ['simctl', 'install', simulator, join(derived, 'Build/Products/Debug-iphonesimulator/App.app')]);
  sh('xcrun', ['simctl', 'launch', simulator, BUNDLE_ID]);
} else {
  // The first available iPhone that devicectl knows (paired, cable or Wi-Fi).
  const list = out('xcrun', ['devicectl', 'list', 'devices']);
  const line = list.split('\n').find((l) => /available/.test(l) && /iPhone/.test(l));
  const device = line?.match(/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/)?.[0];
  if (!device) {
    console.error('No available iPhone: plug it in, unlock it, and check `xcrun devicectl list devices`.');
    process.exit(1);
  }
  sh('xcodebuild', [...project, '-destination', 'generic/platform=iOS', '-allowProvisioningUpdates', '-quiet', 'build']);
  sh('xcrun', ['devicectl', 'device', 'install', 'app', '--device', device, join(derived, 'Build/Products/Debug-iphoneos/App.app')]);
  sh('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', device, BUNDLE_ID]);
}
