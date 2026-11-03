import { InspectorPane } from '../InspectorPane'
import type { WorkbenchStore } from '../../lib/store'

export function InspectorPanel(props: { store: WorkbenchStore }) {
  const { store } = props

  return (
    <div class="panel-content inspector-panel-content">
      <InspectorPane
        row={store.selected()}
        hoveredField={store.hovered()}
        onHoverField={store.setHovered}
        onPlotField={(key) => store.plotField(key, 'line')}
        plottedKeys={store.plotted().map((p) => p.key)}
      />
    </div>
  )
}
