// Run from apps/server: node <this> <outDir>. Builds the Remotion bundle and BB1's render props for the container spike.
import { cp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectSchema, episodeProps } from '@als/schema';
import { getTheme } from '@als/theme/themes';
import { SoundLibrary } from './src/media/sounds.ts';
import { RENDER_ENTRY } from './src/render/bundle.ts';

const out = process.argv[2];
const repo = new URL('../../', import.meta.url).pathname;
const projectDir = join(repo, 'projects/bb1-ea55');
const project = ProjectSchema.parse(JSON.parse(await readFile(join(projectDir, 'project.json'), 'utf8')));
const sounds = new SoundLibrary(join(repo, 'media/sounds'));
const origin = 'http://127.0.0.1:9000';
const fileUrl = (file: string) => `${origin}/files/${file}`;
const bank = Object.fromEntries(Object.entries(await sounds.bank()).map(([id, s]) => [id, { ...s, src: `${origin}/sounds/${s.src.split('/').pop()}` }]));
const { source } = project;
const props = {
  ...episodeProps({ ...project, characters: project.context.characters, durationSec: source.durationSec }, { src: fileUrl(source.file), theme: getTheme(project.themeId), fileUrl, sounds: bank }),
  fps: source.fps, width: source.width, height: source.height,
};
// Inputs the container fetches: local path under its work folder -> object key in R2.
const inputs = [
  { path: `files/${source.file}`, key: `bb1/${source.file}` },
  ...project.context.characters.flatMap((c) => (c.portrait ? [{ path: `files/${c.portrait}`, key: `bb1/${c.portrait}` }] : [])),
  ...Object.values(bank).map((s) => { const f = s.src.split('/').pop()!; return { path: `sounds/${f}`, key: `sounds/${f}` }; }),
];
await mkdir(out, { recursive: true });
await writeFile(join(out, 'props.json'), JSON.stringify(props));
await writeFile(join(out, 'inputs.json'), JSON.stringify(inputs, null, 2));
const { bundle } = await import('@remotion/bundler');
const built = await bundle({ entryPoint: RENDER_ENTRY, rootDir: join(repo, 'packages/composition') });
await cp(built, join(out, 'image/bundle'), { recursive: true });
console.log('version', project.version, 'theme', project.themeId, 'moments', project.moments.length, 'inputs', inputs.length, 'sounds', Object.keys(bank).length);
