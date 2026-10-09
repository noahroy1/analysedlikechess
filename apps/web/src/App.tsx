import { useRoute } from './lib/router.ts';
import { ProjectPage } from './pages/ProjectPage.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';

export function App() {
  const route = useRoute();
  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      {route.page === 'project' ? <ProjectPage key={route.id} id={route.id} /> : <ProjectsPage />}
    </main>
  );
}
