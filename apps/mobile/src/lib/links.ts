import { App as CapApp } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { parseAuthCallback } from './auth-callback.ts';
import { session } from './session.ts';

type Listener = (message: string) => void;
const errorListeners = new Set<Listener>();

/** Calls back when a sign-in link or OAuth sign-in came back with an error (or its code was refused). */
export function onSignInError(listener: Listener): () => void {
  errorListeners.add(listener);
  return () => errorListeners.delete(listener);
}

const seen = new Set<string>();

async function handle(url: string) {
  const callback = parseAuthCallback(url);
  if (!callback || seen.has(url)) return;
  seen.add(url);
  // An OAuth sign-in comes back while the in-app browser is still open over the app.
  void Browser.close().catch(() => undefined);
  if ('error' in callback) {
    for (const l of errorListeners) l(callback.error);
    return;
  }
  try {
    await session.exchangeCode(callback.code);
  } catch (error) {
    const message = (error as Error).message;
    // A link opened on another device, or asked for before the app was reinstalled, has no verifier here.
    const hint = /verifier/i.test(message) ? 'Open the link on the phone that asked for it, or ask for a new one.' : message;
    for (const l of errorListeners) l(hint);
  }
}

/** Signs in from the app's URL scheme: on a link while running, and on the link that launched it. */
export function listenForAuthLinks() {
  void CapApp.addListener('appUrlOpen', ({ url }) => void handle(url));
  void CapApp.getLaunchUrl().then((launch) => {
    if (launch?.url) void handle(launch.url);
  });
}
