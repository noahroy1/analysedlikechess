import { useEffect, useState } from 'react';
import { useRoute } from './lib/router.ts';
import { session } from './lib/session.ts';
import { ProjectPage } from './pages/ProjectPage.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';
import { SignIn } from './pages/SignIn.tsx';

export function App() {
  const route = useRoute();
  const [signedIn, setSignedIn] = useState<boolean | 'checking'>('checking');
  useEffect(() => session.onChange((s) => setSignedIn(Boolean(s))), []);
  if (signedIn === 'checking') return null;
  if (!signedIn) return <SignIn />;
  return route.page === 'project' ? <ProjectPage key={route.id} id={route.id} /> : <ProjectsPage />;
}
