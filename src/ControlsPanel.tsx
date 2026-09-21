import { useEffect } from 'react'
import { Leva, folder, monitor, useControls } from 'leva'
import type { OrthographicCamera } from 'three'
import type { PerfSnapshot } from './performance'
import type { ForestScene } from './forestScene'

const MB = 2 ** 20

interface ControlsPanelProps {
  perfRef: { current: PerfSnapshot }
  topCameraRef: { current: OrthographicCamera | null }
  topViewConfigRef: { current: { enabled: boolean } }
  forest: ForestScene
}

const readout = (value = '–') => ({ value, disabled: true })

const int = (n: number) => Math.round(n).toLocaleString('en-US')
const ms = (n: number) => `${n.toFixed(2)} ms`
const fps = (n: number) => n.toFixed(1)
const mb = (bytes: number) => `${(bytes / MB).toFixed(1)} MB`
const count = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)} k` : int(n))

const PANEL_REFRESH_MS = 250

export const ControlsPanel = ({ perfRef, topCameraRef, topViewConfigRef, forest }: ControlsPanelProps) => {
  const [, setPerf] = useControls(
    'Performance',
    () => ({
      frameGraph: monitor(() => perfRef.current.frameMs, { graph: true, interval: 50 }),
      Frame: folder({
        fps: readout(),
        frameTime: readout(),
        fps1Low: readout(),
        fps01Low: readout(),
        worstFrame: readout(),
      }),
      'CPU time': folder(
        {
          updateTime: readout(),
          renderTime: readout(),
          minimapTime: readout(),
        },
        { collapsed: true },
      ),
      'Main view': folder({
        drawCalls: readout(),
        triangles: readout(),
        linesPoints: readout(),
        minimapPass: readout(),
      }),
      'Culling candidates': folder({
        loadedMeshes: readout(),
        candidateMeshes: readout(),
        loadedTriangles: readout(),
        candidateTriangles: readout(),
        culledByFrustum: readout(),
      }),
      Memory: folder(
        {
          gpuTotal: readout(),
          gpuTextures: readout(),
          gpuGeometry: readout(),
          geometries: readout(),
          textures: readout(),
          programs: readout(),
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
      setPerf({
        fps: fps(p.fps),
        frameTime: ms(p.frameMs),
        fps1Low: fps(p.fps1Low),
        fps01Low: fps(p.fps01Low),
        worstFrame: ms(p.worstFrameMs),
        updateTime: ms(p.updateMs),
        renderTime: ms(p.renderMs),
        minimapTime: ms(p.minimapMs),
        drawCalls: int(p.drawCalls),
        triangles: count(p.triangles),
        linesPoints: `${int(p.lines)} / ${int(p.points)}`,
        minimapPass: `${int(p.minimapDrawCalls)} calls · ${count(p.minimapTriangles)} tris`,
        loadedMeshes: int(p.loadedMeshes),
        candidateMeshes: int(p.candidateMeshes),
        loadedTriangles: count(p.loadedTriangles),
        candidateTriangles: count(p.candidateTriangles),
        culledByFrustum: `${p.culledTrianglesPct.toFixed(1)}%`,
        gpuTotal: mb(p.gpuTotalBytes),
        gpuTextures: mb(p.gpuTexturesBytes),
        gpuGeometry: mb(p.gpuGeometryBytes),
        geometries: int(p.geometries),
        textures: int(p.textures),
        programs: int(p.programs),
        jsHeap: p.jsHeapBytes === null ? 'n/a' : mb(p.jsHeapBytes),
      })
    }
    const id = window.setInterval(push, PANEL_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [setPerf, perfRef])

  const [topViewValues] = useControls('Top View', () => ({
    enabled: true,
    height: { value: 150, min: 5, max: 300, step: 1 },
    extent: { value: 200, min: 5, max: 250, step: 1 },
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

  const [forestValues] = useControls('Forest', () => ({
    trees: { value: 1000, min: 0, max: 20000, step: 100 },
    walls: true,
  }))

  useEffect(() => {
    forest.setTreeCount(forestValues.trees)
    forest.setWalls(forestValues.walls)
  }, [forestValues, forest])

  return (
    <Leva
      fill
      flat
      titleBar={{ title: 'Culling Controls', drag: true, filter: false }}
      hideCopyButton
    />
  )
}
