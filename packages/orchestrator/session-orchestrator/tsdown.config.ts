import { defineConfig } from 'tsdown'

/** Bundle the compiled service entry; types come from the `tsc` project build. */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/remote.js', 'lib/types/runtime.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
