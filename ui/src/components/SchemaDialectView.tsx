// Protocol & Schema Dialect Loader (spec 2.2) — REAL implementation.
// Parse/decode/apply all run against the engine's bforge-dissect via
// POST /api/schema, so the sandbox decodes exactly what the wire decodes.
import React, { useState } from 'react';
import {
  Code2,
  FileCode,
  CheckCircle2,
  Play,
  Sparkles,
  AlertTriangle,
  Upload,
} from 'lucide-react';
import { engineApi } from '../services/engineApi';
import { useToastStore } from '../store/useToastStore';
import { useWorkstationStore } from '../store/useWorkstationStore';

type SchemaKind = 'protobuf' | 'mavlink' | 'c_header';

const PROTO_SAMPLE = `syntax = "proto3";

enum TelemetryMode {
  MODE_IDLE = 0;
  MODE_RUN = 1;
  MODE_CALIBRATE = 2;
  MODE_FAULT = 3;
}

message ImuTelemetry {
  uint32 seq = 1;
  uint64 timestamp_ns = 2;
  float gyro_z = 3;
  uint32 vbatt_mv = 4;
  TelemetryMode mode = 5;
}`;

const MAVLINK_SAMPLE = `<mavlink>
  <messages>
    <message id="0" name="HEARTBEAT">
      <description>The heartbeat message shows that a system is present and responding.</description>
      <field type="uint8_t" name="type" enum="MAV_TYPE">Vehicle or component type.</field>
      <field type="uint8_t" name="autopilot" enum="MAV_AUTOPILOT">Autopilot type / class.</field>
      <field type="uint8_t" name="base_mode" enum="MAV_MODE_FLAG">System mode flags.</field>
      <field type="uint32_t" name="custom_mode">A bitfield for use for autopilot-specific flags</field>
      <field type="uint8_t" name="system_status" enum="MAV_STATE">System status flag.</field>
      <field type="uint8_t" name="mavlink_version">MAVLink version.</field>
    </message>
  </messages>
</mavlink>`;

const C_HEADER_SAMPLE = `struct __attribute__((packed)) ImuPacket {
    uint32_t seq;
    uint64_t timestamp_ns;
    int16_t accel_x;
    int16_t accel_y;
    int16_t accel_z;
    int16_t gyro_z;
    uint16_t vbatt_mv;
    uint8_t  mode;
    uint16_t crc16;
};`;

interface FieldRow {
  name: string;
  offset: number;
  len: number;
  value_num: number | null;
  value: string | null;
}

