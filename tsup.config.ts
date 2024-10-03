import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.js',
    'src/client/index.js',
  ],
  format: ['cjs', 'esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
})
