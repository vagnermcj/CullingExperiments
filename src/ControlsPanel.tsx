import { useEffect } from 'react'
import { Leva, folder, monitor, useControls } from 'leva'
import type { OrthographicCamera } from 'three'
import type { PerfSnapshot } from './performance'
import type { CadSettings, CadStats } from './cad/types'
import type { BoxView } from './gpu/renderer'
import { CULLING_MODES, cullingConfig, usesFrustum, usesOcclusion } from './cad/cullingHooks'

const MB = 2 ** 20

interface ControlsPanelProps {
  perfRef: { current: PerfSnapshot }
  topCameraRef: { current: OrthographicCamera | null }
  topViewConfigRef: { current: { enabled: boolean } }
  boxViewRef: { current: { view: BoxView; onTop: boolean } }
  pyramidViewRef: { current: { mip: number } }
  cadSettings: CadSettings
  cadStats: CadStats
}

const readout = (value = '–') => ({ value, disabled: true })

const int = (n: number) => Math.round(n).toLocaleString('en-US')
const ms = (n: number) => `${n.toFixed(2)} ms`
const fps = (n: number) => n.toFixed(1)
const mb = (bytes: number) => `${(bytes / MB).toFixed(1)} MB`
const count = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)} k` : int(n)

const PANEL_REFRESH_MS = 250

export const ControlsPanel = ({
  perfRef,
  topCameraRef,
  topViewConfigRef,
  boxViewRef,
  pyramidViewRef,
  cadSettings,
  cadStats,
}: ControlsPanelProps) => {
  const [, setPerf] = useControls(
    'Performance',
    () => ({
      frameGraph: monitor(() => perfRef.current.frameMs, { graph: true, interval: 50 }),
      Frame: folder({
        fps: readout(),
        frameTime: readout(),
        gpuTime: readout(),
        fps1Low: readout(),
        fps01Low: readout(),
        worstFrame: readout(),
      }),
      'CPU time': folder(
        {
          updateTime: readout(),
          renderTime: readout(),
        },
        { collapsed: true },
      ),
      'Main view': folder({
        drawCalls: readout(),
        triangles: readout(),
        culled: readout(),
        occluded: readout(),
        cullPass: readout(),
      }),
      HLOD: folder({
        dataset: readout(),
        selected: readout(),
        drawnByTier: readout(),
        resident: readout(),
        loads: readout(),
        visited: readout(),
      }),
      Memory: folder(
        {
          gpuTotal: readout(),
          jsHeap: readout(),
        },
        { collapsed: true },
      ),
    }),
    [],
  )

  // Push a fresh snapshot into the panel at a low rate; setting Leva values every frame is costly.
  useEffect(() => {
    const push = () => {
      const p = perfRef.current
      const c = cadStats
      setPerf({
        fps: fps(p.fps),
        frameTime: ms(p.frameMs),
        gpuTime: p.gpuMs > 0 ? ms(p.gpuMs) : 'n/a',
        fps1Low: fps(p.fps1Low),
        fps01Low: fps(p.fps01Low),
        worstFrame: ms(p.worstFrameMs),
        updateTime: ms(p.updateMs),
        renderTime: ms(p.renderMs),
        drawCalls: `${int(p.drawCalls)} visible / ${int(p.issuedDraws)} issued`,
        triangles: count(p.triangles),
        culled: `${int(Math.max(0, p.selectedDraws - p.drawCalls))} of ${int(p.selectedDraws)} selected (${
          p.selectedDraws > 0
            ? ((Math.max(0, p.selectedDraws - p.drawCalls) / p.selectedDraws) * 100).toFixed(0)
            : '0'
        }%)`,
        occluded: `${int(p.occludedDraws)} by Hi-Z`,
        cullPass: p.cullGpuMs > 0 ? `${p.cullGpuMs.toFixed(3)} ms GPU` : 'n/a',
        dataset: `${count(c.datasetCells)} cells · ${count(c.datasetTriangles)} tris`,
        selected: `${int(c.selectedCells)} cells · ${count(c.selectedTriangles)} tris`,
        drawnByTier: `${int(c.cellsRaw)} raw · ${int(c.cellsLod1)} lod1 · ${int(c.cellsLod2)} lod2`,
        resident: `${int(c.residentCells)} cells · ${count(c.residentTriangles)} tris · ${mb(c.residentBytes)}`,
        loads: `${int(c.pendingLoads)} pending · ${int(c.failedLoads)} failed`,
        visited: int(c.visitedCells),
        gpuTotal: mb(p.gpuTotalBytes),
        jsHeap: p.jsHeapBytes === null ? 'n/a' : mb(p.jsHeapBytes),
      })
    }
    const id = window.setInterval(push, PANEL_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [setPerf, perfRef, cadStats])

  const [topViewValues] = useControls('Top View', () => ({
    enabled: false,
    height: { value: 150, min: 5, max: 300, step: 1 },
    extent: { value: 175, min: 5, max: 250, step: 1 },
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

  const [cadValues] = useControls('CAD', () => ({
    triangleBudget: {
      value: cadSettings.triangleBudget / 1e6,
      min: 0.1,
      max: 20,
      step: 0.1,
      label: 'budget (M tris)',
    },
    minScreenPixels: {
      value: cadSettings.minScreenPixels,
      min: 1,
      max: 50,
      step: 1,
      label: 'min size (px)',
    },
    lod2BelowPixels: {
      value: cadSettings.lod2BelowPixels,
      min: 1,
      max: 300,
      step: 1,
      label: 'lod2 below (px)',
    },
    lod1BelowPixels: {
      value: cadSettings.lod1BelowPixels,
      min: 1,
      max: 600,
      step: 1,
      label: 'lod1 below (px)',
    },
    maxResidentMB: {
      value: cadSettings.maxResidentMB,
      min: 200,
      max: 6000,
      step: 100,
      label: 'resident cap (MB)',
    },
    frozen: { value: cadSettings.frozen, label: 'freeze selection' },
  }))

  useEffect(() => {
    cadSettings.triangleBudget = cadValues.triangleBudget * 1e6
    cadSettings.minScreenPixels = cadValues.minScreenPixels
    cadSettings.lod2BelowPixels = cadValues.lod2BelowPixels
    cadSettings.lod1BelowPixels = cadValues.lod1BelowPixels
    cadSettings.maxResidentMB = cadValues.maxResidentMB
    cadSettings.frozen = cadValues.frozen
  }, [cadValues, cadSettings])

  const [cullingValues, setCulling] = useControls('Culling', () => ({
    technique: readout(),
    freezeFrustum: { value: cullingConfig.freeze, label: 'freeze culling frustum' },
    boxView: {
      value: boxViewRef.current.view,
      options: {
        Off: 'off',
        'Drawn cells': 'drawn',
        'Selected (drawn + culled)': 'selected',
        'All resident': 'resident',
      } satisfies Record<string, BoxView>,
      label: 'bounding boxes',
    },
    boxesOnTop: { value: boxViewRef.current.onTop, label: 'boxes on top' },
    // Levels past the last one show the last one (1x1).
    pyramidMip: {
      value: pyramidViewRef.current.mip,
      min: -1,
      max: 12,
      step: 1,
      label: 'Hi-Z level (-1 off)',
    },
  }))

  // The technique is chosen in the Benchmark panel; showing it here makes it obvious when the GPU test is off.
  useEffect(() => {
    const id = window.setInterval(() => {
      const label =
        CULLING_MODES.find((m) => m.id === cullingConfig.mode)?.label ?? cullingConfig.mode
      setCulling({
        technique: `${label} (frustum ${usesFrustum(cullingConfig.mode) ? 'ON' : 'OFF'}, occlusion ${
          usesOcclusion(cullingConfig.mode) ? 'ON' : 'OFF'
        })`,
      })
    }, PANEL_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [setCulling])

  useEffect(() => {
    cullingConfig.freeze = cullingValues.freezeFrustum
    boxViewRef.current.view = cullingValues.boxView as BoxView
    boxViewRef.current.onTop = cullingValues.boxesOnTop
    pyramidViewRef.current.mip = cullingValues.pyramidMip
  }, [cullingValues, boxViewRef, pyramidViewRef])

  return (
    <Leva
      fill
      flat
      titleBar={{ title: 'Culling Controls', drag: true, filter: false }}
      hideCopyButton
    />
  )
}
