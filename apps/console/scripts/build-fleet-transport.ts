import { resolve } from "node:path";
const result = await Bun.build({ entrypoints: [resolve('scripts/fleet-transport.ts')], outdir: resolve('.fleet-dist'),
  naming: 'transport.mjs', target: 'node', format: 'esm' });
if (!result.success) { console.error(result.logs); process.exit(1); }
