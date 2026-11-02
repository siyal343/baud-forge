import { Show, createSignal, createMemo } from 'solid-js'
import { DashboardRenderer } from '../../dashboard/DashboardRenderer'
import type { WorkbenchStore } from '../../lib/store'

const DEMO_MOTOR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<bforge-dashboard title="BLDC Motor &amp; Inverter Diagnostics" version="1.0" refresh-ms="50">
  <grid columns="2" gap="14">
    <card title="Drive Shaft Telemetry">
      <stack direction="horizontal" gap="12">
        <gauge source="fields.rpm || 3200" min="0" max="8000" unit="RPM" label="Motor Speed">
          <zones high="6500" warn-color="#f59e0b" fault-color="#f43f5e" />
        </gauge>
        <numeric-display source="fields.inverter_temp || 42.5" label="Inverter Temperature" unit="°C" precision="1" />
      </stack>
    </card>
    <card title="Phase Current Draw">
      <chart source="fields.phase_current || (fields.rpm ? fields.rpm / 200 : 12)" min="0" max="50" color="#06b6d4" height="150" duration-ms="8000" />
    </card>
    <card title="Motor Controller Command Bus">
      <stack direction="horizontal" gap="16">
        <switch target="motor_armed" label="Arm Inverter" on-value="true" off-value="false" />
        <slider target="throttle_pct" min="0" max="100" step="1" label="Throttle Demand (%)" />
        <button label="EMERGENCY STOP" command="emergency_stop" param="immediate" variant="danger" />
      </stack>
    </card>
    <card title="CAN &amp; UART Telemetry Stream">
      <log-grid source="tail" limit="50" height="160" />
    </card>
  </grid>
</bforge-dashboard>`

const DEMO_BMS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<bforge-dashboard title="High-Voltage Battery BMS Monitor" version="1.0" refresh-ms="100">
  <grid columns="2" gap="14">
    <card title="Battery Pack State">
      <stack direction="horizontal" gap="12">
        <gauge source="fields.soc || 78" min="0" max="100" unit="%" label="State of Charge">
          <zones low="20" high="95" warn-color="#f59e0b" fault-color="#f43f5e" />
        </gauge>
        <stack direction="vertical" gap="8">
          <numeric-display source="fields.pack_voltage || 398.4" label="Pack Voltage" unit="V" precision="2" />
          <numeric-display source="fields.pack_current || 24.1" label="Pack Current" unit="A" precision="2" />
        </stack>
      </stack>
    </card>
    <card title="Cell Balancing Matrix">
      <stack direction="vertical" gap="10">
        <stack direction="horizontal" gap="12">
          <led source="fields.cell1_bal || true" label="Cell 1 Bal" on-color="#10b981" pulse="true" />
          <led source="fields.cell2_bal || false" label="Cell 2 Bal" on-color="#10b981" pulse="true" />
          <led source="fields.cell3_bal || true" label="Cell 3 Bal" on-color="#10b981" pulse="true" />
          <led source="fields.cell4_bal || false" label="Cell 4 Bal" on-color="#10b981" pulse="true" />
        </stack>
      </stack>
    </card>
  </grid>
</bforge-dashboard>`

export function DashboardPanel(props: { store: WorkbenchStore }) {
  const { store } = props
  const [selectedDashboard, setSelectedDashboard] = createSignal<'motor' | 'bms' | 'custom'>('motor')
  const [customXml, setCustomXml] = createSignal(DEMO_MOTOR_XML)
  const [isEditing, setIsEditing] = createSignal(false)

  const activeXml = createMemo(() => {
    const sel = selectedDashboard()
    if (sel === 'motor') return DEMO_MOTOR_XML
    if (sel === 'bms') return DEMO_BMS_XML
    return customXml()
  })

  const dashboardContext = createMemo(() => {
    const rows = store.rawRows()
    const latest = rows.length > 0 ? rows[rows.length - 1] : null
    const fields: Record<string, any> = {}
    if (latest && latest.fields) {
      for (const f of latest.fields) {
        fields[f.name] = f.value_num !== null ? f.value_num : f.value
      }
    }
    return {
      fields,
      tail: rows.slice(-50),
      ports: store.ports(),
      session: store.session(),
    }
  })

  function handleAction(event: { type: string; command?: string; param?: string; value?: any }) {
    if (event.command === 'emergency_stop') {
      void store.setDtr(store.ports()[0]?.id || '', false)
      void store.setRts(store.ports()[0]?.id || '', false)
    } else if (event.command === 'forge.send' && event.param) {
      store.setHex(event.param)
      void store.sendHex()
    }
  }

  return (
    <div class="panel-content dashboard-panel-content">
      <div class="dashboard-toolbar">
        <div class="dashboard-selector-group">
          <select
            class="dashboard-select"
            value={selectedDashboard()}
            onChange={(e) => setSelectedDashboard(e.currentTarget.value as any)}
            aria-label="select dashboard"
          >
            <option value="motor">BLDC Motor Diagnostics</option>
            <option value="bms">High-Voltage Battery BMS</option>
            <option value="custom">Custom XML Dashboard</option>
          </select>
          <button
            type="button"
            class="chip action"
            onClick={() => setIsEditing(!isEditing())}
          >
            {isEditing() ? 'view dashboard' : 'edit xml'}
          </button>
        </div>
      </div>

      <Show
        when={!isEditing()}
        fallback={
          <div class="dashboard-xml-editor">
            <textarea
              class="dashboard-xml-textarea"
              value={customXml()}
              onInput={(e) => {
                setCustomXml(e.currentTarget.value)
                setSelectedDashboard('custom')
              }}
              spellcheck={false}
              aria-label="dashboard xml source"
            />
          </div>
        }
      >
        <div class="dashboard-view-wrapper">
          <DashboardRenderer
            xml={activeXml()}
            context={dashboardContext}
            onAction={handleAction}
          />
        </div>
      </Show>
    </div>
  )
}
