import { resolve } from 'node:path';
import { build } from './bundle.ts';

// Builds the composition bundle into a folder, for the container image
// (MEDIA_BUNDLE_DIR points the service at it). Usage: node src/build-bundle.ts <dir>
const out = process.argv[2];
if (!out) throw new Error('usage: node src/build-bundle.ts <dir>');
console.log(`bundled into ${await build(resolve(out))}`);