export const SchemaDialectView: React.FC = () => {
  const selectedPort = useWorkstationStore((s) => s.selectedPort);
  const pushToast = useToastStore((s) => s.pushToast);

  const [kind, setKind] = useState<SchemaKind>('protobuf');
  const [schemaText, setSchemaText] = useState(PROTO_SAMPLE);
  const [rootMessage, setRootMessage] = useState('ImuTelemetry');
  const [appliedStatus, setAppliedStatus] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [layoutRows, setLayoutRows] = useState<FieldRow[] | null>(null);
  const [testHex, setTestHex] = useState(
    '08 01 10 90 A2 E4 C4 03 1D CD CC 4C 3D 20 86 3A 28 01'
  );
  const [dissectionResult, setDissectionResult] = useState<
    Array<{ field: string; value: string; type: string }>
  >([]);
  const [busy, setBusy] = useState(false);

  const handleKindChange = (newKind: SchemaKind) => {
    setKind(newKind);
    if (newKind === 'protobuf') {
      setSchemaText(PROTO_SAMPLE);
      setRootMessage('ImuTelemetry');
      setTestHex('08 01 10 90 A2 E4 C4 03 1D CD CC 4C 3D 20 86 3A 28 01');
    } else if (newKind === 'mavlink') {
      setSchemaText(MAVLINK_SAMPLE);
      setRootMessage('HEARTBEAT');
      setTestHex('FE 09 01 01 01 00 00 00 00 00 02 03 51 04 03 50 32');
    } else {
      setSchemaText(C_HEADER_SAMPLE);
      setRootMessage('ImuPacket');
      setTestHex('01 00 00 00 4B 3D 00 00 00 00 00 00 00 00 00 00 00 00');
    }
    setAppliedStatus(null);
    setParseError(null);
    setLayoutRows(null);
    setDissectionResult([]);
  };

  const handleFilePick = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setSchemaText(text);
    pushToast('info', 'Schema loaded', `${file.name} (${file.size} B) — parse or apply it.`);
  };

  const handleParse = async () => {
    setBusy(true);
    setParseError(null);
    try {
      const result = await engineApi.schemaParse(kind, schemaText, rootMessage || undefined);
      if (!result.ok) {
        setParseError(result.error ?? 'parse failed');
        setLayoutRows(null);
      } else {
        setLayoutRows(result.fields ?? []);
        setParseError(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async () => {
    setBusy(true);
    try {
      const result = await engineApi.schemaApply(kind, schemaText, rootMessage || undefined, selectedPort);
      if (result.ok) {
        setAppliedStatus(
          `Applied ${kind.toUpperCase()} dialect (${rootMessage}) to ${selectedPort}'s live decoder.`
        );
        pushToast('success', 'Schema applied', `${rootMessage} now decodes on ${selectedPort}.`);
      } else {
        setAppliedStatus(null);
        setParseError(result.error ?? 'apply failed');
        pushToast('error', 'Schema apply failed', result.error ?? 'Engine did not accept the dialect.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDissect = async () => {
    setBusy(true);
    try {
      const result = await engineApi.schemaDecode(
        kind,
        schemaText,
        rootMessage || undefined,
        testHex
      );
      if (!result.ok) {
        setParseError(result.error ?? 'decode failed');
        setDissectionResult([]);
        return;
      }
      setParseError(null);
      setDissectionResult(
        (result.rows ?? []).map((row) => ({
          field: `${row.name} (@0x${row.offset.toString(16).padStart(2, '0')})`,
          value:
            row.value ??
            (row.value_num !== null && row.value_num !== undefined ? String(row.value_num) : '—'),
          type: `${row.len} B`,
        }))
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-bf-onfill font-mono text-[11px] text-bf-body overflow-hidden select-text">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-bf-head border-b border-bf-line">
        <div className="flex items-center gap-2">
          <Code2 className="w-4 h-4 text-bf-cyan" />
          <span className="font-bold tracking-wider uppercase text-bf-bright">
            Protocol & Schema Dialect Loader
          </span>
          <span className="text-[9px] px-1.5 py-0.2 rounded bg-bf-hover text-bf-cyan border border-bf-cyan/30">
            RUNTIME SCHEMAS
          </span>
        </div>

        {/* Format Selector Pills */}
        <div className="flex items-center gap-1 bg-bf-subpanel p-0.5 rounded border border-bf-line">
          <button
            onClick={() => handleKindChange('protobuf')}
            className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
              kind === 'protobuf' ? 'bg-bf-cyan/20 text-bf-cyan font-bold' : 'text-bf-mute hover:text-bf-body'
            }`}
          >
            PROTOBUF (.proto)
          </button>
          <button
            onClick={() => handleKindChange('mavlink')}
            className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
              kind === 'mavlink' ? 'bg-bf-cyan/20 text-bf-cyan font-bold' : 'text-bf-mute hover:text-bf-body'
            }`}
          >
            MAVLINK XML
          </button>
          <button
            onClick={() => handleKindChange('c_header')}
            className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
              kind === 'c_header' ? 'bg-bf-cyan/20 text-bf-cyan font-bold' : 'text-bf-mute hover:text-bf-body'
            }`}
          >
            C STRUCT (.h)
          </button>
        </div>
      </div>

      {/* Main Grid: Schema Source on Left, Dissection Preview on Right */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-2 p-3 overflow-y-auto">
        {/* Left Column: Schema Code */}
        <div className="bg-bf-head border border-bf-line rounded p-3 flex flex-col space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-bf-mute flex items-center gap-1.5">
              <FileCode className="w-3.5 h-3.5 text-bf-cyan" />
              <span>{kind.toUpperCase()} Schema Definition</span>
            </span>
            <div className="flex items-center gap-2">
              <label
                data-tooltip="Load a schema file from disk (.h / .proto / .xml)"
                className="flex items-center gap-1 px-2 py-0.5 bg-bf-subpanel hover:bg-bf-hover text-bf-mute hover:text-bf-cyan border border-bf-line rounded text-[10px] cursor-pointer transition-colors"
              >
                <Upload className="w-3 h-3" />
                <span>LOAD FILE</span>
                <input
                  type="file"
                  accept=".h,.hh,.proto,.xml,.txt"
                  className="hidden"
                  onChange={(e) => handleFilePick(e.target.files?.[0])}
                />
              </label>
              <span className="text-[10px] text-bf-faint">Root:</span>
              <input
                type="text"
                value={rootMessage}
                onChange={(e) => setRootMessage(e.target.value)}
                className="w-28 px-1.5 py-0.5 bg-bf-onfill border border-bf-line rounded text-[10px] text-bf-cyan focus:border-bf-cyan focus:outline-none"
              />
            </div>
          </div>

          <textarea
            value={schemaText}
            onChange={(e) => setSchemaText(e.target.value)}
            spellCheck={false}
            className="flex-1 w-full bg-bf-onfill border border-bf-line rounded p-2 text-[10px] text-bf-body font-mono focus:border-bf-cyan focus:outline-none resize-none min-h-[220px]"
          />

          <div className="flex items-center justify-between pt-1">
            <button
              onClick={handleParse}
              disabled={busy}
              data-tooltip="Compile the schema and show its field layout (dry run)"
              className="flex items-center gap-1 px-2 py-1 bg-bf-subpanel hover:bg-bf-hover text-bf-cyan border border-bf-line rounded text-[10px] font-bold disabled:opacity-50"
            >
              <CheckCircle2 className="w-3 h-3" />
              <span>{busy ? '…' : 'PARSE'}</span>
            </button>
            <button
              onClick={handleApply}
              disabled={busy}
              data-tooltip={`Apply this dialect to ${selectedPort}'s live decoder on the engine`}
              className="flex items-center gap-1 px-3 py-1 bg-bf-cyan hover:bg-bf-cyan-hi text-bf-onfill font-bold rounded text-[10px] transition-colors disabled:opacity-50"
            >
              <Sparkles className="w-3 h-3" />
              <span>APPLY TO WORKSPACE</span>
            </button>
          </div>

          {parseError && (
            <div className="p-1.5 rounded bg-bf-fault/15 border border-bf-fault/30 text-bf-fault text-[10px] flex items-start gap-1">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              <span className="break-words">{parseError}</span>
            </div>
          )}
          {layoutRows && !parseError && (
            <div className="p-1.5 rounded bg-bf-ok/15 border border-bf-ok/30 text-bf-ok text-[10px]">
              Parsed: {layoutRows.length} field{layoutRows.length === 1 ? '' : 's'} — {layoutRows.map((r) => r.name).join(', ')}
            </div>
          )}
          {appliedStatus && (
            <div className="p-1.5 rounded bg-bf-ok/15 border border-bf-ok/30 text-bf-ok text-[10px]">
              {appliedStatus}
            </div>
          )}
        </div>

        {/* Right Column: Wire Frame Dissection Sandbox */}
        <div className="bg-bf-head border border-bf-line rounded p-3 flex flex-col space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-bf-mute">
              Schema Wire Dissector Sandbox
            </span>
            <button
              onClick={handleDissect}
              disabled={busy}
              className="px-2.5 py-0.5 bg-bf-subpanel hover:bg-bf-hover text-bf-cyan border border-bf-line rounded text-[10px] font-bold flex items-center gap-1 transition-colors disabled:opacity-50"
            >
              <Play className="w-2.5 h-2.5 fill-current" />
              <span>DECODE WIRE HEX</span>
            </button>
          </div>

          <div>
            <label className="block text-[9px] uppercase tracking-wider text-bf-faint mb-1">
              Input Wire Hex Bytes
            </label>
            <input
              type="text"
              value={testHex}
              onChange={(e) => setTestHex(e.target.value)}
              className="w-full px-2 py-1 bg-bf-onfill border border-bf-line rounded text-[10px] text-bf-bright focus:border-bf-cyan focus:outline-none"
            />
          </div>

          {/* Dissected Fields Table */}
          <div className="flex-1 bg-bf-onfill border border-bf-line rounded overflow-hidden flex flex-col">
            <div className="bg-bf-subpanel px-2 py-1 border-b border-bf-line text-[9px] text-bf-mute font-bold uppercase tracking-wider grid grid-cols-3">
              <span>Field Name</span>
              <span>Offset / Size</span>
              <span>Decoded Value</span>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-bf-subpanel">
              {dissectionResult.length === 0 ? (
                <div className="px-2 py-3 text-[10px] text-bf-faint">
                  Press DECODE WIRE HEX to run these bytes through the engine's dissector.
                </div>
              ) : (
                dissectionResult.map((res, i) => (
                  <div key={i} className="px-2 py-1 text-[10px] grid grid-cols-3 hover:bg-bf-head transition-colors">
                    <span className="text-bf-cyan font-bold truncate">{res.field}</span>
                    <span className="text-bf-faint">{res.type}</span>
                    <span className="text-bf-bright font-semibold truncate">{res.value}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
