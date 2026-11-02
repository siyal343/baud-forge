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
  const [selectedDashboard, setSelectedDashboard] = createSignal<'gallery' | 'motor' | 'bms' | 'custom'>('gallery')
  const [customXml, setCustomXml] = createSignal('')
  const [isEditing, setIsEditing] = createSignal(false)

  const activeXml = createMemo(() => {
    const sel = selectedDashboard()
    if (sel === 'gallery') return ''
    if (sel === 'motor') return customXml() || DEMO_MOTOR_XML
    if (sel === 'bms') return customXml() || DEMO_BMS_XML
    return customXml()
  })

  async function loadTemplate(type: 'motor' | 'bms') {
    try {
      const filename = type === 'motor' ? 'motor-diagnostics.xml' : 'battery-bms.xml'
      const res = await fetch(`/dashboards/${filename}`)
      if (res.ok) {
        const text = await res.text()
        if (text && text.trim().length > 0) {
          setCustomXml(text)
          setSelectedDashboard(type)
          setIsEditing(false)
          return
        }
      }
    } catch {
      // Offline or sandboxed fallback
    }
    const fallback = type === 'motor' ? DEMO_MOTOR_XML : DEMO_BMS_XML
    setCustomXml(fallback)
    setSelectedDashboard(type)
    setIsEditing(false)
  }

  function handleFileUpload(e: Event) {
    const target = e.currentTarget as HTMLInputElement
    const file = target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (event) => {
      const content = event.target?.result as string
      if (typeof content === 'string' && content.trim().length > 0) {
        setCustomXml(content)
        setSelectedDashboard('custom')
        setIsEditing(false)
      }
    }
    reader.readAsText(file)
    target.value = ''
  }

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
            onChange={(e) => {
              const val = e.currentTarget.value as 'gallery' | 'motor' | 'bms' | 'custom'
              if (val === 'motor') void loadTemplate('motor')
              else if (val === 'bms') void loadTemplate('bms')
              else setSelectedDashboard(val)
            }}
            aria-label="select dashboard"
          >
            <option value="gallery">Declarative Template Gallery</option>
            <option value="motor">BLDC Motor Diagnostics</option>
            <option value="bms">High-Voltage Battery BMS</option>
            <option value="custom">Custom XML Dashboard</option>
          </select>
          <Show when={activeXml().trim() !== ''}>
            <button
              type="button"
              class="chip action"
              onClick={() => setIsEditing(!isEditing())}
            >
              {isEditing() ? 'view dashboard' : 'edit xml'}
            </button>
            <button
              type="button"
              class="chip action"
              onClick={() => {
                setSelectedDashboard('gallery')
                setCustomXml('')
                setIsEditing(false)
              }}
              title="Return to Template Gallery"
            >
              gallery
            </button>
          </Show>
        </div>
      </div>

      <Show
        when={activeXml().trim() !== ''}
        fallback={
          <div class="dashboard-zero-state">
            <div class="dashboard-gallery-card">
              <div class="gallery-header">
                <span class="gallery-pill">DECLARATIVE INSTRUMENTATION</span>
                <h2 class="gallery-title">Declarative XML Dashboards</h2>
                <p class="gallery-subtitle">
                  Choose a pre-built instrument template or load your own custom XML definition.
                </p>
              </div>

              <div class="template-cards-grid">
                {/* 1. Motor & ESC Diagnostics */}
                <div class="template-card">
                  <div class="template-card-header">
                    <div class="template-card-icon motor">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 12l4-4" />
                        <path d="M12 6v2" />
                        <path d="M18 12h-2" />
                        <path d="M6 12H8" />
                      </svg>
                    </div>
                    <div>
                      <span class="template-category">Propulsion &amp; Drive</span>
                      <h3 class="template-title">Motor &amp; ESC Diagnostics</h3>
                    </div>
                  </div>
                  <p class="template-desc">
                    RPM dial gauge, motor temperature gauge, DC bus voltage, and live phase current chart.
                  </p>
                  <button
                    type="button"
                    class="btn-template"
                    onClick={() => void loadTemplate('motor')}
                  >
                    Load Motor Diagnostics
                  </button>
                </div>

                {/* 2. Battery BMS & Cell Monitor */}
                <div class="template-card">
                  <div class="template-card-header">
                    <div class="template-card-icon bms">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="2" y="7" width="18" height="11" rx="2" />
                        <path d="M22 11v3" />
                        <path d="M7 11v3" />
                        <path d="M11 11v3" />
                        <path d="M15 11v3" />
                      </svg>
                    </div>
                    <div>
                      <span class="template-category">Energy Storage</span>
                      <h3 class="template-title">Battery BMS &amp; Cell Monitor</h3>
                    </div>
                  </div>
                  <p class="template-desc">
                    Pack state-of-charge gauge, 8-cell voltage grid, cell delta bar, and thermal sensors.
                  </p>
                  <button
                    type="button"
                    class="btn-template"
                    onClick={() => void loadTemplate('bms')}
                  >
                    Load Battery BMS
                  </button>
                </div>
              </div>

              <div class="gallery-footer">
                <span class="upload-caption">Or load custom instrument XML definition from disk:</span>
                <label class="btn-upload-label">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <span>Select XML File…</span>
                  <input
                    type="file"
                    accept=".xml"
                    onChange={handleFileUpload}
                    class="sr-only"
                    aria-label="Upload XML file"
                  />
                </label>
              </div>
            </div>
          </div>
        }
      >
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
      </Show>
    </div>
  )
}
