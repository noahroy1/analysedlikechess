import { useEffect, useState } from 'react';

export type Route = { page: 'projects' } | { page: 'project'; id: string };

export const projectsHref = '#/';
export const projectHref = (id: string) => `#/p/${encodeURIComponent(id)}`;

function parse(hash: string): Route {
  const m = /^#\/p\/([^/]+)$/.exec(hash);
  return m ? { page: 'project', id: decodeURIComponent(m[1]!) } : { page: 'projects' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
