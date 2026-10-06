import { cpSync, existsSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'

// The CAD dataset is multi-GB, so `public/` is copied into the build by hand, minus `data/cad`.
const copyPublicWithoutCadData = (): Plugin => {
  let outDir = 'dist'
  return {
    name: 'copy-public-without-cad-data',
    apply: 'build',
    config: () => ({ build: { copyPublicDir: false } }),
    configResolved: (config) => {
      outDir = config.build.outDir
    },
    closeBundle: () => {
      if (!existsSync('public')) return
      cpSync('public', outDir, {
        recursive: true,
        filter: (source) => !source.replaceAll('\\', '/').endsWith('data/cad'),
      })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [copyPublicWithoutCadData()],
})
