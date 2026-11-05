import { useEffect, useState } from 'react';
import { SignIn } from './components/SignIn.tsx';
import { useRoute } from './lib/router.ts';
import { session } from './lib/session.ts';
import { ProjectPage } from './pages/ProjectPage.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';

export function App() {
  const route = useRoute();
  // Against the Worker every page needs a signed-in user; the Node server has none.
  const [signedIn, setSignedIn] = useState<boolean | 'checking'>(session ? 'checking' : true);
  useEffect(() => session?.onChange((s) => setSignedIn(Boolean(s))), []);
  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      {signedIn === 'checking' ? null : !signedIn ? (
        <SignIn />
      ) : route.page === 'project' ? (
        <ProjectPage key={route.id} id={route.id} />
      ) : (
        <ProjectsPage />
      )}
    </main>
  );
}
