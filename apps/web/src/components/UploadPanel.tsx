import { UPLOAD_EXTENSIONS } from '@als/schema';
import { useRef, useState, type DragEvent } from 'react';
import { uploadClip } from '../lib/api.ts';
import { projectHref } from '../lib/router.ts';

const ACCEPT = UPLOAD_EXTENSIONS.map((ext) => `.${ext}`).join(',');

export function UploadPanel() {
  const input = useRef<HTMLInputElement>(null);
  const [movieTitle, setMovieTitle] = useState('');
  const [sceneNote, setSceneNote] = useState('');
  const [characters, setCharacters] = useState('');
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File | undefined) => {
    if (!file || progress !== null) return;
    setError(null);
    setProgress(0);
    try {
      const project = await uploadClip(
        file,
        { movieTitle: movieTitle.trim(), sceneNote: sceneNote.trim(), characters: characters.trim() },
        setProgress,
      );
      window.location.hash = projectHref(project.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProgress(null);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void upload(e.dataTransfer.files[0]);
  };

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-5">
      <h2 className="text-sm font-medium text-neutral-200">New project</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-neutral-400">
          Movie or show <span className="text-neutral-600">(optional)</span>
          <input
            value={movieTitle}
            onChange={(e) => setMovieTitle(e.target.value)}
            placeholder="Dexter"
            className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
        </label>
        <label className="block text-xs text-neutral-400">
          Scene note <span className="text-neutral-600">(optional)</span>
          <input
            value={sceneNote}
            onChange={(e) => setSceneNote(e.target.value)}
            placeholder="Doakes catches Dexter, season 2"
            className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
        </label>
        <label className="block text-xs text-neutral-400 sm:col-span-2">
          Characters <span className="text-neutral-600">(optional, comma-separated: helps name the speakers)</span>
          <input
            value={characters}
            onChange={(e) => setCharacters(e.target.value)}
            placeholder="Dexter, Doakes"
            className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
        </label>
      </div>

      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        disabled={progress !== null}
        className={`mt-4 flex w-full flex-col items-center justify-center rounded-lg border border-dashed px-4 py-10 text-center transition-colors ${
          dragging ? 'border-sky-400 bg-sky-950/30' : 'border-neutral-700 hover:border-neutral-500'
        }`}
      >
        {progress === null ? (
          <>
            <span className="text-sm text-neutral-200">Drop a scene clip here, or click to choose</span>
            <span className="mt-1 text-xs text-neutral-500">
              {UPLOAD_EXTENSIONS.map((e) => e.toUpperCase()).join(', ')} · up to about 10 minutes
            </span>
          </>
        ) : (
          <div className="w-full max-w-xs">
            <span className="text-sm text-neutral-200">
              {progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : 'Reading video…'}
            </span>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-neutral-800">
              <div className="h-full bg-sky-400" style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
        )}
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          void upload(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </section>
  );
}
