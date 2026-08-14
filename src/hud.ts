import type { HudElements } from './types'

export const initHud = (): HudElements => {
  const canvas = document.querySelector<HTMLCanvasElement>('#viewer-canvas')

  if (!canvas) {
    throw new Error('Viewer canvas not found')
  }

  return { canvas }
}
