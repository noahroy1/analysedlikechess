/**
 * Whether the page exposes handles for the browser checks (`window.__alsPlayer`,
 * `__alsEditor`, `__alsSetLook`): the dev build, and a staging build
 * (`VITE_CHECK_HOOKS=true`, set by deploy.ts) so the checks can run against a
 * deployed environment. Never production.
 */
export const CHECK_HOOKS = import.meta.env.DEV || import.meta.env.VITE_CHECK_HOOKS === 'true';
