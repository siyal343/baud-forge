import React, { useState, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { toast } from '../store/useToastStore';
import {
  Send,
  Terminal,
  Plus,
  Trash2,
  X,
  Clock,
  Square,
  Zap,
  Radio,
  Cpu,
  RotateCcw,
  Play,
  Activity,
  Flame,
  Sliders,
  Check,
  Grid,
  FileText,
} from 'lucide-react';
import { engineApi } from '../services/engineApi';
import {
  parseCStructs,
  serializeStruct,
  type ParsedStruct,
} from '../services/cStructParser';

export interface UserCommand {
  id: string;
  name: string;
  payload: string;
  color: string;
  iconName: string;
  isPeriodic: boolean;
  intervalMs: number;
}

const DEFAULT_USER_COMMANDS: UserCommand[] = [
  {
    id: 'cmd-sync-ping',
    name: 'Sync Ping (AA55)',
    payload: 'AA 55 01 00 00 00',
    color: '#00E5FF',
    iconName: 'Zap',
    isPeriodic: false,
    intervalMs: 100,
  },
  {
    id: 'cmd-heartbeat',
    name: 'Heartbeat Loop',
    payload: 'AA 55 00 00',
    color: '#10B981',
    iconName: 'Activity',
    isPeriodic: true,
    intervalMs: 500,
  },
  {
    id: 'cmd-status-query',
    name: 'Status Query',
    payload: 'status\n',
    color: '#3B82F6',
    iconName: 'Terminal',
    isPeriodic: false,
    intervalMs: 100,
  },
  {
    id: 'cmd-system-reset',
    name: 'Soft Reset',
    payload: 'reset\n',
    color: '#EF4444',
    iconName: 'RotateCcw',
    isPeriodic: false,
    intervalMs: 100,
  },
];

const ICON_MAP: Record<string, React.FC<{ className?: string }>> = {
  Zap,
  Terminal,
  Radio,
  Cpu,
  RotateCcw,
  Play,
  Send,
  Activity,
  Flame,
  Sliders,
};

const COLOR_PALETTE = [
  { name: 'Cyan', hex: '#00E5FF' },
  { name: 'Emerald', hex: '#10B981' },
  { name: 'Amber', hex: '#F59E0B' },
  { name: 'Rose', hex: '#EF4444' },
  { name: 'Purple', hex: '#A855F7' },
  { name: 'Blue', hex: '#3B82F6' },
  { name: 'Pink', hex: '#EC4899' },
  { name: 'Slate', hex: '#94A3B8' },
];

/**
 * Checks if a string consists of hex byte tokens (e.g. "AA 55 01 02")
 */
export const isHexString = (str: string): boolean => {
  const trimmed = str.trim();
  if (!trimmed) return false;
  const tokens = trimmed.split(/\s+/);
  return tokens.length > 0 && tokens.every((t) => /^(0x)?[0-9a-fA-F]{1,2}$/.test(t));
};

/**
 * Real checksum engines (bitwise, no tables — payloads here are tiny).
 * Replaces the previous modular-sum implementations that were labeled as
 * CRC-16-CCITT / CRC-32C but were plain byte sums.
 */
export const crc16CcittFalse = (bytes: number[]): number => {
  // CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no xorout.
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
};

export const crc16Modbus = (bytes: number[]): number => {
  // CRC-16/MODBUS: poly 0x8005 (reflected 0xA001), init 0xFFFF, reflect in/out.
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x0001 ? ((crc >> 1) ^ 0xa001) & 0xffff : crc >> 1;
    }
  }
  return crc;
};

