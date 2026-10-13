import type { BenchmarkRun } from './types'

const KEY = 'culling-benchmarks-v1'

const read = (): BenchmarkRun[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(parsed) ? (parsed as BenchmarkRun[]) : []
  } catch {
    return []
  }
}

/** Saved runs, newest first, kept in localStorage. `getSnapshot` is stable between changes (for useSyncExternalStore). */
class BenchmarkStorage {
  private runs: BenchmarkRun[] = read().sort((a, b) => b.createdAt - a.createdAt)
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): BenchmarkRun[] => this.runs

  /** Returns an error message, or null when saved. */
  save(run: BenchmarkRun): string | null {
    const next = [run, ...this.runs.filter((r) => r.id !== run.id)]
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      return 'Could not save: browser storage is full or unavailable. Delete older runs and try again.'
    }
    this.runs = next
    this.emit()
    return null
  }

  remove(id: string): void {
    const next = this.runs.filter((r) => r.id !== id)
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      /* keep the in-memory list consistent with what the user asked for */
    }
    this.runs = next
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export const benchmarkStorage = new BenchmarkStorage()
