// Writes src/features/legal/licenses.json: every package the app ships with
// (package.json dependencies, not dev tools), its version and its licence, read
// from the installed copy. Run `pnpm licenses` after adding or upgrading one.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const app = read(join(root, 'package.json'));
// pnpm hoists most packages to the workspace root.
const installed = (name) =>
  [join(root, 'node_modules'), join(root, '..', '..', 'node_modules')]
    .map((dir) => join(dir, name, 'package.json'))
    .find(existsSync);

const licenses = Object.keys(app.dependencies)
  .filter((name) => !name.startsWith('@nem/'))
  .sort()
  .map((name) => {
    const path = installed(name);
    if (!path) throw new Error(`${name} is not installed; run pnpm install`);
    const pkg = read(path);
    const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type;
    if (!license) throw new Error(`${name} declares no licence`);
    return { name, version: pkg.version, license };
  });

writeFileSync(
  new URL('../src/features/legal/licenses.json', import.meta.url),
  `${JSON.stringify(licenses, null, 2)}\n`,
);
console.log(`${licenses.length} packages`);
