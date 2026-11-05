// Finds an installed package the way Node does from this checkout (repo-root install, workspace parent, or Arc's pre-install), never by a fixed path.
import {createRequire} from 'node:module';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
const require = createRequire(import.meta.url);
export function pkgDir(name) {
  let dir; try { dir = dirname(require.resolve(name)); } catch { return null; }
  let best = null;                                   // the OUTERMOST directory whose package.json has this name (some packages nest a stub in dist/)
  for (;;) {
    const f = join(dir, 'package.json');
    if (existsSync(f)) { try { if (JSON.parse(readFileSync(f, 'utf8')).name === name) best = dir; } catch { /* keep walking */ } }
    const up = dirname(dir); if (up === dir) return best; dir = up;
  }
}
export const pkgFile = (name, rel) => join(pkgDir(name), rel);
export const pkgVersion = name => JSON.parse(readFileSync(pkgFile(name, 'package.json'), 'utf8')).version;
export const resolvePkg = name => require.resolve(name);
