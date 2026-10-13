// Prints the version of media-controls.js. With a git revision as argument it also fails
// when the script differs from that revision without a higher version, because installed
// apps take a published copy only when its version is higher than the one they have.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const file = 'media-controls.js';

const versionOf = source => {
    const end = source.startsWith('/*') ? source.indexOf('*/') : -1;
    const match = end < 0 ? null : source.slice(0, end).match(/^ \* @version (\d+)\.(\d+)\.(\d+)$/m);
    if (!match) throw new Error(`${file} must start with a comment containing " * @version MAJOR.MINOR.PATCH"`);
    return match.slice(1).map(Number);
};

const current = readFileSync(file, 'utf8');
const version = versionOf(current);
const base = process.argv[2];
if (base && !/^0+$/.test(base)) {
    let previous = null;
    try {
        previous = execFileSync('git', ['show', `${base}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {}
    if (previous !== null && previous !== current) {
        const old = versionOf(previous);
        const index = version.findIndex((part, i) => part !== old[i]);
        if (index < 0 || version[index] < old[index]) {
            console.error(`${file} changed since ${base} but its version ${version.join('.')} is not higher than ${old.join('.')}.`);
            process.exit(1);
        }
    }
}
console.log(`${file} ${version.join('.')}`);
