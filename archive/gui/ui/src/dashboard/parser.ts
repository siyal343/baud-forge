/**
 * BaudForge Declarative XML Dashboard Parser
 * Uses browser DOMParser to parse dashboard XML documents into typed AST configurations.
 */

import type {
  ButtonNode,
  ChartNode,
  DashboardConfig,
  DashboardLayoutNode,
  DashboardNode,
  GaugeNode,
  GaugeZones,
  LedNode,
  LogGridNode,
  NumericDisplayNode,
  SliderNode,
  SwitchNode,
} from './types'

function getAttr(el: Element, ...names: string[]): string | undefined {
  for (const name of names) {
    if (el.hasAttribute(name)) {
      return el.getAttribute(name) || undefined
    }
  }
  return undefined
}

function parseNumber(val: string | undefined): number | undefined {
  if (val === undefined || val === '') return undefined
  const num = Number(val)
  return isNaN(num) ? undefined : num
}

function parseBoolean(val: string | undefined): boolean | undefined {
  if (val === undefined || val === '') return undefined
  return val === 'true' || val === '1' || val === 'yes'
}

function parseValue(val: string | undefined): any {
  if (val === undefined) return undefined
  if (val === 'true') return true
  if (val === 'false') return false
  if (val === 'null') return null
  const num = Number(val)
  if (!isNaN(num) && val.trim() !== '') return num
  return val
}

export function parseDashboardXml(xmlString: string): DashboardConfig {
  const trimmed = xmlString.trim()
  if (!trimmed) {
    throw new Error('Empty XML dashboard document')
  }

  if (typeof DOMParser === 'undefined') {
    throw new Error('DOMParser is not available in current execution context')
  }

  const parser = new DOMParser()
  const doc = parser.parseFromString(trimmed, 'application/xml')

  // Check for DOMParser error document
  const parserError = doc.querySelector('parsererror') || doc.getElementsByTagName('parsererror')[0]
  if (parserError) {
    const errorText = parserError.textContent?.trim() || 'Malformed XML syntax'
    throw new Error(`XML Dashboard Parse Error: ${errorText}`)
  }

  const rootEl = doc.documentElement
  if (rootEl.tagName.toLowerCase() !== 'bforge-dashboard') {
    throw new Error(
      `Invalid dashboard root element: <${rootEl.tagName}>. Expected <bforge-dashboard>`,
    )
  }

  const title = getAttr(rootEl, 'title') || 'BaudForge Dashboard'
  const version = getAttr(rootEl, 'version') || '1.0'
  const refreshMs = parseNumber(getAttr(rootEl, 'refresh-ms', 'refreshMs', 'refresh'))

  // Parse children of root
  const childNodes: DashboardNode[] = []
  for (let i = 0; i < rootEl.children.length; i++) {
    const childEl = rootEl.children[i]
    const parsedNode = parseElement(childEl)
    if (parsedNode) {
      childNodes.push(parsedNode)
    }
  }

  let rootNode: DashboardNode
  if (childNodes.length === 1 && isLayoutNode(childNodes[0])) {
    rootNode = childNodes[0]
  } else {
    // Default wrap in a responsive stack or grid
    rootNode = {
      type: 'stack',
      direction: 'vertical',
      gap: 12,
      children: childNodes,
    }
  }

  return {
    title,
    version,
    refreshMs,
    root: rootNode,
  }
}

function isLayoutNode(node: DashboardNode): node is DashboardLayoutNode {
  return ['grid', 'stack', 'card', 'split'].includes(node.type)
}

