import { useEffect } from 'react'
import { Leva, useControls } from 'leva'
import type { TilesRenderer } from '3d-tiles-renderer'
import type { DebugTilesPlugin } from '3d-tiles-renderer/plugins'
import type { OrthographicCamera } from 'three'

const GIGABYTE = 2 ** 30

interface StatsSnapshot {
  visibleTiles: number
  activeTiles: number
  loadProgress: number
  tileStatsLabel: string
}

interface ControlsPanelProps {
  tilesRef: { current: TilesRenderer | null }
  statsRef: { current: StatsSnapshot }
  topCameraRef: { current: OrthographicCamera | null }
  topViewConfigRef: { current: { enabled: boolean } }
}


export const ControlsPanel = ({
  tilesRef,
  statsRef,
  topCameraRef,
  topViewConfigRef,
}: ControlsPanelProps) => {
  const [tilesValues, setTiles] = useControls(
    'Tiles',
    () => ({
      errorTarget: { value: 500, min: 0, step: 0.5 },
      maxTilesProcessed: { value: 250, min: 1, step: 10 },
      displayActiveTiles: false,
      displayBBox: true,
    }),
    [],
  )

  const [cacheValues, setCache] = useControls(
    'LRU Cache',
    () => ({
      minSize: { value: 6000, min: 0, max: 50000, step: 1 },
      maxSize: { value: 8000, min: 0, max: 50000, step: 1 },
      minBytesSize: { value: 0.3 * GIGABYTE, min: 0, max: 2 * GIGABYTE, step: 1 },
      maxBytesSize: { value: 0.4 * GIGABYTE, min: 0, max: 2 * GIGABYTE, step: 1 },
      unloadPercent: { value: 0.05, min: 0, max: 1, step: 0.05 },
      autoMarkUnused: true,
    }),
    { collapsed: true },
    [],
  )

  const [queueValues, setQueues] = useControls(
    'Priority Queues',
    () => ({
      downloadMaxJobs: { value: 6, min: 1, step: 1 },
      parseMaxJobs: { value: 6, min: 1, step: 1 },
      processMaxJobs: { value: 6, min: 1, step: 1 },
    }),
    { collapsed: true },
    [],
  )

  const [, setStats] = useControls(
    'Stats',
    () => ({
      visibleTiles: { value: 0, disabled: true },
      activeTiles: { value: 0, disabled: true },
      loadProgress: { value: '0%', disabled: true },
      tileStats: { value: 'Tiles: loading…', disabled: true },
    }),
    { collapsed: true },
    [],
  )

  // Write Leva values back to the current tiles renderer.
  useEffect(() => {
    const tiles = tilesRef.current
    if (!tiles) return
    tiles.errorTarget = tilesValues.errorTarget
    tiles.maxTilesProcessed = tilesValues.maxTilesProcessed
    tiles.displayActiveTiles = tilesValues.displayActiveTiles
    const debugPlugin = tiles.getPluginByName('DEBUG_TILES_PLUGIN') as DebugTilesPlugin | undefined
    if (debugPlugin) {
      debugPlugin.enabled = tilesValues.displayBBox
      debugPlugin.displayBoxBounds = tilesValues.displayBBox
    }
  }, [tilesValues, tilesRef])

  useEffect(() => {
    const tiles = tilesRef.current
    if (!tiles) return
    const cache = tiles.lruCache
    cache.minSize = cacheValues.minSize
    cache.maxSize = cacheValues.maxSize
    cache.minBytesSize = cacheValues.minBytesSize
    cache.maxBytesSize = cacheValues.maxBytesSize
    cache.unloadPercent = cacheValues.unloadPercent
    cache.autoMarkUnused = cacheValues.autoMarkUnused
  }, [cacheValues, tilesRef])

  useEffect(() => {
    const tiles = tilesRef.current
    if (!tiles) return
    tiles.downloadQueue.maxJobs = queueValues.downloadMaxJobs
    tiles.parseQueue.maxJobs = queueValues.parseMaxJobs
    tiles.processNodeQueue.maxJobs = queueValues.processMaxJobs
  }, [queueValues, tilesRef])

  // When a new tiles renderer is swapped in, refresh the panel defaults.
  useEffect(() => {
    const tiles = tilesRef.current
    if (!tiles) return
    const cache = tiles.lruCache
    const debugPlugin = tiles.getPluginByName('DEBUG_TILES_PLUGIN') as DebugTilesPlugin | undefined
    setTiles({
      errorTarget: tiles.errorTarget,
      maxTilesProcessed: tiles.maxTilesProcessed,
      displayActiveTiles: tiles.displayActiveTiles,
      displayBBox: debugPlugin?.enabled ?? false,
    })
    setCache({
      minSize: cache.minSize,
      maxSize: cache.maxSize,
      minBytesSize: cache.minBytesSize,
      maxBytesSize: cache.maxBytesSize,
      unloadPercent: cache.unloadPercent,
      autoMarkUnused: cache.autoMarkUnused,
    })
    setQueues({
      downloadMaxJobs: tiles.downloadQueue.maxJobs,
      parseMaxJobs: tiles.parseQueue.maxJobs,
      processMaxJobs: tiles.processNodeQueue.maxJobs,
    })
  }, [tilesRef.current, setTiles, setCache, setQueues, tilesRef])

  // Push live stats into the Leva panel each frame.
  useEffect(() => {
    let rafId = 0
    const update = () => {
      const s = statsRef.current
      setStats({
        visibleTiles: s.visibleTiles,
        activeTiles: s.activeTiles,
        loadProgress: `${s.loadProgress}%`,
        tileStats: s.tileStatsLabel,
      })
      rafId = requestAnimationFrame(update)
    }
    rafId = requestAnimationFrame(update)
    return () => cancelAnimationFrame(rafId)
  }, [setStats, statsRef])

  const [topViewValues] = useControls('Top View', () => ({
    enabled: true,
    height: { value: 40, min: 5, max: 200, step: 1 },
    extent: { value: 8, min: 1, max: 50, step: 1 },
  }))

  useEffect(() => {
    topViewConfigRef.current.enabled = topViewValues.enabled
    const cam = topCameraRef.current
    if (!cam) return
    cam.position.y = topViewValues.height
    cam.left = -topViewValues.extent
    cam.right = topViewValues.extent
    cam.top = topViewValues.extent
    cam.bottom = -topViewValues.extent
    cam.updateProjectionMatrix()
  }, [topViewValues, topCameraRef, topViewConfigRef])

  return (
    <Leva
      fill
      flat
      titleBar={{ title: 'Tiles Controls', drag: true, filter: false }}
      hideCopyButton
    />
  )
}
