/**
 * BaudForge Declarative XML Dashboard AST Types
 * Zero-dependency AST interfaces and runtime action contracts.
 */

export interface GaugeZones {
  low?: number
  high?: number
  warnColor?: string
  faultColor?: string
}

export interface GaugeNode {
  type: 'gauge'
  source: string
  min: number
  max: number
  unit?: string
  label?: string
  zones?: GaugeZones
}

export interface NumericDisplayNode {
  type: 'numeric-display'
  source: string
  label?: string
  unit?: string
  precision?: number
}

export interface ChartNode {
  type: 'chart'
  source: string
  min?: number
  max?: number
  color?: string
  height?: number
  durationMs?: number
}

export interface LedNode {
  type: 'led'
  source: string
  label?: string
  onColor?: string
  offColor?: string
  pulse?: boolean
}

export interface SwitchNode {
  type: 'switch'
  target: string
  label?: string
  onValue?: any
  offValue?: any
}

export interface ButtonNode {
  type: 'button'
  label: string
  command: string
  param?: string
  variant?: 'primary' | 'danger' | 'ghost'
}

export interface SliderNode {
  type: 'slider'
  target: string
  min: number
  max: number
  step?: number
  label?: string
}

export interface LogGridNode {
  type: 'log-grid'
  source?: string
  limit?: number
  height?: number
}

export type DashboardWidgetNode =
  | GaugeNode
  | NumericDisplayNode
  | ChartNode
  | LedNode
  | SwitchNode
  | ButtonNode
  | SliderNode
  | LogGridNode

export interface DashboardLayoutNode {
  type: 'grid' | 'stack' | 'card' | 'split'
  columns?: number
  gap?: number
  title?: string
  direction?: 'horizontal' | 'vertical'
  children: DashboardNode[]
}

export type DashboardNode = DashboardLayoutNode | DashboardWidgetNode

export interface DashboardConfig {
  title: string
  version: string
  refreshMs?: number
  root: DashboardNode
}

/** Action emitted by interactive controls (Button, Switch, Slider) */
export interface DashboardAction {
  type: 'command' | 'set'
  target?: string
  value?: any
  command?: string
  param?: string
}

export type ActionHandler = (action: DashboardAction) => void
