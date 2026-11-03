import { createContext, useContext } from 'solid-js'
import type { DockContextValue } from './types'

export const DockContext = createContext<DockContextValue>()

export function useDock(): DockContextValue {
  const ctx = useContext(DockContext)
  if (!ctx) {
    throw new Error('useDock must be used within a DockContainer')
  }
  return ctx
}
