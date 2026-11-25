// Mark the CLI executable after tsc (which doesn't keep the bit). Windows has no executable
// bit: npm's .cmd shim runs it through node there, so there's nothing to do.
import { chmodSync } from 'node:fs';

if (process.platform !== 'win32') chmodSync(new URL('../dist/bin/cli.js', import.meta.url), 0o755);
