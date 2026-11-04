import React, { useState } from 'react';
import {
  Code2,
  FileCode,
  CheckCircle2,
  Play,
  Sparkles,
} from 'lucide-react';

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
    <message id="30" name="ATTITUDE">
      <field type="uint32_t" name="time_boot_ms">Timestamp (time since system boot).</field>
      <field type="float" name="roll">Roll angle (-pi..+pi)</field>
      <field type="float" name="pitch">Pitch angle (-pi..+pi)</field>
      <field type="float" name="yaw">Yaw angle (-pi..+pi)</field>
      <field type="float" name="rollspeed">Roll angular speed</field>
      <field type="float" name="pitchspeed">Pitch angular speed</field>
      <field type="float" name="yawspeed">Yaw angular speed</field>
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

export const SchemaDialectView: React.FC = () => {
  const [kind, setKind] = useState<SchemaKind>('protobuf');
  const [schemaText, setSchemaText] = useState(PROTO_SAMPLE);
  const [rootMessage, setRootMessage] = useState('ImuTelemetry');
  const [appliedStatus, setAppliedStatus] = useState<string | null>(null);
  const [testHex, setTestHex] = useState('08 01 10 90 A2 E4 C4 03 1D CD CC 4C 3D 20 86 3A 28 01');
  const [dissectionResult, setDissectionResult] = useState<Array<{ field: string; value: string; type: string }>>([
    { field: 'seq (1)', value: '1', type: 'varint uint32' },
    { field: 'timestamp_ns (2)', value: '948491083 ns', type: 'varint uint64' },
    { field: 'gyro_z (3)', value: '0.05 rad/s', type: 'fixed32 float' },
    { field: 'vbatt_mv (4)', value: '7430 mV', type: 'varint uint32' },
    { field: 'mode (5)', value: 'MODE_RUN (1)', type: 'enum TelemetryMode' },
  ]);

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
      setTestHex('01 00 00 00 4B 3D 00 00 ...');
    }
    setAppliedStatus(null);
  };

  const handleApply = () => {
    setAppliedStatus(`Applied ${kind.toUpperCase()} dialect (${rootMessage}) to workspace framing engine.`);
    setTimeout(() => setAppliedStatus(null), 3000);
  };

  const handleDissect = () => {
    if (kind === 'mavlink') {
      setDissectionResult([
        { field: 'custom_mode', value: '0', type: 'uint32_t (wire sorted #0)' },
        { field: 'type', value: 'MAV_TYPE_QUADROTOR (2)', type: 'uint8_t' },
        { field: 'autopilot', value: 'MAV_AUTOPILOT_ARDUPILOTMEGA (3)', type: 'uint8_t' },
        { field: 'base_mode', value: '81 (ARMED | MANUAL)', type: 'uint8_t' },
        { field: 'system_status', value: 'MAV_STATE_ACTIVE (4)', type: 'uint8_t' },
        { field: 'mavlink_version', value: '3', type: 'uint8_t' },
        { field: 'CRC_EXTRA status', value: '0x3250 (valid, seed=50)', type: 'crc16_x25' },
      ]);
    } else if (kind === 'protobuf') {
      setDissectionResult([
        { field: 'seq (1)', value: '1', type: 'varint uint32' },
        { field: 'timestamp_ns (2)', value: '948491083 ns', type: 'varint uint64' },
        { field: 'gyro_z (3)', value: '0.05 rad/s', type: 'fixed32 float' },
        { field: 'vbatt_mv (4)', value: '7430 mV', type: 'varint uint32' },
        { field: 'mode (5)', value: 'MODE_RUN (1)', type: 'enum TelemetryMode' },
      ]);
    } else {
      setDissectionResult([
        { field: 'seq', value: '1', type: 'uint32_t' },
        { field: 'timestamp_ns', value: '948491083 ns', type: 'uint64_t' },
        { field: 'gyro_z', value: '0.03 rad/s', type: 'int16_t' },
        { field: 'vbatt_mv', value: '7430 mV', type: 'uint16_t' },
        { field: 'mode', value: '1 (MODE_RUN)', type: 'uint8_t' },
        { field: 'crc16', value: '0x4B3D (valid)', type: 'uint16_t' },
      ]);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#0A0D13] font-mono text-[11px] text-[#E2E8F0] overflow-hidden select-text">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-[#121824] border-b border-[#222D3D]">
        <div className="flex items-center gap-2">
          <Code2 className="w-4 h-4 text-[#00E5FF]" />
          <span className="font-bold tracking-wider uppercase text-[#F8FAFC]">
            Protocol & Schema Dialect Loader
          </span>
          <span className="text-[9px] px-1.5 py-0.2 rounded bg-[#1E2638] text-[#00E5FF] border border-[#00E5FF]/30">
            RUNTIME SCHEMAS
          </span>
        </div>

        {/* Format Selector Pills */}
        <div className="flex items-center gap-1 bg-[#161C28] p-0.5 rounded border border-[#222D3D]">
          <button
            onClick={() => handleKindChange('protobuf')}
            className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
              kind === 'protobuf' ? 'bg-[#00E5FF]/20 text-[#00E5FF] font-bold' : 'text-[#94A3B8] hover:text-[#E2E8F0]'
            }`}
          >
            PROTOBUF (.proto)
          </button>
          <button
            onClick={() => handleKindChange('mavlink')}
            className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
              kind === 'mavlink' ? 'bg-[#00E5FF]/20 text-[#00E5FF] font-bold' : 'text-[#94A3B8] hover:text-[#E2E8F0]'
            }`}
          >
            MAVLINK XML
          </button>
          <button
            onClick={() => handleKindChange('c_header')}
            className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
              kind === 'c_header' ? 'bg-[#00E5FF]/20 text-[#00E5FF] font-bold' : 'text-[#94A3B8] hover:text-[#E2E8F0]'
            }`}
          >
            C STRUCT (.h)
          </button>
        </div>
      </div>

      {/* Main Grid: Schema Source on Left, Dissection Preview on Right */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-2 p-3 overflow-y-auto">
        {/* Left Column: Schema Code */}
        <div className="bg-[#121824] border border-[#222D3D] rounded p-3 flex flex-col space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] flex items-center gap-1.5">
              <FileCode className="w-3.5 h-3.5 text-[#00E5FF]" />
              <span>{kind.toUpperCase()} Schema Definition</span>
            </span>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-[#64748B]">Root:</span>
              <input
                type="text"
                value={rootMessage}
                onChange={(e) => setRootMessage(e.target.value)}
                className="w-28 px-1.5 py-0.5 bg-[#0A0D13] border border-[#222D3D] rounded text-[10px] text-[#00E5FF] focus:border-[#00E5FF] focus:outline-none"
              />
            </div>
          </div>

          <textarea
            value={schemaText}
            onChange={(e) => setSchemaText(e.target.value)}
            className="flex-1 w-full bg-[#0A0D13] border border-[#222D3D] rounded p-2 text-[10px] text-[#E2E8F0] font-mono focus:border-[#00E5FF] focus:outline-none resize-none min-h-[220px]"
          />

          <div className="flex items-center justify-between pt-1">
            <span className="text-[10px] text-[#10B981] flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" />
              <span>Parsed 0 syntax errors</span>
            </span>
            <button
              onClick={handleApply}
              className="flex items-center gap-1 px-3 py-1 bg-[#00E5FF] hover:bg-[#00B4D8] text-[#0A0D13] font-bold rounded text-[10px] transition-colors"
            >
              <Sparkles className="w-3 h-3" />
              <span>APPLY TO WORKSPACE</span>
            </button>
          </div>

          {appliedStatus && (
            <div className="p-1.5 rounded bg-[#10B981]/15 border border-[#10B981]/30 text-[#10B981] text-[10px]">
              {appliedStatus}
            </div>
          )}
        </div>

        {/* Right Column: Wire Frame Dissection Sandbox */}
        <div className="bg-[#121824] border border-[#222D3D] rounded p-3 flex flex-col space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]">
              Schema Wire Dissector Sandbox
            </span>
            <button
              onClick={handleDissect}
              className="px-2.5 py-0.5 bg-[#161C28] hover:bg-[#1E2638] text-[#00E5FF] border border-[#222D3D] rounded text-[10px] font-bold flex items-center gap-1 transition-colors"
            >
              <Play className="w-2.5 h-2.5 fill-current" />
              <span>DECODE WIRE HEX</span>
            </button>
          </div>

          <div>
            <label className="block text-[9px] uppercase tracking-wider text-[#64748B] mb-1">
              Input Wire Hex Bytes
            </label>
            <input
              type="text"
              value={testHex}
              onChange={(e) => setTestHex(e.target.value)}
              className="w-full px-2 py-1 bg-[#0A0D13] border border-[#222D3D] rounded text-[10px] text-[#F8FAFC] focus:border-[#00E5FF] focus:outline-none"
            />
          </div>

          {/* Dissected Fields Table */}
          <div className="flex-1 bg-[#0A0D13] border border-[#222D3D] rounded overflow-hidden flex flex-col">
            <div className="bg-[#161C28] px-2 py-1 border-b border-[#222D3D] text-[9px] text-[#94A3B8] font-bold uppercase tracking-wider grid grid-cols-3">
              <span>Field Name</span>
              <span>Wire Type</span>
              <span>Decoded Value</span>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-[#161C28]">
              {dissectionResult.map((res, i) => (
                <div key={i} className="px-2 py-1 text-[10px] grid grid-cols-3 hover:bg-[#121824] transition-colors">
                  <span className="text-[#00E5FF] font-bold">{res.field}</span>
                  <span className="text-[#64748B]">{res.type}</span>
                  <span className="text-[#F8FAFC] font-semibold">{res.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
