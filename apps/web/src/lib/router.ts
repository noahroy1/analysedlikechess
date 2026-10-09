import { useSyncExternalStore } from 'react';

// Hash routing: two screens don't justify a router dependency.

export type Route = { page: 'projects' } | { page: 'project'; id: string };

function parse(hash: string): Route {
  const match = /^#\/projects\/([^/]+)$/.exec(hash);
  return match ? { page: 'project', id: decodeURIComponent(match[1]!) } : { page: 'projects' };
}

const subscribe = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parse(hash);
}

export const projectHref = (id: string) => `#/projects/${encodeURIComponent(id)}`;
export const projectsHref = '#/';
