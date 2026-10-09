import { CLASSIFICATIONS } from '@als/schema';
import { useEffect, useState } from 'react';

type ServerStatus = 'checking' | 'up' | 'down';

export function App() {
  const [server, setServer] = useState<ServerStatus>('checking');

  useEffect(() => {
    fetch('/api/health')
      .then((res) => setServer(res.ok ? 'up' : 'down'))
      .catch(() => setServer('down'));
  }, []);

  return (
    <main className="min-h-screen bg-neutral-950 p-8 text-neutral-100">
      <h1 className="text-2xl font-semibold">Analysed Like Chess Studio</h1>
      <p className="mt-2 text-sm text-neutral-400">
        Server: <span className={server === 'up' ? 'text-emerald-400' : 'text-neutral-400'}>{server}</span>
      </p>
      <p className="mt-6 text-sm text-neutral-400">{CLASSIFICATIONS.length} classifications loaded from @als/schema.</p>
    </main>
  );
}