function parseElement(el: Element): DashboardNode | null {
  const tagName = el.tagName.toLowerCase()

  switch (tagName) {
    // Layout nodes
    case 'grid': {
      const columns = parseNumber(getAttr(el, 'columns', 'cols')) || 2
      const gap = parseNumber(getAttr(el, 'gap')) ?? 12
      const title = getAttr(el, 'title')
      const children = parseChildNodes(el)
      return {
        type: 'grid',
        columns,
        gap,
        title,
        children,
      }
    }

    case 'stack': {
      const dirRaw = getAttr(el, 'direction', 'dir')
      const direction = dirRaw === 'horizontal' || dirRaw === 'row' ? 'horizontal' : 'vertical'
      const gap = parseNumber(getAttr(el, 'gap')) ?? 12
      const title = getAttr(el, 'title')
      const children = parseChildNodes(el)
      return {
        type: 'stack',
        direction,
        gap,
        title,
        children,
      }
    }

    case 'card': {
      const title = getAttr(el, 'title')
      const children = parseChildNodes(el)
      return {
        type: 'card',
        title,
        children,
      }
    }

    case 'split': {
      const dirRaw = getAttr(el, 'direction', 'dir')
      const direction = dirRaw === 'vertical' || dirRaw === 'column' ? 'vertical' : 'horizontal'
      const gap = parseNumber(getAttr(el, 'gap')) ?? 8
      const title = getAttr(el, 'title')
      const children = parseChildNodes(el)
      return {
        type: 'split',
        direction,
        gap,
        title,
        children,
      }
    }

    // Widgets
    case 'gauge': {
      const source = getAttr(el, 'source', 'src') || '0'
      const min = parseNumber(getAttr(el, 'min')) ?? 0
      const max = parseNumber(getAttr(el, 'max')) ?? 100
      const unit = getAttr(el, 'unit')
      const label = getAttr(el, 'label')

      // Zones: can be attribute on gauge or sub-element <zones>
      let zones: GaugeZones | undefined
      const zoneEl = el.querySelector('zones')
      if (zoneEl) {
        zones = {
          low: parseNumber(getAttr(zoneEl, 'low', 'warn-low', 'warnLow')),
          high: parseNumber(getAttr(zoneEl, 'high', 'warn-high', 'warnHigh')),
          warnColor: getAttr(zoneEl, 'warn-color', 'warnColor'),
          faultColor: getAttr(zoneEl, 'fault-color', 'faultColor'),
        }
      } else {
        const low = parseNumber(getAttr(el, 'zone-low', 'zoneLow', 'low'))
        const high = parseNumber(getAttr(el, 'zone-high', 'zoneHigh', 'high'))
        const warnColor = getAttr(el, 'warn-color', 'warnColor')
        const faultColor = getAttr(el, 'fault-color', 'faultColor')
        if (low !== undefined || high !== undefined || warnColor || faultColor) {
          zones = { low, high, warnColor, faultColor }
        }
      }

      const node: GaugeNode = {
        type: 'gauge',
        source,
        min,
        max,
        unit,
        label,
        zones,
      }
      return node
    }

    case 'numeric-display':
    case 'numeric':
    case 'display': {
      const source = getAttr(el, 'source', 'src') || '0'
      const label = getAttr(el, 'label')
      const unit = getAttr(el, 'unit')
      const precision = parseNumber(getAttr(el, 'precision', 'decimals'))
      const node: NumericDisplayNode = {
        type: 'numeric-display',
        source,
        label,
        unit,
        precision,
      }
      return node
    }

    case 'chart':
    case 'strip-chart': {
      const source = getAttr(el, 'source', 'src') || '0'
      const min = parseNumber(getAttr(el, 'min'))
      const max = parseNumber(getAttr(el, 'max'))
      const color = getAttr(el, 'color')
      const height = parseNumber(getAttr(el, 'height'))
      const durationMs = parseNumber(getAttr(el, 'duration-ms', 'durationMs', 'duration'))
      const node: ChartNode = {
        type: 'chart',
        source,
        min,
        max,
        color,
        height,
        durationMs,
      }
      return node
    }

    case 'led':
    case 'indicator': {
      const source = getAttr(el, 'source', 'src') || 'false'
      const label = getAttr(el, 'label')
      const onColor = getAttr(el, 'on-color', 'onColor')
      const offColor = getAttr(el, 'off-color', 'offColor')
      const pulse = parseBoolean(getAttr(el, 'pulse'))
      const node: LedNode = {
        type: 'led',
        source,
        label,
        onColor,
        offColor,
        pulse,
      }
      return node
    }

    case 'switch':
    case 'toggle': {
      const target = getAttr(el, 'target', 'dest') || ''
      const label = getAttr(el, 'label')
      const onValue = parseValue(getAttr(el, 'on-value', 'onValue')) ?? true
      const offValue = parseValue(getAttr(el, 'off-value', 'offValue')) ?? false
      const node: SwitchNode = {
        type: 'switch',
        target,
        label,
        onValue,
        offValue,
      }
      return node
    }

    case 'button':
    case 'btn': {
      const label = getAttr(el, 'label') || el.textContent?.trim() || 'Action'
      const command = getAttr(el, 'command', 'cmd') || ''
      const param = getAttr(el, 'param', 'arg')
      const rawVariant = getAttr(el, 'variant', 'type')
      const variant: 'primary' | 'danger' | 'ghost' =
        rawVariant === 'danger' || rawVariant === 'ghost' ? rawVariant : 'primary'
      const node: ButtonNode = {
        type: 'button',
        label,
        command,
        param,
        variant,
      }
      return node
    }

    case 'slider':
    case 'range': {
      const target = getAttr(el, 'target', 'dest') || ''
      const min = parseNumber(getAttr(el, 'min')) ?? 0
      const max = parseNumber(getAttr(el, 'max')) ?? 100
      const step = parseNumber(getAttr(el, 'step')) ?? 1
      const label = getAttr(el, 'label')
      const node: SliderNode = {
        type: 'slider',
        target,
        min,
        max,
        step,
        label,
      }
      return node
    }

    case 'log-grid':
    case 'log': {
      const source = getAttr(el, 'source', 'src')
      const limit = parseNumber(getAttr(el, 'limit', 'rows')) ?? 50
      const height = parseNumber(getAttr(el, 'height')) ?? 200
      const node: LogGridNode = {
        type: 'log-grid',
        source,
        limit,
        height,
      }
      return node
    }

    default:
      // Unknown element tag, skip or return null
      return null
  }
}

function parseChildNodes(parent: Element): DashboardNode[] {
  const nodes: DashboardNode[] = []
  for (let i = 0; i < parent.children.length; i++) {
    const parsed = parseElement(parent.children[i])
    if (parsed) {
      nodes.push(parsed)
    }
  }
  return nodes
}