export const crc32c = (bytes: number[]): number => {
  // CRC-32C (Castagnoli): reflected poly 0x82F63B78, init/xorout 0xFFFFFFFF.
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x00000001 ? ((crc >>> 1) ^ 0x82f63b78) >>> 0 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/** Checksum byte sequence to append on the wire, per algorithm convention. */
export const checksumBytes = (kind: string, bytes: number[]): number[] => {
  if (kind === 'sum8') {
    return [bytes.reduce((acc, b) => (acc + b) & 0xff, 0)];
  }
  if (kind === 'crc16') {
    const crc = crc16CcittFalse(bytes);
    return [(crc >> 8) & 0xff, crc & 0xff]; // big-endian (network order)
  }
  if (kind === 'crc16modbus') {
    const crc = crc16Modbus(bytes);
    return [crc & 0xff, (crc >> 8) & 0xff]; // little-endian per MODBUS spec
  }
  if (kind === 'crc32') {
    const crc = crc32c(bytes);
    return [crc & 0xff, (crc >> 8) & 0xff, (crc >> 16) & 0xff, (crc >>> 24) & 0xff]; // little-endian
  }
  return [];
};

/**
 * Dynamically format payload for hover inspection based strictly on Command Forge's active mode
 */
export const formatPayloadForHover = (
  payload: string,
  targetMode: 'hex' | 'ascii'
): string => {
  const trimmed = payload.trim();
  if (!trimmed) return '';

  const looksLikeHex = isHexString(trimmed);

  if (targetMode === 'hex') {
    if (looksLikeHex) {
      // Clean and normalize hex pairs
      return trimmed
        .split(/\s+/)
        .map((t) => t.replace(/^0x/i, '').padStart(2, '0').toUpperCase())
        .join(' ');
    } else {
      // Convert ASCII string to hex bytes
      return Array.from(new TextEncoder().encode(payload))
        .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
        .join(' ');
    }
  } else {
    // ASCII Target Mode
    if (looksLikeHex) {
      // Decode hex bytes to characters
      const tokens = trimmed.split(/\s+/);
      return tokens
        .map((tok) => {
          const val = parseInt(tok.replace(/^0x/i, ''), 16);
          if (isNaN(val)) return '?';
          if (val >= 32 && val <= 126) return String.fromCharCode(val);
          if (val === 10) return '\\n';
          if (val === 13) return '\\r';
          if (val === 9) return '\\t';
          return `\\x${val.toString(16).padStart(2, '0').toUpperCase()}`;
        })
        .join('');
    } else {
      // Already an ASCII string
      return payload;
    }
  }
};

export const CommandForge: React.FC = () => {
  const { selectedPort, isConnected, addPacket, recordTx } = useWorkstationStore(
    useShallow((s) => ({
      selectedPort: s.selectedPort,
      isConnected: s.isConnected,
      addPacket: s.addPacket,
      recordTx: s.recordTx,
    }))
  );

  const [mode, setMode] = useState<'hex' | 'ascii' | 'struct'>('hex');
  const [payload, setPayload] = useState('AA 55 01 02 00 00 00 00');

  // Struct Form (spec 2.4): C-header-driven typed payload composer.
  const STRUCT_SAMPLE_HEADER = `// Edit or paste a C header, then PARSE STRUCT.
typedef struct {
    uint32_t seq;          // frame counter
    uint64_t timestamp_ns; // monotonic
    float gyro_z;          // rad/s
    uint16_t vbatt_mv;
    uint8_t mode;
    uint8_t flags;
} ImuPacket;`;
  const [headerSrc, setHeaderSrc] = useState(STRUCT_SAMPLE_HEADER);
  const [parsedStructs, setParsedStructs] = useState<ParsedStruct[]>(() =>
    parseCStructs(STRUCT_SAMPLE_HEADER).structs
  );
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [selectedStructIdx, setSelectedStructIdx] = useState(0);
  const [structValues, setStructValues] = useState<Record<string, string>>({});

  const activeStruct: ParsedStruct | null = parsedStructs[selectedStructIdx] ?? null;

  const handleParseHeader = () => {
    const result = parseCStructs(headerSrc);
    setParsedStructs(result.structs);
    setParseErrors(result.errors);
    setSelectedStructIdx(0);
  };

  const serializeActiveStruct = () =>
    activeStruct ? serializeStruct(activeStruct, structValues) : { bytes: [], errors: ['no struct parsed'] };
  const structWire = mode === 'struct' && activeStruct ? serializeActiveStruct() : null;
  const [autoCrc, setAutoCrc] = useState('crc16');
  const [lineEnding, setLineEnding] = useState('none');
  const [payloadViewMode, setPayloadViewMode] = useState<'boxes' | 'raw'>('boxes');

  // Draggable column width state
  const [leftColWidth, setLeftColWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('bforge_cmd_col_width');
      if (saved) {
        const val = parseInt(saved, 10);
        if (!isNaN(val) && val >= 180 && val <= 650) return val;
      }
    } catch (_) {}
    return 290;
  });

  // User defined commands state
  const [userCommands, setUserCommands] = useState<UserCommand[]>(() => {
    try {
      const saved = localStorage.getItem('bforge_user_commands');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (_) {}
    return DEFAULT_USER_COMMANDS;
  });

  // Track active periodic commands and interval timers
  const [activePeriodicIds, setActivePeriodicIds] = useState<Record<string, boolean>>({});
  const intervalTimersRef = useRef<Record<string, number>>({});

  // Modal form state (without hex/ascii selector per User Request 0)
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newCmdName, setNewCmdName] = useState('');
  const [newCmdPayload, setNewCmdPayload] = useState('');
  const [newCmdColor, setNewCmdColor] = useState('#00E5FF');
  const [newCmdIcon, setNewCmdIcon] = useState('Zap');
  const [newCmdIsPeriodic, setNewCmdIsPeriodic] = useState(false);
  const [newCmdIntervalMs, setNewCmdIntervalMs] = useState(100);

  // Ref for byte box inputs
  const byteInputsRef = useRef<Array<HTMLInputElement | null>>([]);

  // Clean up all active intervals on unmount
  useEffect(() => {
    return () => {
      Object.values(intervalTimersRef.current).forEach((id) => window.clearInterval(id));
      intervalTimersRef.current = {};
    };
  }, []);

  const saveCommandsToStorage = (cmds: UserCommand[]) => {
    setUserCommands(cmds);
    try {
      localStorage.setItem('bforge_user_commands', JSON.stringify(cmds));
    } catch (_) {}
  };

  // Draggable separator handler
  const dragWidthRef = useRef<number>(leftColWidth);
  const dragHandlersRef = useRef<{ move: (ev: MouseEvent) => void; up: () => void } | null>(null);

  // If the panel unmounts mid-drag, remove the window listeners.
  useEffect(() => {
    return () => {
      if (dragHandlersRef.current) {
        window.removeEventListener('mousemove', dragHandlersRef.current.move);
        window.removeEventListener('mouseup', dragHandlersRef.current.up);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        dragHandlersRef.current = null;
      }
    };
  }, []);

  const handleSeparatorMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = leftColWidth;
    dragWidthRef.current = startWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const newWidth = Math.max(180, Math.min(650, startWidth + delta));
      dragWidthRef.current = newWidth; // ref is the source of truth for persist
      setLeftColWidth(newWidth);
    };

    const handleMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      dragHandlersRef.current = null;
      // Persist the FINAL dragged width — the old closure captured the
      // pre-drag `leftColWidth`, so localStorage always stored one drag behind.
      try {
        localStorage.setItem('bforge_cmd_col_width', String(dragWidthRef.current));
      } catch (_) {}
    };

    dragHandlersRef.current = { move: handleMouseMove, up: handleMouseUp };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const calculateCrc = (text: string, currentMode: 'hex' | 'ascii'): string => {
    if (autoCrc === 'none' || !text.trim()) return '';
    let bytes: number[] = [];
    if (currentMode === 'hex') {
      bytes = text
        .trim()
        .split(/\s+/)
        .map((h) => parseInt(h, 16))
        .filter((n) => !isNaN(n));
    } else {
      bytes = Array.from(new TextEncoder().encode(text));
    }
    if (bytes.length === 0) return '';

    if (autoCrc === 'sum8') {
      const sum = bytes.reduce((acc, b) => (acc + b) & 0xff, 0);
      return `Sum8: 0x${sum.toString(16).padStart(2, '0').toUpperCase()}`;
    }
    if (autoCrc === 'crc16') {
      return `CRC16: 0x${crc16CcittFalse(bytes).toString(16).padStart(4, '0').toUpperCase()}`;
    }
    if (autoCrc === 'crc16modbus') {
      return `CRC16-MB: 0x${crc16Modbus(bytes).toString(16).padStart(4, '0').toUpperCase()}`;
    }
    if (autoCrc === 'crc32') {
      return `CRC32C: 0x${crc32c(bytes).toString(16).padStart(8, '0').toUpperCase()}`;
    }
    return '';
  };

  const handleSend = async (customPayload?: string) => {
    // Struct Form: serialize the typed fields instead of parsing free text.
    if (mode === 'struct' && !customPayload) {
      if (!activeStruct) {
        toast.error('No struct parsed', 'Parse a C header first (STRUCT tab → PARSE STRUCT).');
        return;
      }
      const { bytes: wire, errors: serErrors } = serializeActiveStruct();
      if (serErrors.length > 0) {
        toast.error('Struct values invalid', serErrors.join(' · '));
        return;
      }
      await dispatchBytes(wire, `${activeStruct.name} { ${activeStruct.fields.map((f) => f.name).join(', ')} }`, 'struct');
      return;
    }

    const text = customPayload ?? payload;
    if (!text.trim()) return;

    let bytes: number[];
    const isHex = mode === 'hex' || isHexString(text);

    if (!isHex) {
      const ending = lineEnding === 'lf' ? '\n' : lineEnding === 'crlf' ? '\r\n' : '';
      const fullText = text.endsWith('\n') ? text : text + ending;
      bytes = Array.from(new TextEncoder().encode(fullText));
    } else {
      const tokens = text.trim().split(/\s+/).filter(Boolean);
      const invalid = tokens.find((t) => !/^(0x)?[0-9a-fA-F]{1,2}$/.test(t));
      if (invalid) {
        toast.error('Invalid hex token', `"${invalid}" is not a 1-2 digit hex byte — send aborted.`);
        return;
      }
      bytes = tokens.map((t) => parseInt(t.replace(/^0x/i, ''), 16));
    }

    await dispatchBytes(
      bytes,
      text.trim(),
      mode === 'ascii' ? 'ASCII' : 'HEX'
    );
  };

  /**
   * Shared TX pipeline: append the auto-checksum, dispatch through the
   * engine (result checked, never discarded), record the TX row, and count
   * the bytes. `modeLabel` only shapes the stream summary.
   */
  const dispatchBytes = async (
    payloadBytes: number[],
    summaryText: string,
    modeLabel: string,
  ) => {
    // Auto-checksum: append the checksum bytes to the wire payload.
    const checksum = autoCrc === 'none' ? [] : checksumBytes(autoCrc, payloadBytes);
    const wireBytes = [...payloadBytes, ...checksum];
    const hexToSend = wireBytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');

    // Dispatch via engineApi — the result is checked, never discarded.
    const ok = await engineApi.sendBytes(selectedPort, hexToSend);
    if (!ok) {
      toast.warn(
        'Engine unreachable — TX recorded locally only',
        `No bytes reached ${selectedPort}. Start the bforge engine to transmit on the wire.`
      );
    }

    const now = new Date();
    const timeStr =
      now.toTimeString().split(' ')[0] +
      '.' +
      String(now.getMilliseconds()).padStart(3, '0');

    addPacket({
      seqId: Date.now() % 100000,
      timestampNs: Date.now() * 1000000,
      timestampUs: Math.round(performance.now() * 1000),
      deltaUs: 120,
      timeStr,
      direction: 'TX',
      port: selectedPort,
      length: wireBytes.length,
      rawBytes: wireBytes,
      rawHex: hexToSend.toUpperCase(),
      protocol: 'Command',
      summary: `TX (${modeLabel}): ${summaryText}${
        checksum.length ? ` + ${autoCrc.toUpperCase()} (${checksum.length}B)` : ''
      }${ok ? '' : ' [engine offline]'}`,
      dissectedFields: [],
      hasError: false,
    });
    recordTx(wireBytes.length);
  };

  const executeCommand = (cmd: UserCommand) => {
    if (cmd.isPeriodic) {
      const isCurrentlyActive = !!activePeriodicIds[cmd.id];
      if (isCurrentlyActive) {
        if (intervalTimersRef.current[cmd.id]) {
          window.clearInterval(intervalTimersRef.current[cmd.id]);
          delete intervalTimersRef.current[cmd.id];
        }
        setActivePeriodicIds((prev) => ({ ...prev, [cmd.id]: false }));
      } else {
        handleSend(cmd.payload);
        const timerId = window.setInterval(() => {
          handleSend(cmd.payload);
        }, Math.max(20, cmd.intervalMs || 100));

        intervalTimersRef.current[cmd.id] = timerId;
        setActivePeriodicIds((prev) => ({ ...prev, [cmd.id]: true }));
      }
    } else {
      setPayload(cmd.payload);
      handleSend(cmd.payload);
    }
  };

  const handleDeleteCommand = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (intervalTimersRef.current[id]) {
      window.clearInterval(intervalTimersRef.current[id]);
      delete intervalTimersRef.current[id];
    }
    setActivePeriodicIds((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    const updated = userCommands.filter((c) => c.id !== id);
    saveCommandsToStorage(updated);
  };

  const handleCreateCommand = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCmdName.trim() || !newCmdPayload.trim()) return;

    const newCmd: UserCommand = {
      id: `cmd-${Date.now()}`,
      name: newCmdName.trim(),
      payload: newCmdPayload.trim(),
      color: newCmdColor,
      iconName: newCmdIcon,
      isPeriodic: newCmdIsPeriodic,
      intervalMs: Math.max(10, newCmdIntervalMs || 100),
    };

    const updated = [...userCommands, newCmd];
    saveCommandsToStorage(updated);

    // Reset and close
    setNewCmdName('');
    setNewCmdPayload('');
    setIsModalOpen(false);
  };

  // Byte box list parsing
  const hexByteList = payload
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((b) => b.replace(/^0x/i, '').padStart(2, '0').slice(-2).toUpperCase());

  const handleByteChange = (index: number, val: string) => {
    const clean = val.replace(/[^0-9a-fA-F]/g, '').slice(0, 2).toUpperCase();
    const updated = [...hexByteList];
    updated[index] = clean;
    setPayload(updated.join(' '));

    // Auto-advance to next byte input if 2 hex chars typed
    if (clean.length === 2 && index < hexByteList.length - 1) {
      byteInputsRef.current[index + 1]?.focus();
      byteInputsRef.current[index + 1]?.select();
    }
  };

  const handleByteKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    const key = e.key;

    if (key === 'Backspace') {
      e.preventDefault();
      const currentVal = hexByteList[index] || '';
      if (currentVal.length > 0 && currentVal !== '00') {
        const updated = [...hexByteList];
        updated[index] = '';
        setPayload(updated.join(' '));
      } else if (index > 0) {
        // Move to previous byte, clear it and select it
        const updated = [...hexByteList];
        updated[index - 1] = '';
        setPayload(updated.join(' '));
        setTimeout(() => {
          byteInputsRef.current[index - 1]?.focus();
          byteInputsRef.current[index - 1]?.select();
        }, 0);
      }
      return;
    }

    if (key === 'Delete') {
      e.preventDefault();
      if (hexByteList.length > 1) {
        handleRemoveByte(index);
        setTimeout(() => {
          const targetIdx = Math.min(index, hexByteList.length - 2);
          byteInputsRef.current[targetIdx]?.focus();
          byteInputsRef.current[targetIdx]?.select();
        }, 0);
      } else {
        setPayload('00');
      }
      return;
    }

    if (key === 'ArrowLeft') {
      if (index > 0) {
        e.preventDefault();
        byteInputsRef.current[index - 1]?.focus();
        byteInputsRef.current[index - 1]?.select();
      }
      return;
    }

    if (key === 'ArrowRight' || key === ' ' || e.code === 'Space') {
      e.preventDefault();
      if (index < hexByteList.length - 1) {
        byteInputsRef.current[index + 1]?.focus();
        byteInputsRef.current[index + 1]?.select();
      } else {
        handleAddByte();
      }
      return;
    }

    if (key === 'Enter') {
      e.preventDefault();
      handleSend();
      return;
    }

    // Direct hex character typing [0-9a-fA-F]
    if (/^[0-9a-fA-F]$/i.test(key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const char = key.toUpperCase();
      const input = e.currentTarget;
      const isSelected =
        input.selectionStart !== input.selectionEnd ||
        (input.selectionStart === 0 && input.selectionEnd === input.value.length);
      const currentVal = hexByteList[index] || '';

      if (isSelected || currentVal.length === 0 || currentVal === '00' || currentVal.length >= 2) {
        // Replace with single character
        const updated = [...hexByteList];
        updated[index] = char;
        setPayload(updated.join(' '));
      } else {
        // Second character typed: form complete 2-char byte
        const newByte = (currentVal + char).slice(0, 2).toUpperCase();
        const updated = [...hexByteList];
        updated[index] = newByte;
        setPayload(updated.join(' '));

        // Auto-advance to next byte or append new byte
        if (index < hexByteList.length - 1) {
          setTimeout(() => {
            byteInputsRef.current[index + 1]?.focus();
            byteInputsRef.current[index + 1]?.select();
          }, 0);
        } else {
          setTimeout(() => {
            const withAppended = [...updated, '00'];
            setPayload(withAppended.join(' '));
            setTimeout(() => {
              byteInputsRef.current[index + 1]?.focus();
              byteInputsRef.current[index + 1]?.select();
            }, 10);
          }, 0);
        }
      }
    }
  };

  const handleAddByte = () => {
    const updated = [...hexByteList, '00'];
    setPayload(updated.join(' '));
    setTimeout(() => {
      const idx = updated.length - 1;
      byteInputsRef.current[idx]?.focus();
      byteInputsRef.current[idx]?.select();
    }, 10);
  };

  const handleRemoveByte = (index: number) => {
    const updated = hexByteList.filter((_, i) => i !== index);
    setPayload(updated.join(' '));
  };

  const handlePasteIntoByteGrid = (e: React.ClipboardEvent, index: number) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text');
    const tokens = text
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/[^0-9a-fA-F]/g, '').padStart(2, '0').slice(-2).toUpperCase())
      .filter(Boolean);

    if (tokens.length > 0) {
      const updated = [...hexByteList];
      updated.splice(index, 1, ...tokens);
      setPayload(updated.join(' '));
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#10141D] select-none text-[11px] relative">
      {/* Header Bar */}
      <div className="h-[28px] bg-[#161C28] border-b border-[#222D3D] px-2.5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1.5">
          <Terminal className="w-3.5 h-3.5 text-[#00E5FF]" />
          <span className="font-mono font-semibold text-[#E2E8F0] tracking-wide text-[10.5px]">
            COMMAND FORGE
          </span>
          <span className="text-[9px] px-1.5 py-0.2 rounded bg-[#00E5FF]/10 text-[#00E5FF] border border-[#00E5FF]/30 font-mono">
            DISPATCH & MACROS
          </span>
        </div>

        {/* Global Format Selector */}
        <div className="flex items-center gap-1">
          <span className="text-[9.5px] text-[#64748B] font-mono mr-1">FORMAT:</span>
          <div className="flex items-center gap-0.5 bg-[#10141D] border border-[#222D3D] rounded px-1 py-0.5 font-mono text-[9.5px]">
            <button
              onClick={() => setMode('hex')}
              data-tooltip="Set format to hexadecimal bytes"
              className={`px-2 py-0.5 rounded transition-colors ${
                mode === 'hex'
                  ? 'bg-[#26324A] text-[#00E5FF] font-bold border border-[#00E5FF]/40'
                  : 'text-[#94A3B8] hover:text-[#E2E8F0]'
              }`}
            >
              HEX
            </button>
            <button
              onClick={() => setMode('ascii')}
              data-tooltip="Set format to ASCII plain characters"
              className={`px-2 py-0.5 rounded transition-colors ${
                mode === 'ascii'
                  ? 'bg-[#26324A] text-[#00E5FF] font-bold border border-[#00E5FF]/40'
                  : 'text-[#94A3B8] hover:text-[#E2E8F0]'
              }`}
            >
              ASCII
            </button>
            <button
              onClick={() => setMode('struct')}
              data-tooltip="Struct form: define fields from a C header and send packed little-endian wire bytes (spec 2.4)"
              className={`px-2 py-0.5 rounded transition-colors ${
                mode === 'struct'
                  ? 'bg-[#26324A] text-[#00E5FF] font-bold border border-[#00E5FF]/40'
                  : 'text-[#94A3B8] hover:text-[#E2E8F0]'
              }`}
            >
              STRUCT
            </button>
          </div>
        </div>
      </div>

      {/* Main 2-Column Split Body with Draggable Separator */}
      <div className="flex-1 p-2 flex flex-row min-h-0 font-mono overflow-hidden">
        {/* Left Column: User-Defined Command Buttons */}
        <div
          style={{ width: `${leftColWidth}px` }}
          className="shrink-0 flex flex-col bg-[#0D111A] border border-[#222D3D] rounded p-2 min-h-0"
        >
          <div className="flex items-center justify-between pb-2 border-b border-[#222D3D] shrink-0 mb-2">
            <div className="flex items-center gap-1.5">
              <Sliders className="w-3.5 h-3.5 text-[#00E5FF]" />
              <span className="text-[10px] font-bold tracking-wider text-[#E2E8F0] uppercase">
                USER COMMANDS
              </span>
              <span className="text-[9px] text-[#64748B]">({userCommands.length})</span>
            </div>
            <button
              onClick={() => setIsModalOpen(true)}
              data-tooltip="Create new custom macro button"
              className="flex items-center gap-1 px-2 py-0.5 bg-[#00E5FF]/10 hover:bg-[#00E5FF]/20 text-[#00E5FF] border border-[#00E5FF]/40 rounded text-[9.5px] font-bold transition-all shadow-[0_0_8px_rgba(0,229,255,0.15)]"
            >
              <Plus className="w-3 h-3" />
              ADD COMMAND
            </button>
          </div>

          {/* Scrollable Command List */}
          <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 min-h-0">
            {userCommands.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-4 text-[#64748B]">
                <Terminal className="w-6 h-6 mb-2 opacity-40 text-[#00E5FF]" />
                <p className="text-[10px]">No user commands defined.</p>
                <p className="text-[9px] text-[#475569] mt-1">
                  Click "+ ADD COMMAND" to define buttons.
                </p>
              </div>
            ) : (
              userCommands.map((cmd) => {
                const IconComponent = ICON_MAP[cmd.iconName] || Zap;
                const isRunning = !!activePeriodicIds[cmd.id];
                const hoverConvertedPayload =
                  mode === 'struct' ? cmd.payload : formatPayloadForHover(cmd.payload, mode);

                return (
                  <div
                    key={cmd.id}
                    data-tooltip={`[${mode.toUpperCase()}]: ${hoverConvertedPayload}`}
                    onClick={() => executeCommand(cmd)}
                    style={{
                      borderColor: isRunning ? cmd.color : `${cmd.color}33`,
                      backgroundColor: isRunning ? `${cmd.color}22` : '#121722',
                    }}
                    className={`group relative flex items-center justify-between p-2 rounded border transition-all cursor-pointer select-none hover:border-opacity-100 ${
                      isRunning
                        ? 'ring-1 shadow-[0_0_10px_rgba(0,229,255,0.2)] animate-pulse'
                        : 'hover:bg-[#161C28]'
                    }`}
                  >
                    {/* Left Icon and Labels */}
                    <div className="flex items-center gap-2 min-w-0 pr-1">
                      <div
                        className="w-5 h-5 rounded flex items-center justify-center shrink-0 border"
                        style={{
                          backgroundColor: `${cmd.color}18`,
                          borderColor: `${cmd.color}55`,
                          color: cmd.color,
                        }}
                      >
                        {isRunning ? (
                          <Square className="w-2.5 h-2.5 fill-current animate-spin" />
                        ) : (
                          <IconComponent className="w-3 h-3" />
                        )}
                      </div>

                      <div className="flex flex-col min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-[#E2E8F0] truncate text-[10.5px]">
                            {cmd.name}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 text-[8.5px] text-[#64748B]">
                          {cmd.isPeriodic ? (
                            <span
                              className={`px-1 py-0.2 rounded font-bold ${
                                isRunning
                                  ? 'bg-[#10B981]/20 text-[#10B981]'
                                  : 'bg-[#F59E0B]/15 text-[#F59E0B]'
                              }`}
                            >
                              {isRunning ? `RUNNING (${cmd.intervalMs}ms)` : `LOOP ${cmd.intervalMs}ms`}
                            </span>
                          ) : (
                            <span className="px-1 py-0.2 rounded bg-[#222D3D] text-[#94A3B8]">
                              SINGLE
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Right Controls: Delete on hover */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={(e) => handleDeleteCommand(e, cmd.id)}
                        data-tooltip="Delete command macro"
                        className="opacity-0 group-hover:opacity-100 p-1 hover:bg-[#EF4444]/20 hover:text-[#EF4444] text-[#64748B] rounded transition-opacity"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Draggable Column Separator (User Request 1) */}
        <div
          onMouseDown={handleSeparatorMouseDown}
          data-tooltip="Drag to resize columns"
          className="w-2.5 mx-0.5 cursor-col-resize hover:bg-[#00E5FF]/20 active:bg-[#00E5FF]/40 rounded transition-all flex items-center justify-center shrink-0 group select-none"
        >
          <div className="w-[2px] h-8 bg-[#222D3D] group-hover:bg-[#00E5FF] group-active:bg-[#00E5FF] rounded transition-colors" />
        </div>

        {/* Right Column: Transmission Payload Composer (Fancy Box Styled Bytes) */}
        <div className="flex-1 flex flex-col bg-[#0D111A] border border-[#222D3D] rounded p-2.5 min-h-0 gap-2.5 overflow-hidden">
          {/* Label Bar & View Switcher */}
          <div className="flex items-center justify-between pb-1 border-b border-[#222D3D] shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-[#64748B] uppercase tracking-wider">
                TRANSMISSION PAYLOAD ({mode.toUpperCase()})
              </span>
              {mode === 'hex' && (
                <div className="flex items-center gap-0.5 bg-[#161C28] border border-[#222D3D] rounded p-0.5 text-[9px]">
                  <button
                    onClick={() => setPayloadViewMode('boxes')}
                    data-tooltip="Byte box cells editor"
                    className={`px-1.5 py-0.2 rounded flex items-center gap-1 ${
                      payloadViewMode === 'boxes'
                        ? 'bg-[#26324A] text-[#00E5FF] font-bold'
                        : 'text-[#64748B] hover:text-[#E2E8F0]'
                    }`}
                  >
                    <Grid className="w-2.5 h-2.5" />
                    BYTE CELLS
                  </button>
                  <button
                    onClick={() => setPayloadViewMode('raw')}
                    data-tooltip="Raw text hex composer"
                    className={`px-1.5 py-0.2 rounded flex items-center gap-1 ${
                      payloadViewMode === 'raw'
                        ? 'bg-[#26324A] text-[#00E5FF] font-bold'
                        : 'text-[#64748B] hover:text-[#E2E8F0]'
                    }`}
                  >
                    <FileText className="w-2.5 h-2.5" />
                    RAW TEXT
                  </button>
                </div>
              )}
            </div>
            <span className="text-[9.5px] text-[#00E5FF] font-mono">
              DESTINATION: {selectedPort || 'DISCONNECTED'}
            </span>
          </div>

          {/* Fancy Box-Styled Bytes Entry or Raw Editor (User Request 2) */}
          <div className="flex-1 flex flex-col gap-1 min-h-[90px] overflow-hidden">
            {mode === 'struct' ? (
              /* Struct Form composer (spec 2.4) */
              <div className="flex-1 bg-[#0A0D13] border border-[#222D3D] rounded p-2 overflow-y-auto flex flex-col gap-2 min-h-0">
                <textarea
                  value={headerSrc}
                  onChange={(e) => setHeaderSrc(e.target.value)}
                  spellCheck={false}
                  className="w-full h-[110px] bg-[#10141D] border border-[#222D3D] rounded p-2 text-[10px] text-[#94A3B8] font-mono focus:border-[#00E5FF] focus:outline-none resize-none shrink-0"
                />
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={handleParseHeader}
                    data-tooltip="Parse the header above into typed composer fields"
                    className="px-2 py-0.5 bg-[#00E5FF]/10 hover:bg-[#00E5FF]/20 text-[#00E5FF] border border-[#00E5FF]/40 rounded text-[9.5px] font-bold"
                  >
                    PARSE STRUCT
                  </button>
                  {parsedStructs.length > 1 && (
                    <select
                      value={selectedStructIdx}
                      onChange={(e) => setSelectedStructIdx(Number(e.target.value))}
                      className="bg-[#10141D] border border-[#222D3D] rounded px-1 py-0.5 text-[9.5px] text-[#E2E8F0] focus:outline-none"
                    >
                      {parsedStructs.map((s, i) => (
                        <option key={s.name} value={i}>
                          {s.name} ({s.size} B)
                        </option>
                      ))}
                    </select>
                  )}
                  {activeStruct && (
                    <span className="text-[9px] text-[#64748B] font-mono">
                      {activeStruct.name} · {activeStruct.fields.length} fields · {activeStruct.size} B packed LE
                    </span>
                  )}
                </div>
                {parseErrors.length > 0 && (
                  <div className="text-[9px] font-mono text-[#FBBF24] bg-[#FBBF24]/10 border border-[#FBBF24]/40 rounded p-1.5 shrink-0">
                    {parseErrors.map((err, i) => (
                      <div key={i}>⚠ {err}</div>
                    ))}
                  </div>
                )}
                {activeStruct && (
                  <div className="grid grid-cols-[1fr_88px_1fr] gap-x-2 gap-y-1 content-start shrink-0">
                    {activeStruct.fields.map((field) => (
                      <React.Fragment key={field.name}>
                        <div className="flex items-center gap-1 min-w-0">
                          <span className="text-[10px] text-[#E2E8F0] font-mono truncate">{field.name}</span>
                          {field.count > 1 && (
                            <span className="text-[8.5px] text-[#64748B]">[{field.count}]</span>
                          )}
                        </div>
                        <span className="text-[9px] text-[#64748B] font-mono text-right">{field.type}</span>
                        <input
                          type="text"
                          value={structValues[field.name] ?? ''}
                          onChange={(e) =>
                            setStructValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                          }
                          placeholder={
                            field.kind === 'chars'
                              ? 'ASCII text (NUL padded)'
                              : field.kind === 'float'
                              ? 'e.g. 0.5'
                              : 'integer'
                          }
                          className="w-full h-[20px] bg-[#121722] border border-[#222D3D] rounded px-1.5 text-[10px] text-[#00E5FF] font-mono focus:border-[#00E5FF] focus:outline-none"
                        />
                      </React.Fragment>
                    ))}
                  </div>
                )}
                {structWire && structWire.errors.length > 0 && (
                  <div className="text-[9px] font-mono text-[#EF4444] shrink-0">
                    {structWire.errors.map((err, i) => (
                      <div key={i}>✗ {err}</div>
                    ))}
                  </div>
                )}
                {structWire && structWire.errors.length === 0 && (
                  <div className="text-[9px] font-mono text-[#10B981] shrink-0">
                    WIRE: {structWire.bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')}
                  </div>
                )}
              </div>
            ) : mode === 'hex' && payloadViewMode === 'boxes' ? (
              <div className="flex-1 bg-[#0A0D13] border border-[#222D3D] rounded p-2 overflow-y-auto flex flex-wrap content-start gap-2">
                {hexByteList.map((byte, idx) => {
                  const val = parseInt(byte, 16);
                  const asciiChar =
                    !isNaN(val) && val >= 32 && val <= 126 ? String.fromCharCode(val) : '·';

                  return (
                    <div
                      key={idx}
                      className="group/byte flex flex-col items-center bg-[#121722] border border-[#222D3D] hover:border-[#00E5FF]/60 focus-within:border-[#00E5FF] focus-within:ring-1 focus-within:ring-[#00E5FF] focus-within:shadow-[0_0_12px_rgba(0,229,255,0.3)] rounded p-1 transition-all"
                    >
                      {/* Byte Index */}
                      <div className="flex items-center justify-between w-full text-[8px] text-[#64748B] font-mono px-0.5">
                        <span>+{idx}</span>
                        <button
                          tabIndex={-1}
                          onClick={() => handleRemoveByte(idx)}
                          className="opacity-0 group-hover/byte:opacity-100 hover:text-[#EF4444] transition-opacity"
                        >
                          ×
                        </button>
                      </div>

                      {/* Byte Input Box (Square with large crisp font) */}
                      <input
                        ref={(el) => {
                          byteInputsRef.current[idx] = el;
                        }}
                        type="text"
                        maxLength={2}
                        value={byte}
                        onFocus={(e) => e.currentTarget.select()}
                        onPaste={(e) => handlePasteIntoByteGrid(e, idx)}
                        onChange={(e) => handleByteChange(idx, e.target.value)}
                        onKeyDown={(e) => handleByteKeyDown(idx, e)}
                        className="w-11 h-11 bg-[#0A0D13] border border-[#1A2230] rounded text-center text-sm font-mono font-bold text-[#00E5FF] focus:outline-none uppercase my-0.5 selection:bg-[#00E5FF]/30"
                      />

                      {/* Decoded ASCII Character Footnote */}
                      <span className="text-[8.5px] font-mono text-[#64748B]">{asciiChar}</span>
                    </div>
                  );
                })}

                {/* Add Byte Button (Square matched height) */}
                <button
                  onClick={handleAddByte}
                  data-tooltip="Append new byte to payload"
                  className="w-11 h-[68px] border border-dashed border-[#222D3D] hover:border-[#00E5FF] hover:bg-[#00E5FF]/10 text-[#64748B] hover:text-[#00E5FF] rounded flex flex-col items-center justify-center transition-colors"
                >
                  <Plus className="w-4 h-4 mb-0.5" />
                  <span className="text-[8px] font-bold">BYTE</span>
                </button>
              </div>
            ) : (
              <textarea
                value={payload}
                onChange={(e) => setPayload(e.target.value)}
                placeholder={
                  mode === 'hex'
                    ? 'Enter hex bytes (e.g. AA 55 04 00 2C)'
                    : 'Enter ASCII text string to send...'
                }
                className="flex-1 w-full bg-[#0A0D13] border border-[#222D3D] rounded p-2 text-xs text-[#E2E8F0] placeholder-[#475569] font-mono focus:border-[#00E5FF] focus:outline-none resize-none"
              />
            )}

            <div className="flex items-center justify-between text-[10px] text-[#64748B] px-1 shrink-0 pt-0.5">
              <span className="text-[#00E5FF]">
                {mode === 'struct'
                  ? structWire && structWire.errors.length === 0
                    ? calculateCrc(
                        structWire.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' '),
                        'hex'
                      )
                    : ''
                  : calculateCrc(payload, mode)}
              </span>
              <span className="text-[#64748B]">
                {mode === 'struct'
                  ? `${structWire?.bytes.length ?? 0} BYTES (packed)`
                  : mode === 'hex'
                  ? `${hexByteList.length} BYTES`
                  : `${payload.length} CHARS`}
              </span>
            </div>
          </div>

          {/* Configuration Settings Bar */}
          <div className="grid grid-cols-2 gap-3 bg-[#161C28] p-2 rounded border border-[#222D3D] text-[11px] shrink-0">
            <div>
              <label className="text-[9.5px] text-[#64748B] block mb-1 font-bold">
                AUTO CHECKSUM
              </label>
              <select
                value={autoCrc}
                onChange={(e) => setAutoCrc(e.target.value)}
                className="w-full bg-[#10141D] border border-[#222D3D] rounded px-2 py-1 text-xs text-[#E2E8F0] focus:outline-none focus:border-[#00E5FF]"
              >
                <option value="none">None</option>
                <option value="crc16">CRC-16-CCITT (0xB4B8 test)</option>
                <option value="crc16modbus">CRC-16-MODBUS</option>
                <option value="crc32">CRC-32C (Castagnoli)</option>
                <option value="sum8">Checksum-8</option>
              </select>
            </div>

            <div>
              <label className="text-[9.5px] text-[#64748B] block mb-1 font-bold">
                LINE TERMINATION
              </label>
              <select
                value={lineEnding}
                onChange={(e) => setLineEnding(e.target.value)}
                className="w-full bg-[#10141D] border border-[#222D3D] rounded px-2 py-1 text-xs text-[#E2E8F0] focus:outline-none focus:border-[#00E5FF]"
              >
                <option value="none">None</option>
                <option value="lf">\n (LF)</option>
                <option value="crlf">\r\n (CRLF)</option>
              </select>
            </div>
          </div>

          {/* Bottom Action Bar */}
          <div className="flex items-center justify-end pt-1 shrink-0">
            <button
              onClick={() => handleSend()}
              disabled={!isConnected}
              data-tooltip="Transmit current payload through selected port"
              data-tooltip-shortcut="Enter"
              className={`flex items-center gap-2 px-5 py-2 rounded font-semibold text-xs transition-all ${
                isConnected
                  ? 'bg-[#00E5FF] text-[#0A0D13] hover:bg-[#38BDF8] shadow-[0_0_12px_rgba(0,229,255,0.35)] cursor-pointer active:scale-95'
                  : 'bg-[#222D3D] text-[#64748B] cursor-not-allowed'
              }`}
            >
              <Send className="w-3.5 h-3.5" />
              TRANSMIT PAYLOAD (ENTER)
            </button>
          </div>
        </div>
      </div>

      {/* Add Command Popup Entry Modal (Without HEX/ASCII toggle per User Request 0) */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-[#121722] border border-[#00E5FF]/40 rounded-lg shadow-[0_0_25px_rgba(0,0,0,0.8)] w-full max-w-md p-4 flex flex-col gap-3 font-mono text-[11px]">
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-2 border-b border-[#222D3D]">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-[#00E5FF]" />
                <span className="font-bold text-[#E2E8F0] text-xs uppercase tracking-wide">
                  DEFINE USER COMMAND
                </span>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-[#64748B] hover:text-[#E2E8F0] p-1 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Entry Form */}
            <form onSubmit={handleCreateCommand} className="flex flex-col gap-3">
              {/* Command Name */}
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-[#64748B] uppercase">Command Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Stream Telemetry, Ping AA55, Soft Reset"
                  value={newCmdName}
                  onChange={(e) => setNewCmdName(e.target.value)}
                  className="bg-[#0A0D13] border border-[#222D3D] rounded px-2.5 py-1.5 text-xs text-[#E2E8F0] focus:border-[#00E5FF] focus:outline-none"
                />
              </div>

              {/* Payload Content (Hex or ASCII - Forge Format Mode controls hover display) */}
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-[#64748B] uppercase">Command Payload</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. AA 55 01 02 03 or status\n"
                  value={newCmdPayload}
                  onChange={(e) => setNewCmdPayload(e.target.value)}
                  className="bg-[#0A0D13] border border-[#222D3D] rounded px-2.5 py-1.5 text-xs text-[#E2E8F0] font-mono focus:border-[#00E5FF] focus:outline-none"
                />
                <span className="text-[8.5px] text-[#64748B]">
                  Hover display converts dynamically based on Command Forge's active HEX/ASCII toggle.
                </span>
              </div>

              {/* Color Selector */}
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-[#64748B] uppercase">Badge Accent Color</label>
                <div className="flex items-center gap-2">
                  {COLOR_PALETTE.map((c) => (
                    <button
                      type="button"
                      key={c.hex}
                      onClick={() => setNewCmdColor(c.hex)}
                      style={{ backgroundColor: c.hex }}
                      className={`w-6 h-6 rounded-full border transition-all flex items-center justify-center ${
                        newCmdColor === c.hex
                          ? 'border-white scale-110 shadow-[0_0_8px_rgba(255,255,255,0.4)]'
                          : 'border-transparent opacity-70 hover:opacity-100'
                      }`}
                      title={c.name}
                    >
                      {newCmdColor === c.hex && <Check className="w-3.5 h-3.5 text-black stroke-3" />}
                    </button>
                  ))}
                </div>
              </div>

              {/* Icon Selector */}
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-[#64748B] uppercase">Engineering Icon</label>
                <div className="grid grid-cols-5 gap-1.5">
                  {Object.entries(ICON_MAP).map(([name, Icon]) => (
                    <button
                      type="button"
                      key={name}
                      onClick={() => setNewCmdIcon(name)}
                      className={`flex flex-col items-center justify-center py-1.5 px-1 rounded border transition-all ${
                        newCmdIcon === name
                          ? 'bg-[#00E5FF]/15 border-[#00E5FF] text-[#00E5FF]'
                          : 'bg-[#161C28] border-[#222D3D] text-[#64748B] hover:text-[#E2E8F0]'
                      }`}
                    >
                      <Icon className="w-4 h-4 mb-0.5" />
                      <span className="text-[8px] truncate">{name}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Execution Mode: Single or Periodic */}
              <div className="flex flex-col gap-1 pt-1 border-t border-[#222D3D]">
                <label className="text-[10px] text-[#64748B] uppercase">Execution Mode</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setNewCmdIsPeriodic(false)}
                    className={`p-2 rounded border text-left transition-all ${
                      !newCmdIsPeriodic
                        ? 'bg-[#00E5FF]/10 border-[#00E5FF] text-[#00E5FF]'
                        : 'bg-[#161C28] border-[#222D3D] text-[#64748B]'
                    }`}
                  >
                    <div className="font-bold text-[10px]">SINGLE SHOT</div>
                    <div className="text-[8.5px] opacity-75">Transmit once on click</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setNewCmdIsPeriodic(true)}
                    className={`p-2 rounded border text-left transition-all ${
                      newCmdIsPeriodic
                        ? 'bg-[#10B981]/15 border-[#10B981] text-[#10B981]'
                        : 'bg-[#161C28] border-[#222D3D] text-[#64748B]'
                    }`}
                  >
                    <div className="font-bold text-[10px]">PERIODIC LOOP</div>
                    <div className="text-[8.5px] opacity-75">Toggleable repeat interval</div>
                  </button>
                </div>
              </div>

              {/* Interval (if periodic) */}
              {newCmdIsPeriodic && (
                <div className="flex items-center justify-between bg-[#161C28] p-2 rounded border border-[#222D3D]">
                  <div className="flex items-center gap-1.5 text-[#E2E8F0]">
                    <Clock className="w-3.5 h-3.5 text-[#10B981]" />
                    <span className="text-[10px] font-bold">Repeat Interval:</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min="10"
                      max="60000"
                      step="10"
                      value={newCmdIntervalMs}
                      onChange={(e) => setNewCmdIntervalMs(Number(e.target.value))}
                      className="w-20 bg-[#0A0D13] border border-[#222D3D] rounded px-2 py-1 text-xs text-[#00E5FF] font-bold text-right focus:outline-none focus:border-[#00E5FF]"
                    />
                    <span className="text-[#64748B] text-[10px]">ms</span>
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#222D3D]">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-3 py-1.5 rounded border border-[#222D3D] text-[#94A3B8] hover:text-[#E2E8F0] transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded bg-[#00E5FF] text-[#0A0D13] font-bold hover:bg-[#38BDF8] transition-colors shadow-[0_0_10px_rgba(0,229,255,0.3)]"
                >
                  Save Command
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
