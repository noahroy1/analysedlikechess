import { useState } from 'react';
import { addCharacter, assignSpeaker, deleteCharacter, mergeCharacters, renameCharacter } from '../../editor/doc.ts';
import { useEditor, useEditorStore } from '../../editor/context.tsx';

/** Rename, merge and reassign speakers. Names flow through to every card. */
export function CharactersPanel() {
  const store = useEditorStore();
  const characters = useEditor((s) => s.doc.characters);
  const moments = useEditor((s) => s.doc.moments);
  const transcript = useEditor((s) => s.project.transcript);
  const [newName, setNewName] = useState('');
  const edit = store.getState().edit;

  const speakers = [...new Set(transcript?.utterances.map((u) => u.speaker) ?? [])];
  const sampleLine = (label: string) => transcript?.utterances.find((u) => u.speaker === label)?.text;
  const ownerOf = (label: string) => characters.find((c) => c.speakerLabels.includes(label));

  return (
    <div className="space-y-5 text-sm" data-testid="characters-panel">
      <section>
        <h3 className="mb-2 text-[11px] font-medium tracking-wide text-neutral-400 uppercase">Characters</h3>
        {characters.length === 0 && <p className="text-xs text-neutral-500">No characters yet.</p>}
        <ul className="space-y-2">
          {characters.map((c) => {
            const moveCount = moments.filter((m) => m.actorId === c.id).length;
            return (
              <li key={c.id} className="rounded-md border border-neutral-800 p-2">
                <div className="flex items-center gap-2">
                  <input
                    value={c.name}
                    aria-label="Character name"
                    onChange={(e) => edit((d) => renameCharacter(d, c.id, e.target.value), { coalesce: `${c.id}.name` })}
                    className="input flex-1 py-1"
                  />
                  <button
                    type="button"
                    title="Remove character"
                    onClick={() => edit((d) => deleteCharacter(d, c.id))}
                    className="text-neutral-500 hover:text-red-300"
                  >
                    ✕
                  </button>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-neutral-500">
                  {c.speakerLabels.map((label) => (
                    <span key={label} className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300">
                      Speaker {label}
                    </span>
                  ))}
                  <span>
                    {moveCount} move{moveCount === 1 ? '' : 's'}
                  </span>
                  {characters.length > 1 && (
                    <select
                      value=""
                      aria-label={`Merge ${c.name} into`}
                      onChange={(e) => e.target.value && edit((d) => mergeCharacters(d, c.id, e.target.value))}
                      className="ml-auto rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-[11px] text-neutral-300"
                    >
                      <option value="">Merge into…</option>
                      {characters
                        .filter((o) => o.id !== c.id)
                        .map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name || 'Unnamed'}
                          </option>
                        ))}
                    </select>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newName.trim()) return;
            edit((d) => addCharacter(d, newName.trim()));
            setNewName('');
          }}
        >
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Add a character" className="input flex-1 py-1" />
          <button type="submit" className="rounded-md border border-neutral-700 px-2 text-xs text-neutral-200 hover:border-neutral-500">
            Add
          </button>
        </form>
      </section>

      <section>
        <h3 className="mb-2 text-[11px] font-medium tracking-wide text-neutral-400 uppercase">Speakers in the transcript</h3>
        {speakers.length === 0 ? (
          <p className="text-xs text-neutral-500">Speaker labels appear once the clip is transcribed.</p>
        ) : (
          <ul className="space-y-2">
            {speakers.map((label) => (
              <li key={label} className="text-xs">
                <div className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-neutral-300">Speaker {label}</span>
                  <select
                    value={ownerOf(label)?.id ?? ''}
                    aria-label={`Speaker ${label} is`}
                    onChange={(e) => edit((d) => assignSpeaker(d, label, e.target.value || null))}
                    className="input flex-1 py-1 text-xs"
                  >
                    <option value="">Unassigned</option>
                    {characters.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name || 'Unnamed'}
                      </option>
                    ))}
                  </select>
                </div>
                {sampleLine(label) && <p className="mt-0.5 truncate pl-22 text-neutral-500 italic">“{sampleLine(label)}”</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
