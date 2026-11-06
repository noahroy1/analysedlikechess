import { AUTH_REDIRECT } from './config.ts';
import { api } from './api.ts';
import { session } from './session.ts';
import { getUpload, subscribeUpload, upload } from './upload.ts';

/**
 * Simulator checks only (`scripts/sim-checks.mjs`; built in when `CHECK_BRIDGE` is set, never in a phone
 * build): the app asks the check's server on this Mac for the next snippet, runs it, and posts the result,
 * since a WKWebView in the simulator has no DevTools protocol to drive it with.
 */
export function startCheckBridge(base: string) {
  Object.assign(window, { __als: { api, session, upload, getUpload, subscribeUpload, AUTH_REDIRECT } });
  const run = async () => {
    for (;;) {
      try {
        const res = await fetch(`${base}/next`);
        if (res.status === 200) {
          const { id, js } = (await res.json()) as { id: string; js: string };
          let result: unknown;
          let error: string | undefined;
          try {
            result = await (0, eval)(`(async () => { ${js} })()`);
          } catch (e) {
            error = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
          }
          await fetch(`${base}/result`, { method: 'POST', body: JSON.stringify({ id, result, error }) });
          continue;
        }
      } catch {
        // The check is not running: try again shortly.
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  void run();
}
