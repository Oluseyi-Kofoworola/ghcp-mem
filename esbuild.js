/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * esbuild bundler for the VS Code extension.
 *
 * Why: shipping ~30 individual .js files inflates the VSIX, slows extension
 * activation (Node has to find/parse each module), and exposes internal
 * module structure. Bundling collapses everything into one file per entry
 * point and lets us tree-shake unused exports.
 *
 * Two entries:
 *   - src/extension.ts   → out/extension.js  (the VS Code activation entry)
 *   - src/mcpServer.ts   → out/mcpServer.js  (the standalone stdio MCP server
 *                                             exposed via `bin` in package.json)
 *
 * `vscode` is the only marked-external module — VS Code injects it at
 * runtime. Everything else (including node-builtin shims) is bundled.
 *
 * Run:  node esbuild.js                       # dev (sourcemaps, no minify)
 *       node esbuild.js --production          # release build
 *       node esbuild.js --watch               # incremental rebuild
 */

const esbuild = require('esbuild');

const isProd  = process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const baseOpts = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: isProd ? false : 'inline',
  minify: isProd,
  logLevel: 'info',
  // `require('../package.json')` in mcpServer.ts becomes an inlined object.
  loader: { '.json': 'json' },
};

const entries = [
  { entryPoints: ['src/extension.ts'], outfile: 'out/extension.js' },
  // The MCP server keeps its shebang at the top of the source file and
  // esbuild preserves it in the output so the bin link stays executable.
  { entryPoints: ['src/mcpServer.ts'], outfile: 'out/mcpServer.js' },
];

async function run() {
  if (isWatch) {
    const ctxs = await Promise.all(entries.map(e => esbuild.context({ ...baseOpts, ...e })));
    await Promise.all(ctxs.map(c => c.watch()));
    console.log('[esbuild] watching for changes...');
    return;
  }
  await Promise.all(entries.map(e => esbuild.build({ ...baseOpts, ...e })));
  console.log(`[esbuild] built ${entries.length} bundle(s) (${isProd ? 'production' : 'dev'}).`);
}

run().catch(err => {
  console.error('[esbuild] build failed:', err);
  process.exit(1);
});
