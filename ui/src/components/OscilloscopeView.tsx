import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { ScopeSignalSample } from '../types';
import { plotEngine, type CatalogEntry, type CachedSpectrum } from '../plot/engine';
import { findTriggerCrossing, type TriggerMode, type TriggerSlope } from '../plot/trigger';
import { renderWaveformsWebGL, type WebGLTrace } from '../plot/webglRenderer';
import { decimateMinMaxInto } from '../plot/decimate';
import { magnitudeSpectrum } from '../plot/fft';
import type { SampleRing } from '../plot/rings';
import {
  Eye,
  EyeOff,
  Play,
  Pause,
  ArrowUpRight,
  ArrowDownRight,
  ArrowUpDown,
  ZoomIn,
  GripHorizontal,
  Activity,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Plus,
  Minus,
} from 'lucide-react';

const TIME_DIV_PRESETS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000]; // ms / division (10 divisions total)
const CH1_SCALE_PRESETS = [50, 100, 200, 500, 1000, 2000, 5000, 10000]; // mV / division
const CH2_SCALE_PRESETS = [0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0]; // rad/s / division
const TRIGGER_MODES: readonly TriggerMode[] = ['AUTO', 'NORM', 'SINGLE', 'ROLL'];
const TRIGGER_SLOPES: readonly TriggerSlope[] = ['RISING', 'FALLING', 'EITHER'];
const MATH_OPERATIONS = ['CH1 - CH2', 'CH1 + CH2', 'CH1 * CH2', 'FFT', 'INV CH1'] as const;
/** Lane colors for bound field traces (spec 5.4). */
const TRACE_COLORS = ['#A855F7', '#F97316', '#38BDF8', '#F472B6', '#84CC16', '#FACC15'];

type MathOp = (typeof MATH_OPERATIONS)[number];
type CursorMode = 'OFF' | 'TIME' | 'VOLT' | 'BOTH';
type CursorChannel = 'CH1' | 'CH2' | 'MATH';
type TriggerSource = 'CH1' | 'CH2';
type LayoutMode = 'OVERLAY' | 'STACKED';
type MarkerId = 'X1' | 'X2' | 'Y1' | 'Y2';
type HoverTarget = { ch: CursorChannel; marker: MarkerId } | 'TRIG' | null;
type TrigBadgeStatus = "TRIG'D" | 'AUTO' | 'ARMED' | 'ROLL' | 'STOPPED';

interface ChannelCursors {
  x1Us: number | null;
  x2Us: number | null;
  y1: number;
  y2: number;
}

interface ScopePalette {
  canvas: string;
  gridMinor: string;
  grid: string;
  gridStrong: string;
  textMuted: string;
  bright: string;
  cyan: string;
  amber: string;
  math: string;
  ok: string;
  sky: string;
  fault: string;
  purple: string;
  warn: string;
}

interface FrozenSnapshot {
  samples: ScopeSignalSample[];
  tMin: number;
  tMax: number;
  maxAvailableUs: number;
  traces: Record<string, Array<{ tUs: number; value: number }>>;
}

interface LaneBounds {
  top: number;
  bottom: number;
}

interface ScopeTransforms {
  width: number;
  height: number;
  analogHeight: number;
  tMin: number;
  tMax: number;
  tSpan: number;
  ch1Min: number;
  ch1Max: number;
  ch2Min: number;
  ch2Max: number;
  mathMin: number;
  mathMax: number;
  ch1Lane: LaneBounds;
  ch2Lane: LaneBounds;
  mathLane: LaneBounds;
  gain1: number;
  gain2: number;
  trigTimeUs: number | null;
  timeToX: (tUs: number) => number;
  xToTime: (x: number) => number;
  voltToY: (v: number) => number;
  yToVolt: (y: number) => number;
  gyroToY: (v: number) => number;
  yToGyro: (y: number) => number;
  mathToY: (v: number) => number;
  yToMath: (y: number) => number;
}

interface ScopeMetrics {
  min1: number;
  max1: number;
  mean1: number;
  pkPk1: number;
  rms1: number;
  count1: number;
  min2: number;
  max2: number;
  pkPk2: number;
  count2: number;
  fftPeakHz: number;
}

const EMPTY_METRICS: ScopeMetrics = {
  min1: 0,
  max1: 0,
  mean1: 0,
  pkPk1: 0,
  rms1: 0,
  count1: 0,
  min2: 0,
  max2: 0,
  pkPk2: 0,
  count2: 0,
  fftPeakHz: 0,
};

let cachedPalette: ScopePalette | null = null;
let cachedPaletteKey = '';

function readThemeKey(): string {
  const el = document.documentElement;
  return `${el.getAttribute('data-bf-theme') ?? ''}|${el.getAttribute('data-bf-mode') ?? ''}`;
}

function invalidateScopePalette(): void {
  cachedPalette = null;
}

/** Cached theme token palette; invalidated via MutationObserver on <html>. */
function scopePalette(): ScopePalette {
  const key = readThemeKey();
  if (cachedPalette && cachedPaletteKey === key) return cachedPalette;
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  cachedPalette = {
    canvas: v('--color-bf-canvas', '#0A0D13'),
    gridMinor: v('--color-bf-line-soft', '#161F2E'),
    grid: v('--color-bf-line', '#222D3D'),
    gridStrong: v('--color-bf-hover', '#1E2638'),
    textMuted: v('--color-bf-faint', '#64748B'),
    bright: v('--color-bf-bright', '#F8FAFC'),
    cyan: v('--color-bf-cyan', '#00E5FF'),
    amber: v('--color-bf-amber', '#FBBF24'),
    math: v('--color-bf-math', '#D946EF'),
    ok: v('--color-bf-ok', '#10B981'),
    sky: v('--color-bf-sky', '#38BDF8'),
    fault: v('--color-bf-fault', '#EF4444'),
    purple: v('--color-bf-purple', '#A855F7'),
    warn: v('--color-bf-warn', '#F59E0B'),
  };
  cachedPaletteKey = key;
  return cachedPalette;
}

/**
 * Simulation dissector reports `v_batt_mv` in Volts (~8.18, unit `'V'`),
 * while scope defaults (7400 mV center, 1000 mV/div) and hardware frames use
 * millivolts. Scale V -> mV on the fly without allocating new ring samples.
 */
function getFieldScaleGain(fieldName: string, unit?: string, ring?: SampleRing): number {
  if (!/v_batt/i.test(fieldName)) return 1;
  const u = unit?.toLowerCase();
  if (u === 'v') return 1000;
  if (u === 'mv') return 1;
  if (ring && ring.length > 0 && Math.abs(ring.lastV) < 100) return 1000;
  return 1;
}

function getDisplayUnit(fieldName: string, unit?: string, gain = 1): string {
  if (/v_batt/i.test(fieldName) && gain === 1000) return 'mV';
  if (unit) return unit;
  if (fieldName === 'gyro_z') return 'rad/s';
  if (fieldName === 'v_batt_mv') return 'mV';
  return '';
}

function isBattMvMode(fieldName: string, unit: string): boolean {
  return /v_batt/i.test(fieldName) || unit.toLowerCase() === 'mv';
}

function formatCompact(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs === 0) return '0';
  if (abs >= 1000) return Math.round(n).toString();
  if (abs >= 10) return n.toFixed(Math.min(1, decimals));
  if (abs >= 0.1) return n.toFixed(decimals);
  return n.toFixed(Math.max(decimals, 3));
}

function formatScaleLabel(scale: number, fieldName: string, unit: string): string {
  if (isBattMvMode(fieldName, unit)) {
    return scale >= 1000 ? `${+(scale / 1000).toFixed(2)} V/div` : `${formatCompact(scale, 0)} mV/div`;
  }
  if (unit === 'rad/s') return `${formatCompact(scale, 2)} r/s/div`;
  return unit ? `${formatCompact(scale, 2)} ${unit}/div` : `${formatCompact(scale, 2)}/div`;
}

function formatChannelVal(val: number, fieldName: string, unit: string): string {
  if (isBattMvMode(fieldName, unit)) return `${(val / 1000).toFixed(2)}V`;
  if (unit === 'rad/s') return `${val.toFixed(2)}r/s`;
  return unit ? `${formatCompact(val, 2)}${unit}` : formatCompact(val, 2);
}

function formatStatVal(val: number, fieldName: string, unit: string): string {
  if (isBattMvMode(fieldName, unit)) return `${Math.round(val)} mV`;
  return unit ? `${formatCompact(val, 3)} ${unit}` : formatCompact(val, 3);
}

/** Snap positive target upward to nearest 1-2-5 decade value. */
function snapNice125Up(target: number): number {
  if (!Number.isFinite(target) || target <= 0) return 1;
  const exp = Math.floor(Math.log10(target));
  const pow = Math.pow(10, exp);
  const mant = target / pow;
  const step = mant <= 1.001 ? 1 : mant <= 2.001 ? 2 : mant <= 5.001 ? 5 : 10;
  return Number((step * pow).toPrecision(6));
}

/** Step current scale one notch up or down on a continuous 1-2-5 ladder. */
function stepNice125(current: number, dir: 'up' | 'down', minVal = 0.001, maxVal = 100000): number {
  const cur = current > 0 && Number.isFinite(current) ? current : 1;
  const exp = Math.floor(Math.log10(cur));
  const pow = Math.pow(10, exp);
  const mant = cur / pow;
  const ladder = [1, 2, 5];
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ladder.length; i++) {
    const d = Math.abs(mant - ladder[i]);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  let nextIdx = bestIdx + (dir === 'up' ? 1 : -1);
  let nextPow = pow;
  if (nextIdx >= ladder.length) {
    nextIdx = 0;
    nextPow *= 10;
  } else if (nextIdx < 0) {
    nextIdx = ladder.length - 1;
    nextPow /= 10;
  }
  const next = Number((ladder[nextIdx] * nextPow).toPrecision(6));
  return Math.max(minVal, Math.min(maxVal, next));
}

function markersEqual(a: HoverTarget, b: HoverTarget): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a === 'string' || typeof b === 'string') return false;
  return a.ch === b.ch && a.marker === b.marker;
}

function lowerBoundByTs<T>(arr: readonly T[], targetUs: number, getTs: (item: T) => number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (getTs(arr[mid]) < targetUs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundByTs<T>(arr: readonly T[], targetUs: number, getTs: (item: T) => number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (getTs(arr[mid]) <= targetUs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Map `[vMin, vMax]` onto pixel band `[innerTop, innerBottom]` inside a full
 * WebGL/2D render rectangle `[rectTop, rectBottom]` without touching sample arrays.
 */
function computeEffectiveYRange(
  vMin: number,
  vMax: number,
  innerTop: number,
  innerBottom: number,
  rectTop: number,
  rectBottom: number
): { yMin: number; yMax: number } {
  const rectH = Math.max(1, rectBottom - rectTop);
  const innerSpan = Math.max(1, innerBottom - innerTop);
  const fLo = (rectBottom - innerBottom) / rectH;
  const fHi = (rectBottom - innerTop) / rectH;
  const fracSpan = Math.max(1e-6, fHi - fLo || innerSpan / rectH);
  const vSpan = vMax - vMin || 1;
  const effSpan = vSpan / fracSpan;
  const yMin = vMin - fLo * effSpan;
  return { yMin, yMax: yMin + effSpan };
}

function strokeTrace2D(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; w: number; h: number },
  tr: WebGLTrace
): void {
  const count = Math.min(tr.count, tr.t.length, tr.v.length);
  const xSpan = tr.xMax - tr.xMin;
  const ySpan = tr.yMax - tr.yMin;
  if (count < 2 || xSpan <= 0 || ySpan <= 0) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  ctx.strokeStyle = tr.color;
  ctx.lineWidth = tr.lineWidth ?? 1.5;
  ctx.globalAlpha = tr.alpha ?? 1;
  ctx.beginPath();
  let penDown = false;
  const invX = rect.w / xSpan;
  const invY = rect.h / ySpan;
  const rectBottom = rect.y + rect.h;

  for (let i = 0; i < count; i++) {
    const tv = tr.t[i];
    const vv = tr.v[i];
    if (!Number.isFinite(tv) || !Number.isFinite(vv)) {
      penDown = false;
      continue;
    }
    const px = rect.x + (tv - tr.xMin) * invX;
    const py = rectBottom - (vv - tr.yMin) * invY;
    if (!penDown) {
      ctx.moveTo(px, py);
      penDown = true;
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawGraticule(
  ctx: CanvasRenderingContext2D,
  width: number,
  top: number,
  bottom: number,
  C: ScopePalette,
  drawTimeGrid = true
): void {
  const h = Math.max(1, bottom - top);
  const cols = 10;
  const rows = 6;

  if (drawTimeGrid) {
    ctx.strokeStyle = C.gridMinor;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= cols * 2; i++) {
      const x = (width / (cols * 2)) * i;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }
  }

  ctx.strokeStyle = C.gridMinor;
  ctx.lineWidth = 0.5;
  for (let j = 0; j <= rows * 2; j++) {
    const y = top + (h / (rows * 2)) * j;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  if (drawTimeGrid) {
    for (let i = 0; i <= cols; i++) {
      const x = (width / cols) * i;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }
  }
  for (let j = 0; j <= rows; j++) {
    const y = top + (h / rows) * j;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Center crosshairs
  ctx.strokeStyle = C.gridStrong;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(0, top + h / 2);
  ctx.lineTo(width, top + h / 2);
  if (drawTimeGrid) {
    ctx.moveTo(width / 2, top);
    ctx.lineTo(width / 2, bottom);
  }
  ctx.stroke();
}

function ensureFloat64Scratch(ref: React.MutableRefObject<Float64Array>, needed: number): Float64Array {
  if (ref.current.length >= needed) return ref.current;
  let cap = Math.max(4096, ref.current.length);
  while (cap < needed) cap *= 2;
  ref.current = new Float64Array(cap);
  return ref.current;
}

function findCrossingInSamples(
  samples: readonly ScopeSignalSample[],
  src: TriggerSource,
  slope: TriggerSlope,
  level: number,
  minUs: number,
  maxUs: number
): { triggered: boolean; triggerTimeUs: number } {
  if (samples.length < 2 || !Number.isFinite(level)) {
    return { triggered: false, triggerTimeUs: samples[samples.length - 1]?.timestampUs ?? 0 };
  }
  const lo = Math.max(0, lowerBoundByTs(samples, minUs, (s) => s.timestampUs) - 1);
  const hi = Math.min(samples.length, upperBoundByTs(samples, maxUs, (s) => s.timestampUs) + 1);
  if (hi - lo < 2) {
    return { triggered: false, triggerTimeUs: samples[samples.length - 1]?.timestampUs ?? 0 };
  }

  let triggered = false;
  let bestTime = samples[samples.length - 1].timestampUs;
  let v0 = src === 'CH1' ? samples[lo].vBattMv : samples[lo].gyroZ;
  for (let i = lo + 1; i < hi; i++) {
    const v1 = src === 'CH1' ? samples[i].vBattMv : samples[i].gyroZ;
    const rising = v0 < level && v1 >= level;
    const falling = v0 > level && v1 <= level;
    const matched = slope === 'RISING' ? rising : slope === 'FALLING' ? falling : rising || falling;
    if (matched && v1 !== v0) {
      const t0 = samples[i - 1].timestampUs;
      const t1 = samples[i].timestampUs;
      bestTime = t0 + ((level - v0) / (v1 - v0)) * (t1 - t0);
      triggered = true;
    }
    v0 = v1;
  }
  return { triggered, triggerTimeUs: bestTime };
}

function readSampleFieldValue(s: ScopeSignalSample, fieldName: string, chIndex: 1 | 2): number {
  if (/v_batt/i.test(fieldName)) return s.vBattMv;
  if (/gyro_z/i.test(fieldName)) return s.gyroZ;
  return chIndex === 1 ? s.vBattMv : s.gyroZ;
}

function computeStatsFromSamples(
  samples: readonly ScopeSignalSample[],
  tMin: number,
  tMax: number
): { min1: number; max1: number; mean1: number; pkPk1: number; rms1: number; count1: number; min2: number; max2: number; pkPk2: number; count2: number } {
  if (!samples.length) {
    return { min1: 0, max1: 0, mean1: 0, pkPk1: 0, rms1: 0, count1: 0, min2: 0, max2: 0, pkPk2: 0, count2: 0 };
  }
  let lo = lowerBoundByTs(samples, tMin, (s) => s.timestampUs);
  let hi = upperBoundByTs(samples, tMax, (s) => s.timestampUs);
  if (hi <= lo) {
    lo = 0;
    hi = samples.length;
  }
  let min1 = Infinity;
  let max1 = -Infinity;
  let sum1 = 0;
  let sumSq1 = 0;
  let min2 = Infinity;
  let max2 = -Infinity;
  const n = hi - lo;
  for (let i = lo; i < hi; i++) {
    const v1 = samples[i].vBattMv;
    const v2 = samples[i].gyroZ;
    if (v1 < min1) min1 = v1;
    if (v1 > max1) max1 = v1;
    sum1 += v1;
    sumSq1 += v1 * v1;
    if (v2 < min2) min2 = v2;
    if (v2 > max2) max2 = v2;
  }
  return {
    min1,
    max1,
    mean1: sum1 / n,
    pkPk1: max1 - min1,
    rms1: Math.sqrt(sumSq1 / n),
    count1: n,
    min2,
    max2,
    pkPk2: max2 - min2,
    count2: n,
  };
}

export const OscilloscopeView: React.FC = () => {
  const {
    scopeSamples,
    ch1Visible,
    ch2Visible,
    logicRailsVisible,
    toggleChannel,
    traceBindings,
    traceSeries,
    traceHidden,
    unbindScopeTrace,
    toggleTraceVisibility,
    seekToTimestamp,
  } = useWorkstationStore(
    useShallow((s) => ({
      scopeSamples: s.scopeSamples,
      ch1Visible: s.ch1Visible,
      ch2Visible: s.ch2Visible,
      logicRailsVisible: s.logicRailsVisible,
      toggleChannel: s.toggleChannel,
      traceBindings: s.traceBindings,
      traceSeries: s.traceSeries,
      traceHidden: s.traceHidden,
      unbindScopeTrace: s.unbindScopeTrace,
      toggleTraceVisibility: s.toggleTraceVisibility,
      seekToTimestamp: s.seekToTimestamp,
    }))
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // DSO Engine State: Run/Stop & Snapshot Freezing
  const [isRunning, setIsRunning] = useState(true);
  const [singleArmed, setSingleArmed] = useState(false);
  const [frozenSnapshot, setFrozenSnapshot] = useState<FrozenSnapshot | null>(null);

  // Channel Field Bindings (from plotEngine catalog)
  const [catalogFields, setCatalogFields] = useState<CatalogEntry[]>(() => plotEngine.catalogList());
  const catalogSigRef = useRef('');
  const [ch1Field, setCh1Field] = useState('v_batt_mv');
  const [ch2Field, setCh2Field] = useState('gyro_z');
  const ch1UserPickedRef = useRef(false);
  const ch2UserPickedRef = useRef(false);

  // Horizontal Timebase: Editable & Presets
  const [timeDivMs, setTimeDivMs] = useState(50);
  const [isEditingTime, setIsEditingTime] = useState(false);
  const [timeInputVal, setTimeInputVal] = useState('50');

  // Channel-Based Horizontal Time Skews (ms)
  const [ch1TimeOffsetMs, setCh1TimeOffsetMs] = useState(0);
  const [ch2TimeOffsetMs, setCh2TimeOffsetMs] = useState(0);
  const [mathTimeOffsetMs, setMathTimeOffsetMs] = useState(0);

  // Channel Vertical Scales & Vertical Centers (Offsets)
  const [ch1ScaleMv, setCh1ScaleMv] = useState(1000);
  const [ch2ScaleRad, setCh2ScaleRad] = useState(0.5);
  const [ch1Center, setCh1Center] = useState(7400);
  const [ch2Center, setCh2Center] = useState(0);
  const [editingCenterCh, setEditingCenterCh] = useState<'CH1' | 'CH2' | null>(null);
  const [centerInputVal, setCenterInputVal] = useState('');
  const [mathScale, setMathScale] = useState(1.0);

  // Trigger Sourcing & Thresholds
  const [triggerSource, setTriggerSource] = useState<TriggerSource>('CH1');
  const [triggerMode, setTriggerMode] = useState<TriggerMode>('AUTO');
  const [triggerSlope, setTriggerSlope] = useState<TriggerSlope>('RISING');
  const [triggerLevelCh1Mv, setTriggerLevelCh1Mv] = useState(7400);
  const [triggerLevelCh2Rad, setTriggerLevelCh2Rad] = useState(0.2);
  const [isEditingTrigLevel, setIsEditingTrigLevel] = useState(false);
  const [trigInputVal, setTrigInputVal] = useState('7400');

  // Layout & Renderer Controls
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('OVERLAY');
  const [gpuAccel, setGpuAccel] = useState(true);

  // Interactive Zoom & Pan State
  const [zoomLevel, setZoomLevel] = useState<number>(1.0);
  const [panOffsetUs, setPanOffsetUs] = useState<number>(0);

  // Independent Marker Cursors Per Channel
  const [cursorTargetChannel, setCursorTargetChannel] = useState<CursorChannel>('CH1');
  const [cursorMode, setCursorMode] = useState<CursorMode>('TIME');
  const [activeMarker, setActiveMarker] = useState<MarkerId>('X1');

  const [channelCursors, setChannelCursors] = useState<Record<CursorChannel, ChannelCursors>>({
    CH1: { x1Us: null, x2Us: null, y1: 7200, y2: 7600 },
    CH2: { x1Us: null, x2Us: null, y1: -0.25, y2: 0.25 },
    MATH: { x1Us: null, x2Us: null, y1: -0.5, y2: 0.5 },
  });

  const [hoveredMarker, setHoveredMarker] = useState<HoverTarget>(null);
  const [draggedMarker, setDraggedMarker] = useState<HoverTarget>(null);

  // Math Channel State
  const [mathVisible, setMathVisible] = useState(false);
  const [mathOp, setMathOp] = useState<MathOp>('CH1 - CH2');

  // Draggable HUD State & Throttled Metrics Snapshot
  const [hudPos, setHudPos] = useState<{ x: number; y: number }>(() => {
    try {
      const raw = localStorage.getItem('bforge_scope_hud_pos');
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return { x: 16, y: 12 };
  });
  const [isDraggingHud, setIsDraggingHud] = useState(false);
  const hudDragStart = useRef({ mouseX: 0, mouseY: 0, startX: 0, startY: 0 });
  const [isHudCollapsed, setIsHudCollapsed] = useState(false);
  const [isHudVisible, setIsHudVisible] = useState(true);
  const [metricsSnapshot, setMetricsSnapshot] = useState<ScopeMetrics>(EMPTY_METRICS);

  // Display samples fallback: frozen snapshot when stopped, or live stream
  const displaySamples = useMemo(() => {
    if (!isRunning && frozenSnapshot) return frozenSnapshot.samples;
    return scopeSamples;
  }, [isRunning, frozenSnapshot, scopeSamples]);

  // ----- Zero-Churn Mutable Refs -----
  const dirtyRef = useRef(true);
  const lastPaintedVersionRef = useRef(-1);
  const lastScopeLenRef = useRef(-1);
  const lastScopeTailTRef = useRef(-1);
  const lastPaintedTraceSeriesRef = useRef(traceSeries);

  const runningRef = useRef(isRunning);
  runningRef.current = isRunning;
  const singleArmedRef = useRef(singleArmed);
  singleArmedRef.current = singleArmed;
  const frozenSnapshotRef = useRef(frozenSnapshot);
  frozenSnapshotRef.current = frozenSnapshot;

  const scopeSamplesRef = useRef(scopeSamples);
  scopeSamplesRef.current = scopeSamples;
  const displaySamplesRef = useRef(displaySamples);
  displaySamplesRef.current = displaySamples;
  const traceBindingsRef = useRef(traceBindings);
  traceBindingsRef.current = traceBindings;
  const traceSeriesRef = useRef(traceSeries);
  traceSeriesRef.current = traceSeries;
  const traceHiddenRef = useRef(traceHidden);
  traceHiddenRef.current = traceHidden;

  // Drag-mutable refs (mutated in mousemove with dirtyRef=true; synced on mouseup / throttled HUD)
  const channelCursorsRef = useRef(channelCursors);
  const panOffsetUsRef = useRef(panOffsetUs);
  const triggerLevelCh1Ref = useRef(triggerLevelCh1Mv);
  const triggerLevelCh2Ref = useRef(triggerLevelCh2Rad);
  const hoveredMarkerRef = useRef<HoverTarget>(null);
  const draggedMarkerRef = useRef<HoverTarget>(null);
  const isPanningRef = useRef(false);
  const panHasMovedRef = useRef(false);
  const panStartRef = useRef({ x: 0, initialPan: 0 });
  const lastDragHudSyncMsRef = useRef(0);

  const isHudVisibleRef = useRef(isHudVisible);
  isHudVisibleRef.current = isHudVisible;
  const isHudCollapsedRef = useRef(isHudCollapsed);
  isHudCollapsedRef.current = isHudCollapsed;
  const lastMetricsSyncMsRef = useRef(0);
  const metricsRef = useRef<ScopeMetrics>(EMPTY_METRICS);
  const lastFftPeakHzRef = useRef(0);

  // Trigger state refs
  const trigStatusRef = useRef<TrigBadgeStatus>('AUTO');
  const normHeldWindowRef = useRef<{ tMin: number; tMax: number; tCross: number; triggered: boolean } | null>(null);
  const lastNormScanTUsRef = useRef<number>(0);
  const singleArmTailTUsRef = useRef<number | null>(null);
  const singleArmTicksRef = useRef(0);

  // Latest computed transforms & render callback refs
  const txRef = useRef<ScopeTransforms | null>(null);
  const renderFnRef = useRef<() => void>(() => {});

  // Reusable Float64 scratch buffers for decimation/FFT/fallback (zero GC inside rAF)
  const fallbackCh1T = useRef(new Float64Array(4096));
  const fallbackCh1V = useRef(new Float64Array(4096));
  const fallbackCh2T = useRef(new Float64Array(4096));
  const fallbackCh2V = useRef(new Float64Array(4096));
  const mathScratchT = useRef(new Float64Array(4096));
  const mathScratchV = useRef(new Float64Array(4096));
  const traceFallbackT = useRef(new Float64Array(4096));
  const traceFallbackV = useRef(new Float64Array(4096));
  const fftFallbackV = useRef(new Float64Array(1024));
  const registeredTraceIdsRef = useRef<Set<string>>(new Set());

  // Sync non-drag React view settings into a snapshot ref and mark canvas dirty
  const viewCfgRef = useRef({
    ch1Visible,
    ch2Visible,
    logicRailsVisible,
    ch1Field,
    ch2Field,
    timeDivMs,
    ch1TimeOffsetMs,
    ch2TimeOffsetMs,
    mathTimeOffsetMs,
    ch1ScaleMv,
    ch2ScaleRad,
    ch1Center,
    ch2Center,
    mathScale,
    triggerSource,
    triggerMode,
    triggerSlope,
    layoutMode,
    gpuAccel,
    zoomLevel,
    cursorTargetChannel,
    cursorMode,
    mathVisible,
    mathOp,
  });

  viewCfgRef.current = {
    ch1Visible,
    ch2Visible,
    logicRailsVisible,
    ch1Field,
    ch2Field,
    timeDivMs,
    ch1TimeOffsetMs,
    ch2TimeOffsetMs,
    mathTimeOffsetMs,
    ch1ScaleMv,
    ch2ScaleRad,
    ch1Center,
    ch2Center,
    mathScale,
    triggerSource,
    triggerMode,
    triggerSlope,
    layoutMode,
    gpuAccel,
    zoomLevel,
    cursorTargetChannel,
    cursorMode,
    mathVisible,
    mathOp,
  };

  useEffect(() => {
    dirtyRef.current = true;
  }, [
    isRunning,
    singleArmed,
    frozenSnapshot,
    ch1Visible,
    ch2Visible,
    logicRailsVisible,
    ch1Field,
    ch2Field,
    timeDivMs,
    ch1TimeOffsetMs,
    ch2TimeOffsetMs,
    mathTimeOffsetMs,
    ch1ScaleMv,
    ch2ScaleRad,
    ch1Center,
    ch2Center,
    mathScale,
    triggerSource,
    triggerMode,
    triggerSlope,
    triggerLevelCh1Mv,
    triggerLevelCh2Rad,
    layoutMode,
    gpuAccel,
    zoomLevel,
    panOffsetUs,
    cursorTargetChannel,
    cursorMode,
    channelCursors,
    mathVisible,
    mathOp,
    traceBindings,
    traceSeries,
    traceHidden,
    displaySamples,
  ]);

  // Register scope channels in plotEngine for deep history (60k-250k rings)
  useEffect(() => {
    const pal = scopePalette();
    plotEngine.ensureChannel({
      id: '__scope_ch1',
      label: `CH1:${ch1Field}`,
      source: { kind: 'field', name: ch1Field },
      color: pal.amber,
      visible: ch1Visible,
      axis: 'y1',
    });
  }, [ch1Field, ch1Visible]);

  useEffect(() => {
    const pal = scopePalette();
    plotEngine.ensureChannel({
      id: '__scope_ch2',
      label: `CH2:${ch2Field}`,
      source: { kind: 'field', name: ch2Field },
      color: pal.cyan,
      visible: ch2Visible,
      axis: 'y2',
    });
  }, [ch2Field, ch2Visible]);

  useEffect(() => {
    const nextIds = new Set<string>();
    for (let i = 0; i < traceBindings.length; i++) {
      const b = traceBindings[i];
      const chId = `__scope_trace_${b.id}`;
      nextIds.add(chId);
      plotEngine.ensureChannel({
        id: chId,
        label: b.name,
        source: { kind: 'field', name: b.name },
        color: TRACE_COLORS[i % TRACE_COLORS.length],
        visible: !traceHidden[b.id],
        axis: 'y2',
        unit: b.unit,
      });
    }
    for (const prevId of registeredTraceIdsRef.current) {
      if (!nextIds.has(prevId)) plotEngine.removeChannel(prevId);
    }
    registeredTraceIdsRef.current = nextIds;
  }, [traceBindings, traceHidden]);

  useEffect(() => {
    return () => {
      plotEngine.removeChannel('__scope_ch1');
      plotEngine.removeChannel('__scope_ch2');
      for (const chId of registeredTraceIdsRef.current) {
        plotEngine.removeChannel(chId);
      }
      registeredTraceIdsRef.current.clear();
    };
  }, []);

  // Theme invalidation via MutationObserver on <html>
  useEffect(() => {
    const observer = new MutationObserver(() => {
      invalidateScopePalette();
      dirtyRef.current = true;
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-bf-theme', 'data-bf-mode'],
    });
    return () => observer.disconnect();
  }, []);

  // ResizeObserver so paused canvas redraws immediately on panel resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      dirtyRef.current = true;
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Helper: sync catalog field names lazily when new protocol fields appear
  const syncCatalogIfChanged = useCallback(() => {
    const list = plotEngine.catalogList();
    let sig = '';
    for (let i = 0; i < list.length; i++) {
      if (i > 0) sig += '|';
      sig += `${list[i].name}:${list[i].unit ?? ''}`;
    }
    if (sig === catalogSigRef.current) return;
    catalogSigRef.current = sig;
    setCatalogFields(list);

    if (list.length > 0 && !ch1UserPickedRef.current) {
      const hasExact = list.some((c) => c.name === viewCfgRef.current.ch1Field);
      if (!hasExact) {
        const batt = list.find((c) => /v_batt/i.test(c.name));
        if (batt) setCh1Field(batt.name);
      }
    }
  }, []);

  // Helper: newest available timestamp across scopeSamples and registered rings
  const getNewestDataTimeUs = useCallback((): number | null => {
    const r1 = plotEngine.getChannelRing('__scope_ch1');
    const r2 = plotEngine.getChannelRing('__scope_ch2');
    const samples = scopeSamplesRef.current;
    let maxT = -Infinity;
    if (r1 && r1.length > 0 && r1.lastT > maxT) maxT = r1.lastT;
    if (r2 && r2.length > 0 && r2.lastT > maxT) maxT = r2.lastT;
    if (samples.length > 0 && samples[samples.length - 1].timestampUs > maxT) {
      maxT = samples[samples.length - 1].timestampUs;
    }
    return Number.isFinite(maxT) ? maxT : null;
  }, []);

  // Helper: compute transforms & trigger-locked window from current refs/rings
  const computeTransforms = useCallback((runTriggerEngine: boolean): ScopeTransforms | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return null;

    const cfg = viewCfgRef.current;
    const r1 = plotEngine.getChannelRing('__scope_ch1');
    const r2 = plotEngine.getChannelRing('__scope_ch2');
    const dSamples = displaySamplesRef.current;

    const ring1Cat = plotEngine.catalogEntry(cfg.ch1Field);
    const ring2Cat = plotEngine.catalogEntry(cfg.ch2Field);
    const gain1 = getFieldScaleGain(cfg.ch1Field, ring1Cat?.unit, r1);
    const gain2 = getFieldScaleGain(cfg.ch2Field, ring2Cat?.unit, r2);

    // Ensure at least one source has data
    const hasRingData = (r1 && r1.length > 0) || (r2 && r2.length > 0);
    if (!hasRingData && !dSamples.length) return null;

    const nominalSpanUs = Math.max(1000, cfg.timeDivMs * 10 * 1000);
    const visibleSpanUs = Math.max(500, nominalSpanUs / cfg.zoomLevel);

    let tMin: number;
    let tMax: number;
    let trigTimeUs: number | null = null;
    const panUs = panOffsetUsRef.current;
    const snap = frozenSnapshotRef.current;

    if (!runningRef.current && snap) {
      const snapCenter = (snap.tMin + snap.tMax) / 2 + panUs;
      tMin = snapCenter - visibleSpanUs / 2;
      tMax = snapCenter + visibleSpanUs / 2;
      trigStatusRef.current = singleArmedRef.current ? 'ARMED' : 'STOPPED';
    } else {
      let tailUs = 100000;
      if (r1 && r1.length > 0) tailUs = Math.max(tailUs === 100000 ? -Infinity : tailUs, r1.lastT);
      if (r2 && r2.length > 0) tailUs = Math.max(tailUs === 100000 ? -Infinity : tailUs, r2.lastT);
      if (dSamples.length > 0) {
        const sLast = dSamples[dSamples.length - 1].timestampUs;
        if (!hasRingData || sLast > tailUs) tailUs = sLast;
      }

      const trigRing = plotEngine.getChannelRing(cfg.triggerSource === 'CH1' ? '__scope_ch1' : '__scope_ch2');
      const trigGain = cfg.triggerSource === 'CH1' ? gain1 : gain2;
      const trigLevelDisp = cfg.triggerSource === 'CH1' ? triggerLevelCh1Ref.current : triggerLevelCh2Ref.current;
      const trigLevelRaw = trigLevelDisp / trigGain;

      if (!runTriggerEngine || cfg.triggerMode === 'ROLL') {
        const tCenter = tailUs - visibleSpanUs / 2 + panUs;
        tMin = tCenter - visibleSpanUs / 2;
        tMax = tCenter + visibleSpanUs / 2;
        if (cfg.triggerMode === 'ROLL') trigStatusRef.current = 'ROLL';
      } else if (cfg.triggerMode === 'AUTO') {
        const half = visibleSpanUs * 0.5;
        let triggered = false;
        let tCross = tailUs;

        if (trigRing && trigRing.length >= 2) {
          // Prefer a crossing with >= half screen of post-trigger telemetry already buffered
          const minA = Math.max(trigRing.tMin, tailUs - visibleSpanUs * 2.5);
          const maxA = tailUs - half;
          if (maxA > minA) {
            const res = findTriggerCrossing(
              trigRing,
              { mode: 'AUTO', slope: cfg.triggerSlope, level: trigLevelRaw, holdoffUs: 0 },
              minA,
              maxA
            );
            triggered = res.triggered;
            tCross = res.triggerTimeUs;
          }
          if (!triggered) {
            const res = findTriggerCrossing(
              trigRing,
              { mode: 'AUTO', slope: cfg.triggerSlope, level: trigLevelRaw, holdoffUs: 0 },
              Math.max(trigRing.tMin, tailUs - visibleSpanUs * 1.25),
              tailUs
            );
            triggered = res.triggered;
            tCross = res.triggerTimeUs;
          }
        } else if (dSamples.length >= 2) {
          const minA = tailUs - visibleSpanUs * 2.5;
          const maxA = tailUs - half;
          let res =
            maxA > minA
              ? findCrossingInSamples(dSamples, cfg.triggerSource, cfg.triggerSlope, trigLevelDisp, minA, maxA)
              : { triggered: false, triggerTimeUs: tailUs };
          if (!res.triggered) {
            res = findCrossingInSamples(
              dSamples,
              cfg.triggerSource,
              cfg.triggerSlope,
              trigLevelDisp,
              tailUs - visibleSpanUs * 1.25,
              tailUs
            );
          }
          triggered = res.triggered;
          tCross = res.triggerTimeUs;
        }

        if (triggered) {
          const tCenter = tCross + panUs;
          tMin = tCenter - half;
          tMax = tCenter + half;
          trigTimeUs = tCross;
          trigStatusRef.current = "TRIG'D";
        } else {
          const tCenter = tailUs - half + panUs;
          tMin = tCenter - half;
          tMax = tCenter + half;
          trigStatusRef.current = 'AUTO';
        }
      } else if (cfg.triggerMode === 'NORM') {
        const half = visibleSpanUs * 0.5;
        let held = normHeldWindowRef.current;

        if (trigRing && trigRing.length >= 2) {
          const prevWatermark =
            lastNormScanTUsRef.current > 0 ? lastNormScanTUsRef.current : Math.max(trigRing.tMin, tailUs - visibleSpanUs);
          const prevIdx = Math.max(0, trigRing.lowerBound(prevWatermark) - 1);
          const scanMin = trigRing.tAt(prevIdx);
          if (tailUs > scanMin) {
            const res = findTriggerCrossing(
              trigRing,
              { mode: 'NORM', slope: cfg.triggerSlope, level: trigLevelRaw, holdoffUs: 0 },
              scanMin,
              tailUs
            );
            lastNormScanTUsRef.current = tailUs;
            if (res.triggered) {
              held = {
                tMin: res.triggerTimeUs - half,
                tMax: res.triggerTimeUs + half,
                tCross: res.triggerTimeUs,
                triggered: true,
              };
              normHeldWindowRef.current = held;
            }
          }
        } else if (dSamples.length >= 2) {
          const prevWatermark = lastNormScanTUsRef.current > 0 ? lastNormScanTUsRef.current : tailUs - visibleSpanUs;
          const res = findCrossingInSamples(
            dSamples,
            cfg.triggerSource,
            cfg.triggerSlope,
            trigLevelDisp,
            prevWatermark,
            tailUs
          );
          lastNormScanTUsRef.current = tailUs;
          if (res.triggered) {
            held = {
              tMin: res.triggerTimeUs - half,
              tMax: res.triggerTimeUs + half,
              tCross: res.triggerTimeUs,
              triggered: true,
            };
            normHeldWindowRef.current = held;
          }
        }

        if (held && held.triggered) {
          const tCenter = held.tCross + panUs;
          tMin = tCenter - half;
          tMax = tCenter + half;
          trigTimeUs = held.tCross;
          trigStatusRef.current = "TRIG'D";
        } else {
          // Hold initial pre-trigger tail until first crossing occurs
          if (!held) {
            held = {
              tMin: tailUs - visibleSpanUs,
              tMax: tailUs,
              tCross: tailUs,
              triggered: false,
            };
            normHeldWindowRef.current = held;
          }
          const baseCenter = (held.tMin + held.tMax) / 2 + panUs;
          tMin = baseCenter - half;
          tMax = baseCenter + half;
          trigStatusRef.current = 'ARMED';
        }
      } else {
        // SINGLE while running/armed
        const tCenter = tailUs - visibleSpanUs / 2 + panUs;
        tMin = tCenter - visibleSpanUs / 2;
        tMax = tCenter + visibleSpanUs / 2;
        trigStatusRef.current = singleArmedRef.current ? 'ARMED' : 'AUTO';
      }
    }

    const tSpan = Math.max(1, tMax - tMin);
    const analogHeight = cfg.logicRailsVisible ? Math.floor(height * 0.7) : Math.max(40, height - 20);

    // Vertical spans
    const ch1Span = Math.max(1e-6, (cfg.ch1ScaleMv * 6) / cfg.zoomLevel);
    const ch1Min = cfg.ch1Center - ch1Span / 2;
    const ch1Max = cfg.ch1Center + ch1Span / 2;

    const ch2Span = Math.max(1e-6, (cfg.ch2ScaleRad * 6) / cfg.zoomLevel);
    const ch2Min = cfg.ch2Center - ch2Span / 2;
    const ch2Max = cfg.ch2Center + ch2Span / 2;

    const mathSpan = Math.max(1e-6, 6.0 / (cfg.mathScale * cfg.zoomLevel));
    const mathMin = -mathSpan / 2;
    const mathMax = mathSpan / 2;

    // Determine lane vertical bounds (OVERLAY vs STACKED)
    let ch1Lane: LaneBounds = { top: 10, bottom: Math.max(20, analogHeight - 10) };
    let ch2Lane: LaneBounds = { top: 10, bottom: Math.max(20, analogHeight - 10) };
    let mathLane: LaneBounds = { top: 10, bottom: Math.max(20, analogHeight - 10) };

    if (cfg.layoutMode === 'STACKED') {
      const keys: string[] = [];
      if (cfg.ch1Visible) keys.push('CH1');
      if (cfg.ch2Visible) keys.push('CH2');
      if (cfg.mathVisible) keys.push('MATH');
      const bindings = traceBindingsRef.current;
      const hidden = traceHiddenRef.current;
      for (let i = 0; i < bindings.length; i++) {
        if (!hidden[bindings[i].id]) keys.push(`TRACE:${bindings[i].id}`);
      }
      const n = Math.max(1, keys.length);
      const laneH = analogHeight / n;
      const pad = Math.min(8, Math.max(3, laneH * 0.1));
      const ch1Idx = keys.indexOf('CH1');
      const ch2Idx = keys.indexOf('CH2');
      const mathIdx = keys.indexOf('MATH');
      if (ch1Idx >= 0) {
        ch1Lane = { top: ch1Idx * laneH + pad, bottom: (ch1Idx + 1) * laneH - pad };
      }
      if (ch2Idx >= 0) {
        ch2Lane = { top: ch2Idx * laneH + pad, bottom: (ch2Idx + 1) * laneH - pad };
      }
      if (mathIdx >= 0) {
        mathLane = { top: mathIdx * laneH + pad, bottom: (mathIdx + 1) * laneH - pad };
      }
    }

    const ch1H = Math.max(1, ch1Lane.bottom - ch1Lane.top);
    const ch2H = Math.max(1, ch2Lane.bottom - ch2Lane.top);
    const mathH = Math.max(1, mathLane.bottom - mathLane.top);

    const timeToX = (tUs: number) => ((tUs - tMin) / tSpan) * width;
    const xToTime = (x: number) => Math.round(tMin + (x / width) * tSpan);

    const voltToY = (val: number) => ch1Lane.bottom - ((val - ch1Min) / ch1Span) * ch1H;
    const yToVolt = (y: number) => {
      const raw = ch1Min + ((ch1Lane.bottom - y) / ch1H) * ch1Span;
      return ch1Span >= 60 ? Math.round(raw) : +raw.toFixed(3);
    };

    const gyroToY = (val: number) => ch2Lane.bottom - ((val - ch2Min) / ch2Span) * ch2H;
    const yToGyro = (y: number) => {
      const raw = ch2Min + ((ch2Lane.bottom - y) / ch2H) * ch2Span;
      return +(raw.toFixed(ch2Span >= 60 ? 1 : 3));
    };

    const mathToY = (val: number) => mathLane.bottom - ((val - mathMin) / mathSpan) * mathH;
    const yToMath = (y: number) => +(mathMin + ((mathLane.bottom - y) / mathH) * mathSpan).toFixed(3);

    const tx: ScopeTransforms = {
      width,
      height,
      analogHeight,
      tMin,
      tMax,
      tSpan,
      ch1Min,
      ch1Max,
      ch2Min,
      ch2Max,
      mathMin,
      mathMax,
      ch1Lane,
      ch2Lane,
      mathLane,
      gain1,
      gain2,
      trigTimeUs,
      timeToX,
      xToTime,
      voltToY,
      yToVolt,
      gyroToY,
      yToGyro,
      mathToY,
      yToMath,
    };
    txRef.current = tx;
    return tx;
  }, []);

  // Capture / Freeze helper shared by STOP and SINGLE
  const freezeAcquisition = useCallback(
    (overrideWindow?: { tMin: number; tMax: number }) => {
      const tx = txRef.current ?? computeTransforms(false);
      const newest = getNewestDataTimeUs() ?? tx?.tMax ?? 0;
      const traceCopy: Record<string, Array<{ tUs: number; value: number }>> = {};
      const srcTraces = traceSeriesRef.current;
      for (const id of Object.keys(srcTraces)) {
        traceCopy[id] = [...(srcTraces[id] ?? [])];
      }
      const snap: FrozenSnapshot = {
        samples: [...scopeSamplesRef.current],
        tMin: overrideWindow?.tMin ?? tx?.tMin ?? 0,
        tMax: overrideWindow?.tMax ?? tx?.tMax ?? 1000,
        maxAvailableUs: newest,
        traces: traceCopy,
      };
      frozenSnapshotRef.current = snap;
      runningRef.current = false;
      singleArmedRef.current = false;
      trigStatusRef.current = 'STOPPED';
      setFrozenSnapshot(snap);
      setIsRunning(false);
      setSingleArmed(false);
      dirtyRef.current = true;
    },
    [computeTransforms, getNewestDataTimeUs]
  );

  // Single-shot arming & catch watcher (reacts to plotEngine data or scopeSamples updates)
  useEffect(() => {
    if (!singleArmed || !isRunning) return;

    const cfg = viewCfgRef.current;
    const r1 = plotEngine.getChannelRing('__scope_ch1');
    const r2 = plotEngine.getChannelRing('__scope_ch2');
    const trigRing = cfg.triggerSource === 'CH1' ? r1 : r2;
    const cat = plotEngine.catalogEntry(cfg.triggerSource === 'CH1' ? cfg.ch1Field : cfg.ch2Field);
    const gain = getFieldScaleGain(cfg.triggerSource === 'CH1' ? cfg.ch1Field : cfg.ch2Field, cat?.unit, trigRing);
    const levelDisp = cfg.triggerSource === 'CH1' ? triggerLevelCh1Ref.current : triggerLevelCh2Ref.current;
    const levelRaw = levelDisp / gain;

    const newest = getNewestDataTimeUs();
    if (newest === null) return;
    if (singleArmTailTUsRef.current !== null && newest <= singleArmTailTUsRef.current) return;

    singleArmTicksRef.current += 1;
    const nominalSpanUs = Math.max(1000, cfg.timeDivMs * 10 * 1000);
    const visibleSpanUs = Math.max(500, nominalSpanUs / cfg.zoomLevel);
    const armSinceT = singleArmTailTUsRef.current ?? newest;

    if (trigRing && trigRing.length >= 2) {
      const scanStartIdx = Math.max(0, trigRing.lowerBound(armSinceT) - 1);
      const scanMin = trigRing.tAt(scanStartIdx);
      const res = findTriggerCrossing(
        trigRing,
        { mode: 'SINGLE', slope: cfg.triggerSlope, level: levelRaw, holdoffUs: 0 },
        scanMin,
        newest
      );
      if (res.triggered) {
        const tCenter = res.triggerTimeUs + panOffsetUsRef.current;
        freezeAcquisition({ tMin: tCenter - visibleSpanUs / 2, tMax: tCenter + visibleSpanUs / 2 });
        return;
      }
    } else if (scopeSamples.length >= 2) {
      const res = findCrossingInSamples(
        scopeSamples,
        cfg.triggerSource,
        cfg.triggerSlope,
        levelDisp,
        armSinceT,
        newest
      );
      if (res.triggered) {
        const tCenter = res.triggerTimeUs + panOffsetUsRef.current;
        freezeAcquisition({ tMin: tCenter - visibleSpanUs / 2, tMax: tCenter + visibleSpanUs / 2 });
        return;
      }
    }

    // Fallback capture on a constant/flat signal after a short wait (~8 new ticks)
    if (singleArmTicksRef.current >= 8) {
      const tCenter = newest - visibleSpanUs / 2 + panOffsetUsRef.current;
      freezeAcquisition({ tMin: tCenter - visibleSpanUs / 2, tMax: tCenter + visibleSpanUs / 2 });
    }
  }, [singleArmed, isRunning, scopeSamples, freezeAcquisition, getNewestDataTimeUs]);

  // Clean RUN / STOP Toggle Handler
  const handleToggleRunStop = useCallback(() => {
    if (runningRef.current) {
      freezeAcquisition();
    } else {
      frozenSnapshotRef.current = null;
      normHeldWindowRef.current = null;
      lastNormScanTUsRef.current = 0;
      runningRef.current = true;
      setFrozenSnapshot(null);
      if (viewCfgRef.current.triggerMode === 'SINGLE') setTriggerMode('AUTO');
      setIsRunning(true);
      dirtyRef.current = true;
    }
  }, [freezeAcquisition]);

  // Single shot trigger arm
  const handleSingleShot = useCallback(() => {
    frozenSnapshotRef.current = null;
    runningRef.current = true;
    singleArmedRef.current = true;
    singleArmTailTUsRef.current = getNewestDataTimeUs();
    singleArmTicksRef.current = 0;
    setFrozenSnapshot(null);
    setIsRunning(true);
    setTriggerMode('SINGLE');
    setSingleArmed(true);
    dirtyRef.current = true;
  }, [getNewestDataTimeUs]);

  // Cycle Row 2 Trigger Mode (AUTO -> NORM -> SINGLE -> ROLL)
  const handleCycleTriggerMode = useCallback(() => {
    setTriggerMode((prev) => {
      const next = TRIGGER_MODES[(TRIGGER_MODES.indexOf(prev) + 1) % TRIGGER_MODES.length];
      normHeldWindowRef.current = null;
      lastNormScanTUsRef.current = 0;
      if (next === 'SINGLE') {
        singleArmTailTUsRef.current = getNewestDataTimeUs();
        singleArmTicksRef.current = 0;
        if (runningRef.current) {
          singleArmedRef.current = true;
          setSingleArmed(true);
        }
      } else {
        singleArmedRef.current = false;
        setSingleArmed(false);
      }
      return next;
    });
  }, [getNewestDataTimeUs]);

  // AUTOSET: fit active visible window min/max for CH1 and CH2 onto the graticule
  const handleAutoset = useCallback(() => {
    const tx = txRef.current ?? computeTransforms(false);
    const tMin = tx?.tMin ?? -Infinity;
    const tMax = tx?.tMax ?? Infinity;
    const snap = frozenSnapshotRef.current;
    const clampMax = !runningRef.current && snap ? snap.maxAvailableUs : tMax;

    const fitChannel = (
      ringId: string,
      fieldName: string,
      chIndex: 1 | 2,
      currentTrig: number
    ): { center: number; scale: number; trig: number } | null => {
      const ring = plotEngine.getChannelRing(ringId);
      const cat = plotEngine.catalogEntry(fieldName);
      const gain = getFieldScaleGain(fieldName, cat?.unit, ring);
      const unit = getDisplayUnit(fieldName, cat?.unit, gain);
      const isMv = isBattMvMode(fieldName, unit);

      let minV = NaN;
      let maxV = NaN;

      if (ring && ring.length > 0 && ring.tMin <= clampMax) {
        const sWin = plotEngine.getStats(ringId, tMin, Math.min(tMax, clampMax));
        const sAll = sWin ?? plotEngine.getStats(ringId, ring.tMin, Math.min(ring.lastT, clampMax));
        if (sAll && sAll.count > 0) {
          minV = sAll.min * gain;
          maxV = sAll.max * gain;
        }
      }

      if (!Number.isFinite(minV) || !Number.isFinite(maxV)) {
        const dSamples = displaySamplesRef.current;
        if (dSamples.length > 0) {
          let lo = lowerBoundByTs(dSamples, tMin, (s) => s.timestampUs);
          let hi = upperBoundByTs(dSamples, clampMax, (s) => s.timestampUs);
          if (hi <= lo) {
            lo = 0;
            hi = dSamples.length;
          }
          let loV = Infinity;
          let hiV = -Infinity;
          for (let i = lo; i < hi; i++) {
            const v = readSampleFieldValue(dSamples[i], fieldName, chIndex);
            if (v < loV) loV = v;
            if (v > hiV) hiV = v;
          }
          if (Number.isFinite(loV) && Number.isFinite(hiV)) {
            minV = loV;
            maxV = hiV;
          }
        }
      }

      if (!Number.isFinite(minV) || !Number.isFinite(maxV)) return null;
      const mid = (minV + maxV) / 2;
      const rawSpan = maxV - minV;
      const magFloor = Math.max(Math.abs(mid) * 0.05, isMv ? 200 : 0.1);
      const padded = rawSpan > 1e-6 ? rawSpan * 1.35 : magFloor;
      const nextScale = snapNice125Up((padded * viewCfgRef.current.zoomLevel) / 6);
      const roundedMid = isMv || Math.abs(mid) >= 50 ? Math.round(mid) : +mid.toFixed(3);
      const nextTrig = currentTrig < minV || currentTrig > maxV ? roundedMid : currentTrig;
      return { center: roundedMid, scale: nextScale, trig: nextTrig };
    };

    const fit1 = fitChannel('__scope_ch1', ch1Field, 1, triggerLevelCh1Ref.current);
    if (fit1) {
      setCh1Center(fit1.center);
      setCh1ScaleMv(fit1.scale);
      triggerLevelCh1Ref.current = fit1.trig;
      setTriggerLevelCh1Mv(fit1.trig);
    }

    const fit2 = fitChannel('__scope_ch2', ch2Field, 2, triggerLevelCh2Ref.current);
    if (fit2) {
      setCh2Center(fit2.center);
      setCh2ScaleRad(fit2.scale);
      triggerLevelCh2Ref.current = fit2.trig;
      setTriggerLevelCh2Rad(fit2.trig);
    }

    dirtyRef.current = true;
  }, [ch1Field, ch2Field, computeTransforms]);

  // Binding selection handler with sensible center/scale initialization
  const handleSelectChannelField = useCallback((ch: 'CH1' | 'CH2', nextField: string) => {
    const isBatt = /v_batt/i.test(nextField);
    const defaultCenter = isBatt ? 7400 : 0;
    const cat = plotEngine.catalogEntry(nextField);

    let initCenter = defaultCenter;
    let initScale = isBatt ? 1000 : 0.5;
    let initTrig = isBatt ? 7400 : 0;

    if (cat && Number.isFinite(cat.lastValue)) {
      const gain = getFieldScaleGain(nextField, cat.unit);
      const v = cat.lastValue * gain;
      if (!isBatt) {
        initCenter = Math.abs(v) >= 50 ? Math.round(v) : +v.toFixed(3);
        initScale = snapNice125Up(Math.max(0.1, Math.abs(v) * 0.25));
        initTrig = initCenter;
      }
    }

    if (ch === 'CH1') {
      ch1UserPickedRef.current = true;
      setCh1Field(nextField);
      setCh1Center(initCenter);
      setCh1ScaleMv(initScale);
      triggerLevelCh1Ref.current = initTrig;
      setTriggerLevelCh1Mv(initTrig);
    } else {
      ch2UserPickedRef.current = true;
      setCh2Field(nextField);
      setCh2Center(initCenter);
      setCh2ScaleRad(initScale);
      triggerLevelCh2Ref.current = initTrig;
      setTriggerLevelCh2Rad(initTrig);
    }
    normHeldWindowRef.current = null;
    dirtyRef.current = true;
  }, []);

  // Preset Stepper Functions
  const stepTimeDiv = (dir: 'up' | 'down') => {
    const idx = TIME_DIV_PRESETS.findIndex((v) => v >= timeDivMs);
    let nextIdx = idx === -1 ? 5 : idx;
    if (dir === 'up') nextIdx = Math.min(TIME_DIV_PRESETS.length - 1, nextIdx + 1);
    else nextIdx = Math.max(0, nextIdx - 1);
    setTimeDivMs(TIME_DIV_PRESETS[nextIdx]);
  };

  const stepCh1Scale = (dir: 'up' | 'down') => {
    setCh1ScaleMv((prev) => stepNice125(prev, dir, 1, 100000));
  };

  const stepCh2Scale = (dir: 'up' | 'down') => {
    setCh2ScaleRad((prev) => stepNice125(prev, dir, 0.005, 100000));
  };

  // ==================== PRIMARY CANVAS RENDERER ====================
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    syncCatalogIfChanged();

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;

    const targetW = Math.round(cssW * dpr);
    const targetH = Math.round(cssH * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const C = scopePalette();
    ctx.fillStyle = C.canvas;
    ctx.fillRect(0, 0, cssW, cssH);

    const tx = computeTransforms(true);
    if (!tx) return;

    const {
      width,
      height,
      analogHeight,
      tMin,
      tMax,
      tSpan,
      ch1Min,
      ch1Max,
      ch2Min,
      ch2Max,
      mathMin,
      mathMax,
      ch1Lane,
      ch2Lane,
      mathLane,
      gain1,
      gain2,
      trigTimeUs,
      timeToX,
      voltToY,
      gyroToY,
    } = tx;

    const cfg = viewCfgRef.current;
    const snap = frozenSnapshotRef.current;
    const freezeCapUs = !runningRef.current && snap ? snap.maxAvailableUs : Infinity;
    const dSamples = displaySamplesRef.current;
    const buckets = Math.max(64, Math.min(2048, Math.floor(width)));

    const ch1Cat = plotEngine.catalogEntry(cfg.ch1Field);
    const ch2Cat = plotEngine.catalogEntry(cfg.ch2Field);
    const ch1Unit = getDisplayUnit(cfg.ch1Field, ch1Cat?.unit, gain1);
    const ch2Unit = getDisplayUnit(cfg.ch2Field, ch2Cat?.unit, gain2);

    // --- 1. Build Ordered Lane Descriptors (STACKED vs OVERLAY) ---
    const bindings = traceBindingsRef.current;
    const hiddenMap = traceHiddenRef.current;
    const visibleBindings: Array<{ binding: { id: string; name: string; unit?: string }; color: string }> = [];
    for (let i = 0; i < bindings.length; i++) {
      if (!hiddenMap[bindings[i].id]) {
        visibleBindings.push({
          binding: bindings[i],
          color: TRACE_COLORS[i % TRACE_COLORS.length],
        });
      }
    }

    // --- 2. Draw Graticule Grid ---
    if (cfg.layoutMode === 'STACKED') {
      const laneDefs: Array<{ label: string; color: string }> = [];
      if (cfg.ch1Visible) laneDefs.push({ label: `CH1 · ${cfg.ch1Field}`, color: C.amber });
      if (cfg.ch2Visible) laneDefs.push({ label: `CH2 · ${cfg.ch2Field}`, color: C.cyan });
      if (cfg.mathVisible) laneDefs.push({ label: `MATH · ${cfg.mathOp}`, color: C.math });
      for (let i = 0; i < visibleBindings.length; i++) {
        laneDefs.push({ label: visibleBindings[i].binding.name, color: visibleBindings[i].color });
      }
      const nLanes = Math.max(1, laneDefs.length);
      const laneH = analogHeight / nLanes;

      // Vertical time divisions spanning full analog area
      ctx.strokeStyle = C.gridMinor;
      ctx.lineWidth = 0.5;
      for (let i = 0; i <= 20; i++) {
        const x = (width / 20) * i;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, analogHeight);
        ctx.stroke();
      }
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      for (let i = 0; i <= 10; i++) {
        const x = (width / 10) * i;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, analogHeight);
        ctx.stroke();
      }

      for (let i = 0; i < nLanes; i++) {
        const lTop = i * laneH;
        const lBot = (i + 1) * laneH;
        drawGraticule(ctx, width, lTop, lBot, C, false);
        if (i > 0) {
          ctx.strokeStyle = C.gridStrong;
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          ctx.moveTo(0, lTop);
          ctx.lineTo(width, lTop);
          ctx.stroke();
        }
        if (laneDefs[i]) {
          ctx.fillStyle = laneDefs[i].color;
          ctx.font = 'bold 10px "JetBrains Mono", monospace';
          ctx.textAlign = 'left';
          ctx.fillText(laneDefs[i].label, 8, lTop + 14);
        }
      }
    } else {
      drawGraticule(ctx, width, 0, analogHeight, C, true);
    }

    // Logic divider line
    if (cfg.logicRailsVisible) {
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, analogHeight);
      ctx.lineTo(width, analogHeight);
      ctx.stroke();
    }

    // --- 3. Time Axis Boundary Indicators ---
    ctx.fillStyle = C.textMuted;
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`-${Math.round(tSpan / 1000)}ms`, 6, analogHeight - 6);
    ctx.textAlign = 'right';
    ctx.fillText('0.0ms', width - 6, analogHeight - 6);

    // Trigger horizontal phase-lock marker along top graticule edge
    if (trigTimeUs !== null && trigTimeUs >= tMin && trigTimeUs <= tMax) {
      const txPos = timeToX(trigTimeUs);
      ctx.strokeStyle = `${C.amber}44`;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(txPos, 0);
      ctx.lineTo(txPos, analogHeight);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = C.amber;
      ctx.beginPath();
      ctx.moveTo(txPos - 5, 0);
      ctx.lineTo(txPos + 5, 0);
      ctx.lineTo(txPos, 7);
      ctx.closePath();
      ctx.fill();
    }

    // Helper: query ring padded 1-sample outside [qMin, qMax] & clamped on STOP
    const r1 = plotEngine.getChannelRing('__scope_ch1');
    const r2 = plotEngine.getChannelRing('__scope_ch2');

    const getRingWindowDecimated = (
      id: string,
      ring: SampleRing,
      qMin: number,
      qMax: number
    ): { t: Float64Array; v: Float64Array; count: number; min: number; max: number } => {
      const cappedMax = Math.min(qMax, freezeCapUs);
      if (ring.length === 0 || ring.tMin > cappedMax || ring.tMax < qMin) {
        return { t: traceFallbackT.current, v: traceFallbackV.current, count: 0, min: 0, max: 0 };
      }
      const { lo, hi } = ring.rangeFor(qMin, cappedMax);
      const padLo = lo > 0 ? ring.tAt(lo - 1) : qMin;
      const padHiRaw = hi < ring.length ? ring.tAt(hi) : cappedMax;
      const padHi = Math.min(padHiRaw, freezeCapUs);
      return plotEngine.getSeriesScratch(id, padLo, Math.max(padLo, padHi), buckets);
    };

    const getSampleFallbackDecimated = (
      chIndex: 1 | 2,
      fieldName: string,
      qMin: number,
      qMax: number,
      outTRef: React.MutableRefObject<Float64Array>,
      outVRef: React.MutableRefObject<Float64Array>
    ): { t: Float64Array; v: Float64Array; count: number; min: number; max: number } => {
      if (!dSamples.length) return { t: outTRef.current, v: outVRef.current, count: 0, min: 0, max: 0 };
      const loRaw = lowerBoundByTs(dSamples, qMin, (s) => s.timestampUs);
      const hiRaw = upperBoundByTs(dSamples, Math.min(qMax, freezeCapUs), (s) => s.timestampUs);
      const lo = loRaw > 0 ? loRaw - 1 : loRaw;
      const hi = hiRaw < dSamples.length ? hiRaw + 1 : hiRaw;
      if (hi - lo < 1) return { t: outTRef.current, v: outVRef.current, count: 0, min: 0, max: 0 };
      const outT = ensureFloat64Scratch(outTRef, buckets * 4);
      const outV = ensureFloat64Scratch(outVRef, buckets * 4);
      const res = decimateMinMaxInto(
        lo,
        hi,
        buckets,
        (i) => dSamples[i].timestampUs,
        (i) => readSampleFieldValue(dSamples[i], fieldName, chIndex),
        outT,
        outV
      );
      return { t: outT, v: outV, count: res.count, min: res.min, max: res.max };
    };

    // Helper: draw one trace or push into overlay batch
    const drawTracesInRect = (rect: { x: number; y: number; w: number; h: number }, traces: WebGLTrace[]) => {
      if (!traces.length) return;
      if (cfg.gpuAccel) {
        const ok = renderWaveformsWebGL(
          ctx,
          { x: rect.x, y: rect.y, w: rect.w, h: rect.h, dpr, phosphor: true },
          traces
        );
        if (ok) return;
      }
      for (let i = 0; i < traces.length; i++) {
        strokeTrace2D(ctx, rect, traces[i]);
      }
    };

    const stackedLaneIndex = (key: string): number => {
      let idx = 0;
      if (cfg.ch1Visible) {
        if (key === 'CH1') return idx;
        idx++;
      }
      if (cfg.ch2Visible) {
        if (key === 'CH2') return idx;
        idx++;
      }
      if (cfg.mathVisible) {
        if (key === 'MATH') return idx;
        idx++;
      }
      for (let i = 0; i < visibleBindings.length; i++) {
        if (key === `TRACE:${visibleBindings[i].binding.id}`) return idx;
        idx++;
      }
      return 0;
    };

    const totalStackedLanes = Math.max(
      1,
      (cfg.ch1Visible ? 1 : 0) + (cfg.ch2Visible ? 1 : 0) + (cfg.mathVisible ? 1 : 0) + visibleBindings.length
    );
    const stackedLaneH = analogHeight / totalStackedLanes;

    const overlayTraces: WebGLTrace[] = [];

    // --- 4. Extract & Render CH1 ---
    if (cfg.ch1Visible) {
      const ch1ShiftUs = cfg.ch1TimeOffsetMs * 1000;
      const qMin1 = tMin - ch1ShiftUs;
      const qMax1 = tMax - ch1ShiftUs;

      let dec1 =
        r1 && r1.length > 0 && r1.tMin <= freezeCapUs
          ? getRingWindowDecimated('__scope_ch1', r1, qMin1, qMax1)
          : { t: fallbackCh1T.current, v: fallbackCh1V.current, count: 0, min: 0, max: 0 };
      let activeGain1 = gain1;
      if (dec1.count === 0 && dSamples.length > 0) {
        dec1 = getSampleFallbackDecimated(1, cfg.ch1Field, qMin1, qMax1, fallbackCh1T, fallbackCh1V);
        activeGain1 = 1;
      }

      if (dec1.count >= 2) {
        const rectTop = cfg.layoutMode === 'STACKED' ? stackedLaneIndex('CH1') * stackedLaneH : 0;
        const rectBottom = cfg.layoutMode === 'STACKED' ? rectTop + stackedLaneH : analogHeight;
        const eff = computeEffectiveYRange(
          ch1Min / activeGain1,
          ch1Max / activeGain1,
          ch1Lane.top,
          ch1Lane.bottom,
          rectTop,
          rectBottom
        );
        const trace: WebGLTrace = {
          t: dec1.t,
          v: dec1.v,
          count: dec1.count,
          xMin: qMin1,
          xMax: qMax1,
          yMin: eff.yMin,
          yMax: eff.yMax,
          color: C.amber,
          lineWidth: 2,
          alpha: 1,
        };
        if (cfg.layoutMode === 'STACKED') {
          drawTracesInRect({ x: 0, y: rectTop, w: width, h: stackedLaneH }, [trace]);
        } else {
          overlayTraces.push(trace);
        }
      }
    }

    // --- 5. Extract & Render CH2 ---
    if (cfg.ch2Visible) {
      const ch2ShiftUs = cfg.ch2TimeOffsetMs * 1000;
      const qMin2 = tMin - ch2ShiftUs;
      const qMax2 = tMax - ch2ShiftUs;

      let dec2 =
        r2 && r2.length > 0 && r2.tMin <= freezeCapUs
          ? getRingWindowDecimated('__scope_ch2', r2, qMin2, qMax2)
          : { t: fallbackCh2T.current, v: fallbackCh2V.current, count: 0, min: 0, max: 0 };
      let activeGain2 = gain2;
      if (dec2.count === 0 && dSamples.length > 0) {
        dec2 = getSampleFallbackDecimated(2, cfg.ch2Field, qMin2, qMax2, fallbackCh2T, fallbackCh2V);
        activeGain2 = 1;
      }

      if (dec2.count >= 2) {
        const rectTop = cfg.layoutMode === 'STACKED' ? stackedLaneIndex('CH2') * stackedLaneH : 0;
        const rectBottom = cfg.layoutMode === 'STACKED' ? rectTop + stackedLaneH : analogHeight;
        const eff = computeEffectiveYRange(
          ch2Min / activeGain2,
          ch2Max / activeGain2,
          ch2Lane.top,
          ch2Lane.bottom,
          rectTop,
          rectBottom
        );
        const trace: WebGLTrace = {
          t: dec2.t,
          v: dec2.v,
          count: dec2.count,
          xMin: qMin2,
          xMax: qMax2,
          yMin: eff.yMin,
          yMax: eff.yMax,
          color: C.cyan,
          lineWidth: 1.75,
          alpha: 1,
        };
        if (cfg.layoutMode === 'STACKED') {
          drawTracesInRect({ x: 0, y: rectTop, w: width, h: stackedLaneH }, [trace]);
        } else {
          overlayTraces.push(trace);
        }
      }
    }

    // --- 6. MATH Channel (Time-domain decimated via scratch OR cached Radix-2 FFT) ---
    let computedFftPeakHz = 0;
    let fftOverlayDraw: (() => void) | null = null;
    let mathTimeBanner = '';

    if (cfg.mathVisible) {
      if (cfg.mathOp === 'FFT') {
        let spec: CachedSpectrum | { freqHz: Float64Array; mag: Float64Array; peakHz: number; sampleRateHz: number } | null = null;
        if (runningRef.current && r1 && r1.length >= 8) {
          let fftSize = 64;
          while (fftSize * 2 <= Math.min(1024, r1.length)) fftSize *= 2;
          fftSize = Math.min(r1.length >= 64 ? fftSize : 32, 1024);
          if (fftSize >= 8) {
            spec = plotEngine.getCachedSpectrum('__scope_ch1', fftSize, 'hann');
          }
        } else if (dSamples.length >= 8) {
          const capN = Math.min(512, dSamples.length);
          let nPow = 8;
          while (nPow * 2 <= capN) nPow *= 2;
          const start = dSamples.length - nPow;
          const buf = ensureFloat64Scratch(fftFallbackV, nPow);
          for (let i = 0; i < nPow; i++) buf[i] = dSamples[start + i].vBattMv;
          const totalDt = dSamples[dSamples.length - 1].timestampUs - dSamples[start].timestampUs;
          const dtSec = totalDt > 0 ? totalDt / (nPow * 1_000_000) : 0.01;
          const sr = 1 / dtSec;
          const s = magnitudeSpectrum(buf.subarray(0, nPow), sr, { detrend: true, window: 'hann' });
          spec = { freqHz: s.freqHz, mag: s.mag, peakHz: s.peakHz, sampleRateHz: sr };
        }

        if (spec && spec.mag.length >= 2) {
          computedFftPeakHz = +spec.peakHz.toFixed(1);
          const mTop = cfg.layoutMode === 'STACKED' ? mathLane.top + 8 : 20;
          const mBot = cfg.layoutMode === 'STACKED' ? mathLane.bottom : analogHeight - 10;
          const availH = Math.max(12, mBot - mTop - 10);
          const specRef = spec;
          fftOverlayDraw = () => {
            const bins = specRef.mag.length;
            let maxMag = 1e-9;
            for (let k = 1; k < bins; k++) {
              const val = specRef.mag[k] * cfg.mathScale;
              if (val > maxMag) maxMag = val;
            }
            const stepX = width / Math.max(1, bins - 1);

            ctx.save();
            ctx.fillStyle = `${C.math}2E`;
            ctx.strokeStyle = C.math;
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(0, mBot);
            for (let k = 1; k < bins; k++) {
              const x = (k - 1) * stepX + stepX * 0.5;
              const norm = Math.min(1, (specRef.mag[k] * cfg.mathScale) / maxMag);
              ctx.lineTo(x, mBot - norm * availH);
            }
            ctx.lineTo(width, mBot);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = C.math;
            ctx.font = 'bold 11px "JetBrains Mono", monospace';
            ctx.textAlign = 'left';
            ctx.fillText(
              `MATH FFT [Peak: ${computedFftPeakHz} Hz · Fs ${Math.round(specRef.sampleRateHz)} Hz]`,
              10,
              cfg.layoutMode === 'STACKED' ? mathLane.top + 22 : 22
            );
            ctx.restore();
          };
        }
      } else {
        const mathShiftUs = cfg.mathTimeOffsetMs * 1000;
        const qMinM = tMin - mathShiftUs;
        const qMaxM = tMax - mathShiftUs;
        const scale1 = Math.max(1e-6, cfg.ch1ScaleMv);
        const scale2 = Math.max(1e-6, cfg.ch2ScaleRad);

        const outMT = ensureFloat64Scratch(mathScratchT, buckets * 4);
        const outMV = ensureFloat64Scratch(mathScratchV, buckets * 4);
        let mCount = 0;

        if (r1 && r1.length > 0 && r1.tMin <= freezeCapUs) {
          const cappedMax = Math.min(qMaxM, freezeCapUs);
          const { lo, hi } = r1.rangeFor(qMinM, cappedMax);
          const pLo = lo > 0 ? lo - 1 : lo;
          const pHi = hi < r1.length && r1.tAt(hi) <= freezeCapUs ? hi + 1 : hi;
          if (pHi - pLo >= 2) {
            let j2 = r2 && r2.length > 0 ? r2.lowerBound(r1.tAt(pLo)) : 0;
            const evalMathRing = (idx: number): number => {
              const v1 = r1.vAt(idx) * gain1;
              const vNorm = (v1 - cfg.ch1Center) / scale1;
              if (cfg.mathOp === 'INV CH1') return -vNorm * cfg.mathScale;

              let v2 = cfg.ch2Center;
              if (r2 && r2.length > 0) {
                const t = r1.tAt(idx);
                while (j2 < r2.length && r2.tAt(j2) < t) j2++;
                if (j2 < r2.length && r2.tAt(j2) === t) v2 = r2.vAt(j2) * gain2;
                else if (j2 > 0) v2 = r2.vAt(j2 - 1) * gain2;
                else v2 = r2.vAt(0) * gain2;
              }
              const gNorm = (v2 - cfg.ch2Center) / scale2;
              if (cfg.mathOp === 'CH1 - CH2') return (vNorm - gNorm) * cfg.mathScale;
              if (cfg.mathOp === 'CH1 + CH2') return (vNorm + gNorm) * cfg.mathScale;
              return vNorm * gNorm * 2 * cfg.mathScale;
            };
            const res = decimateMinMaxInto(pLo, pHi, buckets, (i) => r1.tAt(i), evalMathRing, outMT, outMV);
            mCount = res.count;
          }
        } else if (dSamples.length >= 2) {
          const loRaw = lowerBoundByTs(dSamples, qMinM, (s) => s.timestampUs);
          const hiRaw = upperBoundByTs(dSamples, Math.min(qMaxM, freezeCapUs), (s) => s.timestampUs);
          const pLo = loRaw > 0 ? loRaw - 1 : loRaw;
          const pHi = hiRaw < dSamples.length ? hiRaw + 1 : hiRaw;
          if (pHi - pLo >= 2) {
            const evalMathSample = (idx: number): number => {
              const s = dSamples[idx];
              const vNorm = (readSampleFieldValue(s, cfg.ch1Field, 1) - cfg.ch1Center) / scale1;
              const gNorm = (readSampleFieldValue(s, cfg.ch2Field, 2) - cfg.ch2Center) / scale2;
              switch (cfg.mathOp) {
                case 'CH1 - CH2':
                  return (vNorm - gNorm) * cfg.mathScale;
                case 'CH1 + CH2':
                  return (vNorm + gNorm) * cfg.mathScale;
                case 'CH1 * CH2':
                  return vNorm * gNorm * 2 * cfg.mathScale;
                case 'INV CH1':
                  return -vNorm * cfg.mathScale;
                default:
                  return 0;
              }
            };
            const res = decimateMinMaxInto(
              pLo,
              pHi,
              buckets,
              (i) => dSamples[i].timestampUs,
              evalMathSample,
              outMT,
              outMV
            );
            mCount = res.count;
          }
        }

        if (mCount >= 2) {
          const rectTop = cfg.layoutMode === 'STACKED' ? stackedLaneIndex('MATH') * stackedLaneH : 0;
          const rectBottom = cfg.layoutMode === 'STACKED' ? rectTop + stackedLaneH : analogHeight;
          const eff = computeEffectiveYRange(mathMin, mathMax, mathLane.top, mathLane.bottom, rectTop, rectBottom);
          const trace: WebGLTrace = {
            t: outMT,
            v: outMV,
            count: mCount,
            xMin: qMinM,
            xMax: qMaxM,
            yMin: eff.yMin,
            yMax: eff.yMax,
            color: C.math,
            lineWidth: 1.5,
            alpha: 1,
          };
          if (cfg.layoutMode === 'STACKED') {
            drawTracesInRect({ x: 0, y: rectTop, w: width, h: stackedLaneH }, [trace]);
          } else {
            overlayTraces.push(trace);
          }
        }
        mathTimeBanner = `MATH (${cfg.mathOp}) · ${cfg.mathScale}x`;
      }
    }
    lastFftPeakHzRef.current = computedFftPeakHz;

    // --- 7. Bound Field Trace Lanes (spec 5.4) ---
    const boundTraceLabels: Array<{ text: string; color: string; x: number; y: number }> = [];
    const seriesMap = !runningRef.current && snap ? snap.traces : traceSeriesRef.current;

    for (let bi = 0; bi < visibleBindings.length; bi++) {
      const { binding, color } = visibleBindings[bi];
      const chId = `__scope_trace_${binding.id}`;
      const tRing = plotEngine.getChannelRing(chId);

      let decT: { t: Float64Array; v: Float64Array; count: number; min: number; max: number };
      if (tRing && tRing.length > 0 && tRing.tMin <= freezeCapUs) {
        decT = getRingWindowDecimated(chId, tRing, tMin, tMax);
      } else {
        const pts = seriesMap[binding.id] ?? [];
        if (pts.length >= 2) {
          const loRaw = lowerBoundByTs(pts, tMin, (p) => p.tUs);
          const hiRaw = upperBoundByTs(pts, Math.min(tMax, freezeCapUs), (p) => p.tUs);
          const lo = loRaw > 0 ? loRaw - 1 : loRaw;
          const hi = hiRaw < pts.length ? hiRaw + 1 : hiRaw;
          if (hi - lo >= 2) {
            const outT = ensureFloat64Scratch(traceFallbackT, buckets * 4);
            const outV = ensureFloat64Scratch(traceFallbackV, buckets * 4);
            const res = decimateMinMaxInto(lo, hi, buckets, (i) => pts[i].tUs, (i) => pts[i].value, outT, outV);
            decT = { t: outT, v: outV, count: res.count, min: res.min, max: res.max };
          } else {
            decT = { t: traceFallbackT.current, v: traceFallbackV.current, count: 0, min: 0, max: 0 };
          }
        } else {
          decT = { t: traceFallbackT.current, v: traceFallbackV.current, count: 0, min: 0, max: 0 };
        }
      }

      if (decT.count < 2) continue;

      const spanV = decT.max - decT.min;
      const padV = spanV > 1e-9 ? spanV * 0.1 : Math.max(0.5, Math.abs(decT.min) * 0.1);
      const vLo = decT.min - padV;
      const vHi = decT.max + padV;

      const laneIdx = stackedLaneIndex(`TRACE:${binding.id}`);
      const rectTop = cfg.layoutMode === 'STACKED' ? laneIdx * stackedLaneH : 0;
      const rectBottom = cfg.layoutMode === 'STACKED' ? rectTop + stackedLaneH : analogHeight;
      const lanePad = cfg.layoutMode === 'STACKED' ? Math.min(8, Math.max(3, stackedLaneH * 0.1)) : 8;
      const innerTop = cfg.layoutMode === 'STACKED' ? rectTop + lanePad : analogHeight * 0.52;
      const innerBottom = cfg.layoutMode === 'STACKED' ? rectBottom - lanePad : analogHeight - 8;

      const eff = computeEffectiveYRange(vLo, vHi, innerTop, innerBottom, rectTop, rectBottom);
      const trace: WebGLTrace = {
        t: decT.t,
        v: decT.v,
        count: decT.count,
        xMin: tMin,
        xMax: tMax,
        yMin: eff.yMin,
        yMax: eff.yMax,
        color,
        lineWidth: 1.5,
        alpha: 0.9,
      };

      if (cfg.layoutMode === 'STACKED') {
        drawTracesInRect({ x: 0, y: rectTop, w: width, h: stackedLaneH }, [trace]);
      } else {
        overlayTraces.push(trace);
      }

      const labelY =
        cfg.layoutMode === 'STACKED'
          ? rectTop + 14
          : Math.min(analogHeight - 16, 40 + bi * 14);
      boundTraceLabels.push({
        text: `${binding.name}: ${decT.min.toFixed(1)}..${decT.max.toFixed(1)}${binding.unit ? ' ' + binding.unit : ''}`,
        color,
        x: width - 8,
        y: labelY,
      });
    }

    // Flush batched overlay waveforms in one WebGL2 / 2D pass
    if (cfg.layoutMode === 'OVERLAY' && overlayTraces.length > 0) {
      drawTracesInRect({ x: 0, y: 0, w: width, h: analogHeight }, overlayTraces);
    }

    // FFT polygon + banners drawn cleanly atop grid/traces
    if (fftOverlayDraw) fftOverlayDraw();
    if (mathTimeBanner) {
      ctx.fillStyle = C.math;
      ctx.font = 'bold 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(mathTimeBanner, 10, cfg.layoutMode === 'STACKED' ? mathLane.top + 26 : 22);
    }

    for (let i = 0; i < boundTraceLabels.length; i++) {
      const lbl = boundTraceLabels[i];
      ctx.fillStyle = lbl.color;
      ctx.font = 'bold 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(lbl.text, lbl.x, lbl.y);
    }

    // --- 8. Trigger Level Line & Right-Edge Marker ---
    const isCh1Trig = cfg.triggerSource === 'CH1';
    const trigDispLevel = isCh1Trig ? triggerLevelCh1Ref.current : triggerLevelCh2Ref.current;
    const trigY = isCh1Trig ? voltToY(trigDispLevel) : gyroToY(trigDispLevel);
    const trigColor = isCh1Trig ? C.amber : C.cyan;
    const trigField = isCh1Trig ? cfg.ch1Field : cfg.ch2Field;
    const trigUnit = isCh1Trig ? ch1Unit : ch2Unit;
    const trigLabel = `T: ${formatChannelVal(trigDispLevel, trigField, trigUnit)}`;

    if (trigY >= 0 && trigY <= analogHeight) {
      const isTrigHovered = hoveredMarkerRef.current === 'TRIG' || draggedMarkerRef.current === 'TRIG';
      ctx.strokeStyle = isTrigHovered ? C.bright : `${trigColor}88`;
      ctx.lineWidth = isTrigHovered ? 2 : 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, trigY);
      ctx.lineTo(width, trigY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = isTrigHovered ? C.bright : trigColor;
      ctx.beginPath();
      ctx.moveTo(width - 12, trigY);
      ctx.lineTo(width, trigY - 6);
      ctx.lineTo(width, trigY + 6);
      ctx.closePath();
      ctx.fill();

      ctx.font = 'bold 10px "JetBrains Mono", monospace';
      const labelW = Math.max(58, Math.ceil(ctx.measureText(trigLabel).width) + 8);
      const pillX = width - labelW - 14;
      ctx.fillStyle = isTrigHovered ? C.bright : `${trigColor}CC`;
      ctx.fillRect(pillX, trigY - 9, labelW, 18);
      ctx.fillStyle = C.canvas;
      ctx.textAlign = 'center';
      ctx.fillText(trigLabel, pillX + labelW / 2, trigY + 3.5);
    }

    // --- 9. Digital Logic State Rails (binary search + pixel-column decimation) ---
    if (cfg.logicRailsVisible) {
      const logicHeight = height - analogHeight;
      const railCount = 3;
      const railStep = logicHeight / railCount;
      const railLabels = ['D0: RUN', 'D1: ARMED', 'D2: FAULT'];
      const railColors = [C.ok, C.sky, C.fault];

      const loL = dSamples.length > 0 ? Math.max(0, lowerBoundByTs(dSamples, tMin, (s) => s.timestampUs) - 1) : 0;
      const hiL =
        dSamples.length > 0
          ? Math.min(dSamples.length, upperBoundByTs(dSamples, Math.min(tMax, freezeCapUs), (s) => s.timestampUs) + 1)
          : 0;

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, analogHeight, width, logicHeight);
      ctx.clip();

      for (let r = 0; r < railCount; r++) {
        const baseY = analogHeight + (r + 1) * railStep - 4;
        const highY = baseY - Math.max(4, railStep - 8);

        ctx.strokeStyle = C.gridStrong;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, baseY);
        ctx.lineTo(width, baseY);
        ctx.stroke();

        ctx.fillStyle = C.textMuted;
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(railLabels[r], 6, baseY - 2);

        if (hiL - loL < 1) continue;

        ctx.strokeStyle = railColors[r];
        ctx.lineWidth = 1.5;
        ctx.beginPath();

        let prevBit = dSamples[loL].flags[r] ? 1 : 0;
        let lastPx = Math.floor(timeToX(dSamples[loL].timestampUs));
        let colToggle = false;
        let colEndBit = prevBit;
        ctx.moveTo(lastPx, prevBit ? highY : baseY);

        for (let idx = loL + 1; idx < hiL; idx++) {
          const sample = dSamples[idx];
          const px = Math.floor(timeToX(sample.timestampUs));
          const bit = sample.flags[r] ? 1 : 0;
          if (px === lastPx) {
            if (bit !== colEndBit) colToggle = true;
            colEndBit = bit;
          } else {
            if (colToggle) {
              ctx.lineTo(lastPx, colEndBit ? baseY : highY);
              ctx.lineTo(lastPx, colEndBit ? highY : baseY);
            }
            const yNext = bit ? highY : baseY;
            if (bit !== colEndBit) {
              ctx.lineTo(px, colEndBit ? highY : baseY);
            }
            ctx.lineTo(px, yNext);
            lastPx = px;
            colEndBit = bit;
            colToggle = false;
          }
        }
        if (colToggle) {
          ctx.lineTo(lastPx, colEndBit ? baseY : highY);
          ctx.lineTo(lastPx, colEndBit ? highY : baseY);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // --- 10. Active Channel Cursors ---
    if (cfg.cursorMode !== 'OFF') {
      const ch = cfg.cursorTargetChannel;
      const cursors = channelCursorsRef.current[ch];
      const chColor = ch === 'CH1' ? C.amber : ch === 'CH2' ? C.cyan : C.math;
      const hm = hoveredMarkerRef.current;
      const dm = draggedMarkerRef.current;

      const isActiveM = (m: MarkerId) =>
        (hm && typeof hm === 'object' && hm.ch === ch && hm.marker === m) ||
        (dm && typeof dm === 'object' && dm.ch === ch && dm.marker === m);

      if (cfg.cursorMode === 'TIME' || cfg.cursorMode === 'BOTH') {
        const drawVCursor = (us: number | null, marker: 'X1' | 'X2') => {
          if (us === null || us < tMin || us > tMax) return;
          const x = timeToX(us);
          const hot = isActiveM(marker);
          ctx.strokeStyle = hot ? C.bright : chColor;
          ctx.lineWidth = hot ? 2.2 : 1.6;
          ctx.setLineDash([4, 2]);
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.font = 'bold 10px "JetBrains Mono", monospace';
          const lbl = `${ch}:${marker}`;
          const tagW = Math.max(40, Math.ceil(ctx.measureText(lbl).width) + 8);
          const tagY = marker === 'X1' ? 2 : 18;
          ctx.fillStyle = hot ? C.bright : chColor;
          ctx.fillRect(x - tagW / 2, tagY, tagW, 15);
          ctx.fillStyle = C.canvas;
          ctx.textAlign = 'center';
          ctx.fillText(lbl, x, tagY + 11);
        };
        drawVCursor(cursors.x1Us, 'X1');
        drawVCursor(cursors.x2Us, 'X2');
      }

      if (cfg.cursorMode === 'VOLT' || cfg.cursorMode === 'BOTH') {
        const yFn = ch === 'CH1' ? tx.voltToY : ch === 'CH2' ? tx.gyroToY : tx.mathToY;
        const y1Pos = yFn(cursors.y1);
        const y2Pos = yFn(cursors.y2);
        const y1Text =
          ch === 'CH1'
            ? `Y1 ${formatChannelVal(cursors.y1, cfg.ch1Field, ch1Unit)}`
            : ch === 'CH2'
            ? `Y1 ${formatChannelVal(cursors.y1, cfg.ch2Field, ch2Unit)}`
            : `Y1 ${cursors.y1.toFixed(2)}`;
        const y2Text =
          ch === 'CH1'
            ? `Y2 ${formatChannelVal(cursors.y2, cfg.ch1Field, ch1Unit)}`
            : ch === 'CH2'
            ? `Y2 ${formatChannelVal(cursors.y2, cfg.ch2Field, ch2Unit)}`
            : `Y2 ${cursors.y2.toFixed(2)}`;

        ctx.font = 'bold 10px "JetBrains Mono", monospace';
        const y1W = Math.max(68, Math.ceil(ctx.measureText(y1Text).width) + 10);
        const y2W = Math.max(68, Math.ceil(ctx.measureText(y2Text).width) + 10);

        const drawHCursor = (yPos: number, marker: 'Y1' | 'Y2', label: string, pillX: number, pillW: number, baseColor: string) => {
          if (yPos < 0 || yPos > analogHeight) return;
          const hot = isActiveM(marker);
          ctx.strokeStyle = hot ? C.bright : baseColor;
          ctx.lineWidth = hot ? 2.2 : 1.6;
          ctx.setLineDash([4, 2]);
          ctx.beginPath();
          ctx.moveTo(0, yPos);
          ctx.lineTo(width, yPos);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = hot ? C.bright : baseColor;
          ctx.fillRect(pillX, yPos - 9, pillW, 18);
          ctx.fillStyle = C.canvas;
          ctx.font = 'bold 10px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText(label, pillX + pillW / 2, yPos + 3.5);
        };

        drawHCursor(y1Pos, 'Y1', y1Text, 2, y1W, C.ok);
        drawHCursor(y2Pos, 'Y2', y2Text, 6 + y1W, y2W, C.purple);
      }
    }

    // --- 11. Trigger / Stopped / Armed Status Badge (Top Right) ---
    const badgeStatus = !runningRef.current
      ? singleArmedRef.current
        ? '● ARMED SINGLE'
        : '■ STOPPED'
      : singleArmedRef.current
      ? '● ARMED SINGLE'
      : trigStatusRef.current === "TRIG'D"
      ? "● TRIG'D"
      : trigStatusRef.current === 'ARMED'
      ? '◐ ARMED'
      : trigStatusRef.current === 'ROLL'
      ? '▶ ROLL'
      : '◎ AUTO';

    const badgeColor = !runningRef.current
      ? C.fault
      : singleArmedRef.current || trigStatusRef.current === 'ARMED'
      ? C.warn
      : trigStatusRef.current === "TRIG'D"
      ? C.ok
      : trigStatusRef.current === 'ROLL'
      ? C.sky
      : C.cyan;

    ctx.fillStyle = `${badgeColor}22`;
    ctx.strokeStyle = badgeColor;
    ctx.lineWidth = 1;
    const badgeW = singleArmedRef.current ? 124 : 98;
    ctx.fillRect(width - badgeW - 10, 8, badgeW, 22);
    ctx.strokeRect(width - badgeW - 10, 8, badgeW, 22);
    ctx.fillStyle = badgeColor;
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(badgeStatus, width - badgeW / 2 - 10, 23);

    // --- 12. Update Waveform Metrics (O(N/64) via plotEngine mipmap, throttled for HUD) ---
    const nowMs = performance.now();
    const shouldSyncMetrics =
      !runningRef.current ||
      metricsRef.current.count1 === 0 ||
      (isHudVisibleRef.current && !isHudCollapsedRef.current && nowMs - lastMetricsSyncMsRef.current >= 150);

    if (shouldSyncMetrics) {
      let nextMetrics: ScopeMetrics | null = null;
      const s1 =
        r1 && r1.length > 0 && r1.tMin <= freezeCapUs
          ? plotEngine.getStats('__scope_ch1', tMin, Math.min(tMax, freezeCapUs)) ??
            plotEngine.getStats('__scope_ch1', r1.tMin, Math.min(r1.lastT, freezeCapUs))
          : null;
      const s2 =
        r2 && r2.length > 0 && r2.tMin <= freezeCapUs
          ? plotEngine.getStats('__scope_ch2', tMin, Math.min(tMax, freezeCapUs)) ??
            plotEngine.getStats('__scope_ch2', r2.tMin, Math.min(r2.lastT, freezeCapUs))
          : null;

      if (s1 || s2) {
        nextMetrics = {
          min1: s1 ? s1.min * gain1 : 0,
          max1: s1 ? s1.max * gain1 : 0,
          mean1: s1 ? s1.mean * gain1 : 0,
          pkPk1: s1 ? s1.pkPk * gain1 : 0,
          rms1: s1 ? s1.rms * gain1 : 0,
          count1: s1 ? s1.count : 0,
          min2: s2 ? s2.min * gain2 : 0,
          max2: s2 ? s2.max * gain2 : 0,
          pkPk2: s2 ? s2.pkPk * gain2 : 0,
          count2: s2 ? s2.count : 0,
          fftPeakHz: computedFftPeakHz,
        };
      } else if (dSamples.length > 0) {
        const fb = computeStatsFromSamples(dSamples, tMin, Math.min(tMax, freezeCapUs));
        nextMetrics = { ...fb, fftPeakHz: computedFftPeakHz };
      }

      if (nextMetrics) {
        const prev = metricsRef.current;
        if (
          prev.count1 !== nextMetrics.count1 ||
          prev.min1 !== nextMetrics.min1 ||
          prev.max1 !== nextMetrics.max1 ||
          prev.min2 !== nextMetrics.min2 ||
          prev.max2 !== nextMetrics.max2 ||
          prev.fftPeakHz !== nextMetrics.fftPeakHz
        ) {
          metricsRef.current = nextMetrics;
          lastMetricsSyncMsRef.current = nowMs;
          setMetricsSnapshot(nextMetrics);
        }
      }
    }
  }, [computeTransforms, syncCatalogIfChanged]);

  renderFnRef.current = renderCanvas;

  // Clean gated rAF loop: idle ~0% CPU when paused and static
  useEffect(() => {
    let animId = 0;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      const engVer = plotEngine.getDataVersion();
      const samples = scopeSamplesRef.current;
      const sLen = samples.length;
      const sTail = sLen > 0 ? samples[sLen - 1].timestampUs : -1;
      const tSeries = traceSeriesRef.current;

      const dataChanged =
        runningRef.current &&
        (engVer !== lastPaintedVersionRef.current ||
          sLen !== lastScopeLenRef.current ||
          sTail !== lastScopeTailTRef.current ||
          tSeries !== lastPaintedTraceSeriesRef.current);

      if (dirtyRef.current || dataChanged) {
        dirtyRef.current = false;
        lastPaintedVersionRef.current = engVer;
        lastScopeLenRef.current = sLen;
        lastScopeTailTRef.current = sTail;
        lastPaintedTraceSeriesRef.current = tSeries;
        renderFnRef.current();
      }
      animId = requestAnimationFrame(tick);
    };
    animId = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(animId);
    };
  }, []);

  // Wheel timebase zoom (non-passive native listener)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.25 : 0.8;
      setZoomLevel((prev) => Math.min(10.0, Math.max(0.2, Math.round(prev * factor * 100) / 100)));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  // Helper: sync drag refs back into React state (on mouseup / mouseleave / throttled HUD)
  const syncDragRefsToState = useCallback((force: boolean) => {
    const now = performance.now();
    if (!force) {
      if (!isHudVisibleRef.current || isHudCollapsedRef.current) return;
      if (now - lastDragHudSyncMsRef.current < 120) return;
    }
    lastDragHudSyncMsRef.current = now;
    setChannelCursors({ ...channelCursorsRef.current });
    setPanOffsetUs(panOffsetUsRef.current);
    setTriggerLevelCh1Mv(triggerLevelCh1Ref.current);
    setTriggerLevelCh2Rad(triggerLevelCh2Ref.current);
  }, []);

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!txRef.current && !computeTransforms(false)) return;

    if (hoveredMarkerRef.current) {
      draggedMarkerRef.current = hoveredMarkerRef.current;
      setDraggedMarker(hoveredMarkerRef.current);
      return;
    }

    isPanningRef.current = true;
    panHasMovedRef.current = false;
    panStartRef.current = {
      x: e.clientX,
      initialPan: panOffsetUsRef.current,
    };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const tx = txRef.current ?? computeTransforms(false);
    if (!tx) return;
    const cfg = viewCfgRef.current;

    // 1. Live Marker Dragging (zero 60Hz JSX churn — mutates refs + dirtyRef)
    const activeDrag = draggedMarkerRef.current;
    if (activeDrag) {
      if (activeDrag === 'TRIG') {
        if (cfg.triggerSource === 'CH1') {
          triggerLevelCh1Ref.current = Math.max(tx.ch1Min, Math.min(tx.ch1Max, tx.yToVolt(mouseY)));
        } else {
          triggerLevelCh2Ref.current = Math.max(tx.ch2Min, Math.min(tx.ch2Max, tx.yToGyro(mouseY)));
        }
        normHeldWindowRef.current = null;
        lastNormScanTUsRef.current = 0;
      } else {
        const { ch, marker } = activeDrag;
        const nextCh = { ...channelCursorsRef.current[ch] };
        if (marker === 'X1') {
          nextCh.x1Us = Math.max(tx.tMin, Math.min(tx.tMax, tx.xToTime(mouseX)));
        } else if (marker === 'X2') {
          nextCh.x2Us = Math.max(tx.tMin, Math.min(tx.tMax, tx.xToTime(mouseX)));
        } else if (marker === 'Y1') {
          if (ch === 'CH1') nextCh.y1 = Math.max(tx.ch1Min, Math.min(tx.ch1Max, tx.yToVolt(mouseY)));
          else if (ch === 'CH2') nextCh.y1 = Math.max(tx.ch2Min, Math.min(tx.ch2Max, tx.yToGyro(mouseY)));
          else nextCh.y1 = Math.max(tx.mathMin, Math.min(tx.mathMax, tx.yToMath(mouseY)));
        } else if (marker === 'Y2') {
          if (ch === 'CH1') nextCh.y2 = Math.max(tx.ch1Min, Math.min(tx.ch1Max, tx.yToVolt(mouseY)));
          else if (ch === 'CH2') nextCh.y2 = Math.max(tx.ch2Min, Math.min(tx.ch2Max, tx.yToGyro(mouseY)));
          else nextCh.y2 = Math.max(tx.mathMin, Math.min(tx.mathMax, tx.yToMath(mouseY)));
        }
        channelCursorsRef.current = { ...channelCursorsRef.current, [ch]: nextCh };
      }
      dirtyRef.current = true;
      syncDragRefsToState(false);
      return;
    }

    // 2. Waveform Pan Dragging (only after 4px threshold so clicks stay crisp)
    if (isPanningRef.current) {
      const deltaX = e.clientX - panStartRef.current.x;
      if (panHasMovedRef.current || Math.abs(deltaX) >= 4) {
        panHasMovedRef.current = true;
        const nominalSpanUs = cfg.timeDivMs * 10 * 1000;
        const visibleSpanUs = nominalSpanUs / cfg.zoomLevel;
        const usPerPx = visibleSpanUs / Math.max(1, canvas.clientWidth);
        panOffsetUsRef.current = panStartRef.current.initialPan - deltaX * usPerPx;
        dirtyRef.current = true;
      }
      return;
    }

    // 3. Hover Detection (update React state ONLY when target actually transitions)
    let detected: HoverTarget = null;
    const threshold = 8;

    const isCh1Trig = cfg.triggerSource === 'CH1';
    const trigY = isCh1Trig
      ? tx.voltToY(triggerLevelCh1Ref.current)
      : tx.gyroToY(triggerLevelCh2Ref.current);
    if (trigY >= 0 && trigY <= tx.analogHeight && Math.abs(mouseY - trigY) <= threshold) {
      detected = 'TRIG';
    }

    if (!detected && cfg.cursorMode !== 'OFF') {
      const ch = cfg.cursorTargetChannel;
      const cursors = channelCursorsRef.current[ch];

      if (cfg.cursorMode === 'TIME' || cfg.cursorMode === 'BOTH') {
        if (cursors.x1Us !== null && Math.abs(mouseX - tx.timeToX(cursors.x1Us)) <= threshold) {
          detected = { ch, marker: 'X1' };
        } else if (cursors.x2Us !== null && Math.abs(mouseX - tx.timeToX(cursors.x2Us)) <= threshold) {
          detected = { ch, marker: 'X2' };
        }
      }

      if (!detected && (cfg.cursorMode === 'VOLT' || cfg.cursorMode === 'BOTH')) {
        const yFn = ch === 'CH1' ? tx.voltToY : ch === 'CH2' ? tx.gyroToY : tx.mathToY;
        const y1Pos = yFn(cursors.y1);
        const y2Pos = yFn(cursors.y2);
        if (Math.abs(mouseY - y1Pos) <= threshold) {
          detected = { ch, marker: 'Y1' };
        } else if (Math.abs(mouseY - y2Pos) <= threshold) {
          detected = { ch, marker: 'Y2' };
        }
      }
    }

    if (!markersEqual(hoveredMarkerRef.current, detected)) {
      hoveredMarkerRef.current = detected;
      setHoveredMarker(detected);
      dirtyRef.current = true;
    }
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const tx = txRef.current ?? computeTransforms(false);
    if (!tx) return;

    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    // Workflow B (spec 3.4): scope click snaps cursor AND scrubs stream/hex/DVR
    const clickedTimeUs = tx.xToTime(clickX);

    if (viewCfgRef.current.cursorMode !== 'OFF') {
      const ch = viewCfgRef.current.cursorTargetChannel;
      const current = { ...channelCursorsRef.current[ch] };
      if (activeMarker === 'X1') {
        current.x1Us = clickedTimeUs;
      } else if (activeMarker === 'X2') {
        current.x2Us = clickedTimeUs;
      } else if (activeMarker === 'Y1') {
        if (ch === 'CH1') current.y1 = tx.yToVolt(clickY);
        else if (ch === 'CH2') current.y1 = tx.yToGyro(clickY);
        else current.y1 = tx.yToMath(clickY);
      } else if (activeMarker === 'Y2') {
        if (ch === 'CH1') current.y2 = tx.yToVolt(clickY);
        else if (ch === 'CH2') current.y2 = tx.yToGyro(clickY);
        else current.y2 = tx.yToMath(clickY);
      }
      const nextMap = { ...channelCursorsRef.current, [ch]: current };
      channelCursorsRef.current = nextMap;
      setChannelCursors(nextMap);
      dirtyRef.current = true;
    }

    seekToTimestamp(clickedTimeUs);
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (draggedMarkerRef.current) {
      draggedMarkerRef.current = null;
      setDraggedMarker(null);
      syncDragRefsToState(true);
      dirtyRef.current = true;
      return;
    }

    if (isPanningRef.current) {
      const moved = panHasMovedRef.current;
      const deltaX = Math.abs(e.clientX - panStartRef.current.x);
      isPanningRef.current = false;
      panHasMovedRef.current = false;
      if (!moved && deltaX < 4) {
        panOffsetUsRef.current = panStartRef.current.initialPan;
        handleCanvasClick(e);
      } else {
        setPanOffsetUs(panOffsetUsRef.current);
        dirtyRef.current = true;
      }
    }
  };

  const handleMouseLeave = () => {
    if (draggedMarkerRef.current) {
      draggedMarkerRef.current = null;
      setDraggedMarker(null);
      syncDragRefsToState(true);
    }
    if (isPanningRef.current) {
      isPanningRef.current = false;
      panHasMovedRef.current = false;
      setPanOffsetUs(panOffsetUsRef.current);
    }
    if (hoveredMarkerRef.current !== null) {
      hoveredMarkerRef.current = null;
      setHoveredMarker(null);
      dirtyRef.current = true;
    }
  };

  // Cursor Quick Actions (sync both ref and React state)
  const handleCenterCursors = () => {
    const tx = txRef.current ?? computeTransforms(false);
    if (!tx) return;
    const ch = cursorTargetChannel;
    const tSpan = tx.tMax - tx.tMin;
    const updated = { ...channelCursorsRef.current[ch] };
    updated.x1Us = Math.round(tx.tMin + tSpan * 0.3);
    updated.x2Us = Math.round(tx.tMin + tSpan * 0.7);

    if (ch === 'CH1') {
      const span = tx.ch1Max - tx.ch1Min;
      updated.y1 = +(tx.ch1Min + span * 0.3).toFixed(span >= 60 ? 0 : 3);
      updated.y2 = +(tx.ch1Min + span * 0.7).toFixed(span >= 60 ? 0 : 3);
    } else if (ch === 'CH2') {
      const span = tx.ch2Max - tx.ch2Min;
      updated.y1 = +(tx.ch2Min + span * 0.3).toFixed(span >= 60 ? 0 : 3);
      updated.y2 = +(tx.ch2Min + span * 0.7).toFixed(span >= 60 ? 0 : 3);
    } else {
      const span = tx.mathMax - tx.mathMin;
      updated.y1 = +(tx.mathMin + span * 0.3).toFixed(3);
      updated.y2 = +(tx.mathMin + span * 0.7).toFixed(3);
    }

    const nextMap = { ...channelCursorsRef.current, [ch]: updated };
    channelCursorsRef.current = nextMap;
    setChannelCursors(nextMap);
    dirtyRef.current = true;
  };

  const handleSnapToPeaks = () => {
    const ch = cursorTargetChannel;
    const m = metricsRef.current;
    const updated = { ...channelCursorsRef.current[ch] };
    if (ch === 'CH1' && m.count1 > 0) {
      updated.y1 = m.min1;
      updated.y2 = m.max1;
    } else if (ch === 'CH2' && m.count2 > 0) {
      updated.y1 = m.min2;
      updated.y2 = m.max2;
    }
    const nextMap = { ...channelCursorsRef.current, [ch]: updated };
    channelCursorsRef.current = nextMap;
    setChannelCursors(nextMap);
    dirtyRef.current = true;
  };

  const handleClearCursors = () => {
    const ch = cursorTargetChannel;
    const zeroVal = ch === 'CH1' ? ch1Center : ch === 'CH2' ? ch2Center : 0;
    const nextMap = {
      ...channelCursorsRef.current,
      [ch]: { x1Us: null, x2Us: null, y1: zeroVal, y2: zeroVal },
    };
    channelCursorsRef.current = nextMap;
    setChannelCursors(nextMap);
    dirtyRef.current = true;
  };

  // Draggable HUD Pointer Handlers
  const handleHudMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDraggingHud(true);
    hudDragStart.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startX: hudPos.x,
      startY: hudPos.y,
    };
  };

  useEffect(() => {
    if (!isDraggingHud) return;

    const onWinMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - hudDragStart.current.mouseX;
      const dy = e.clientY - hudDragStart.current.mouseY;
      const container = containerRef.current;
      const maxW = container ? container.clientWidth - 260 : 600;
      const maxH = container ? container.clientHeight - 80 : 400;

      const newX = Math.max(8, Math.min(maxW, hudDragStart.current.startX + dx));
      const newY = Math.max(8, Math.min(maxH, hudDragStart.current.startY + dy));
      setHudPos({ x: newX, y: newY });
    };

    const onWinMouseUp = () => {
      setIsDraggingHud(false);
      try {
        localStorage.setItem('bforge_scope_hud_pos', JSON.stringify(hudPos));
      } catch (_) {}
    };

    window.addEventListener('mousemove', onWinMouseMove);
    window.addEventListener('mouseup', onWinMouseUp);
    return () => {
      window.removeEventListener('mousemove', onWinMouseMove);
      window.removeEventListener('mouseup', onWinMouseUp);
    };
  }, [isDraggingHud, hudPos]);

  // Channel unit labels for controls & HUD
  const ch1RingMeta = plotEngine.catalogEntry(ch1Field);
  const ch2RingMeta = plotEngine.catalogEntry(ch2Field);
  const ch1Gain = getFieldScaleGain(ch1Field, ch1RingMeta?.unit, plotEngine.getChannelRing('__scope_ch1'));
  const ch2Gain = getFieldScaleGain(ch2Field, ch2RingMeta?.unit, plotEngine.getChannelRing('__scope_ch2'));
  const ch1Unit = getDisplayUnit(ch1Field, ch1RingMeta?.unit, ch1Gain);
  const ch2Unit = getDisplayUnit(ch2Field, ch2RingMeta?.unit, ch2Gain);

  const ch1Options = useMemo(() => {
    const names = new Set<string>(['v_batt_mv']);
    for (const c of catalogFields) names.add(c.name);
    names.add(ch1Field);
    return [...names];
  }, [catalogFields, ch1Field]);

  const ch2Options = useMemo(() => {
    const names = new Set<string>(['gyro_z']);
    for (const c of catalogFields) names.add(c.name);
    names.add(ch2Field);
    return [...names];
  }, [catalogFields, ch2Field]);

  // Delta calculations for currently selected cursor channel
  const activeCursors = channelCursors[cursorTargetChannel];
  const deltaTUs =
    activeCursors.x1Us !== null && activeCursors.x2Us !== null
      ? Math.abs(activeCursors.x2Us - activeCursors.x1Us)
      : null;
  const freqHz = deltaTUs && deltaTUs > 0 ? (1000000 / deltaTUs).toFixed(1) : null;

  const deltaY = useMemo(() => {
    const d = Math.abs(activeCursors.y2 - activeCursors.y1);
    if (cursorTargetChannel === 'CH1') {
      if (isBattMvMode(ch1Field, ch1Unit)) return `${Math.round(d)} mV (${(d / 1000).toFixed(2)} V)`;
      return formatStatVal(d, ch1Field, ch1Unit);
    }
    if (cursorTargetChannel === 'CH2') return formatStatVal(d, ch2Field, ch2Unit);
    return `${+d.toFixed(3)}`;
  }, [cursorTargetChannel, activeCursors, ch1Field, ch1Unit, ch2Field, ch2Unit]);

  const slewRate = useMemo(() => {
    if (!deltaTUs || deltaTUs === 0) return null;
    const dtSec = deltaTUs / 1000000;
    const dY = Math.abs(activeCursors.y2 - activeCursors.y1);
    if (cursorTargetChannel === 'CH1') {
      if (isBattMvMode(ch1Field, ch1Unit)) return `${(dY / 1000 / dtSec).toFixed(1)} V/s`;
      return `${(dY / dtSec).toFixed(1)} ${ch1Unit ? `${ch1Unit}/s` : '/s'}`;
    }
    if (cursorTargetChannel === 'CH2') {
      if (ch2Unit === 'rad/s') return `${(dY / dtSec).toFixed(1)} rad/s²`;
      return `${(dY / dtSec).toFixed(1)} ${ch2Unit ? `${ch2Unit}/s` : '/s'}`;
    }
    return null;
  }, [deltaTUs, cursorTargetChannel, activeCursors, ch1Field, ch1Unit, ch2Unit]);

  const trigDispVal = triggerSource === 'CH1' ? triggerLevelCh1Mv : triggerLevelCh2Rad;
  const trigFieldName = triggerSource === 'CH1' ? ch1Field : ch2Field;
  const trigUnitName = triggerSource === 'CH1' ? ch1Unit : ch2Unit;
  const trigStepSize = (triggerSource === 'CH1' ? ch1ScaleMv : ch2ScaleRad) * 0.25;

  const stepTriggerLevel = (dir: 'up' | 'down') => {
    const delta = dir === 'up' ? trigStepSize : -trigStepSize;
    if (triggerSource === 'CH1') {
      const next = Math.abs(trigStepSize) >= 10 ? Math.round(triggerLevelCh1Ref.current + delta) : +(triggerLevelCh1Ref.current + delta).toFixed(3);
      triggerLevelCh1Ref.current = next;
      setTriggerLevelCh1Mv(next);
    } else {
      const next = +(triggerLevelCh2Ref.current + delta).toFixed(3);
      triggerLevelCh2Ref.current = next;
      setTriggerLevelCh2Rad(next);
    }
    normHeldWindowRef.current = null;
    lastNormScanTUsRef.current = 0;
    dirtyRef.current = true;
  };

  return (
    <div ref={containerRef} className="flex flex-col h-full bg-bf-deep select-none text-[11px] font-mono">
      {/* 2-ROW DSO CONTROLS RIBBON */}
      <div className="flex flex-col bg-bf-subpanel border-b border-bf-line shrink-0">
        {/* ROW 1: Acquisition Engine & Per-Channel Stems */}
        <div className="h-[30px] border-b border-bf-line/60 px-2 flex items-center justify-between gap-2 overflow-x-auto">
          {/* Left: RUN/STOP, SINGLE, AUTOSET, Timebase */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={handleToggleRunStop}
              data-tooltip={isRunning ? 'Freeze scope acquisition (Stop)' : 'Resume real-time telemetry streaming (Run)'}
              data-tooltip-shortcut="Space"
              className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded text-[11px] font-bold transition-all shadow-sm ${
                isRunning
                  ? 'bg-bf-ok/20 border border-bf-ok text-bf-ok hover:bg-bf-ok/30'
                  : 'bg-bf-fault text-white animate-pulse shadow-[0_0_8px_rgb(var(--bf-fault-rgb)/0.6)]'
              }`}
            >
              {isRunning ? <Play className="w-2.5 h-2.5 fill-current" /> : <Pause className="w-2.5 h-2.5 fill-current" />}
              <span>{isRunning ? 'RUNNING' : 'STOPPED'}</span>
            </button>

            <button
              onClick={handleSingleShot}
              data-tooltip="Arm Single Capture: Wait for trigger crossing and freeze acquisition"
              className={`px-2 py-0.5 rounded text-[11px] font-bold border transition-colors ${
                singleArmed
                  ? 'bg-bf-warn text-bf-onfill border-bf-warn animate-pulse'
                  : 'bg-bf-panel text-bf-mute border-bf-line hover:text-white'
              }`}
            >
              SINGLE
            </button>

            <button
              onClick={handleAutoset}
              data-tooltip="Auto-fit CH1 and CH2 vertical scales, center offsets, and trigger thresholds to visible waveforms"
              className="px-2 py-0.5 rounded text-[11px] font-bold border border-bf-cyan/40 bg-bf-panel text-bf-cyan hover:bg-bf-cyan/15 transition-colors"
            >
              AUTOSET
            </button>

            {/* Horizontal Timebase Stepper / Direct Input */}
            <div className="flex items-center gap-0.5 bg-bf-panel border border-bf-line rounded px-1 py-0.5 text-[11px]">
              <span className="text-bf-faint pl-0.5 font-bold">TIME:</span>
              <button
                onClick={() => stepTimeDiv('down')}
                data-tooltip="Step timebase faster (fewer ms/div)"
                className="px-1 text-bf-mute hover:text-bf-cyan hover:bg-bf-hover rounded"
              >
                <Minus className="w-2.5 h-2.5" />
              </button>

              {isEditingTime ? (
                <input
                  type="number"
                  min="1"
                  max="10000"
                  autoFocus
                  value={timeInputVal}
                  onChange={(e) => setTimeInputVal(e.target.value)}
                  onBlur={() => {
                    const parsed = parseInt(timeInputVal, 10);
                    if (!isNaN(parsed) && parsed > 0) setTimeDivMs(parsed);
                    setIsEditingTime(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const parsed = parseInt(timeInputVal, 10);
                      if (!isNaN(parsed) && parsed > 0) setTimeDivMs(parsed);
                      setIsEditingTime(false);
                    } else if (e.key === 'Escape') {
                      setIsEditingTime(false);
                    }
                  }}
                  className="w-12 bg-bf-onfill text-bf-cyan text-center text-[12px] font-bold px-0.5 rounded outline-none border border-bf-cyan"
                />
              ) : (
                <span
                  onClick={() => {
                    setTimeInputVal(timeDivMs.toString());
                    setIsEditingTime(true);
                  }}
                  data-tooltip="Click to type custom Time/Div value (ms)"
                  className="text-bf-cyan font-bold px-1 cursor-text hover:underline"
                >
                  {timeDivMs} ms/div
                </span>
              )}

              <button
                onClick={() => stepTimeDiv('up')}
                data-tooltip="Step timebase slower (more ms/div)"
                className="px-1 text-bf-mute hover:text-bf-cyan hover:bg-bf-hover rounded"
              >
                <Plus className="w-2.5 h-2.5" />
              </button>
              <span className="text-bf-faint text-[10px] pr-0.5">({timeDivMs * 10}ms)</span>
            </div>
          </div>

          {/* Right: Per-Channel Stems (CH1, CH2, MATH, Bound Traces, LOGIC) */}
          <div className="flex items-center gap-1.5 shrink-0">
            {/* CH1 Stem */}
            <div className="flex items-center gap-1 bg-bf-panel border border-bf-line rounded px-1.5 py-0.5 text-[11px]">
              <button
                onClick={() => toggleChannel('ch1')}
                data-tooltip={`Toggle Channel 1 (${ch1Field})`}
                className={`flex items-center gap-1 px-1 py-0.2 rounded font-bold transition-colors ${
                  ch1Visible
                    ? 'bg-bf-amber/20 border border-bf-amber/60 text-bf-amber'
                    : 'text-bf-faint hover:text-bf-mute'
                }`}
              >
                {ch1Visible ? <Eye className="w-2.5 h-2.5" /> : <EyeOff className="w-2.5 h-2.5" />}
                <span>CH1</span>
              </button>

              <select
                value={ch1Field}
                onChange={(e) => handleSelectChannelField('CH1', e.target.value)}
                data-tooltip="Bind Channel 1 to any decoded telemetry field"
                className="bg-bf-deep text-bf-amber border border-bf-line rounded px-1 py-0 text-[11px] font-bold max-w-[108px] outline-none"
              >
                {ch1Options.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>

              <button
                onClick={() => stepCh1Scale('down')}
                data-tooltip="Decrease CH1 vertical scale"
                className="px-0.5 text-bf-mute hover:text-bf-amber"
              >
                <Minus className="w-2 h-2" />
              </button>
              <button
                onClick={() => {
                  if (isBattMvMode(ch1Field, ch1Unit)) {
                    const idx = CH1_SCALE_PRESETS.indexOf(ch1ScaleMv);
                    setCh1ScaleMv(CH1_SCALE_PRESETS[(idx + 1) % CH1_SCALE_PRESETS.length]);
                  } else {
                    setCh1ScaleMv((prev) => (prev >= 1000 ? 0.1 : stepNice125(prev, 'up', 0.01, 10000)));
                  }
                }}
                data-tooltip="CH1 Scale: Click to cycle 1-2-5 presets"
                className="text-bf-amber font-bold hover:underline px-0.5"
              >
                {formatScaleLabel(ch1ScaleMv, ch1Field, ch1Unit)}
              </button>
              <button
                onClick={() => stepCh1Scale('up')}
                data-tooltip="Increase CH1 vertical scale"
                className="px-0.5 text-bf-mute hover:text-bf-amber"
              >
                <Plus className="w-2 h-2" />
              </button>

              {/* CH1 Vertical Center / Offset */}
              <div className="flex items-center border-l border-bf-line pl-1 ml-0.5 text-[10px]">
                <span className="text-bf-faint pr-0.5">Y₀:</span>
                <button
                  onClick={() => setCh1Center((prev) => +(prev - ch1ScaleMv * 0.25).toFixed(3))}
                  data-tooltip="Shift CH1 vertical center down"
                  className="px-0.5 text-bf-faint hover:text-white"
                >
                  -
                </button>
                {editingCenterCh === 'CH1' ? (
                  <input
                    type="number"
                    step="any"
                    autoFocus
                    value={centerInputVal}
                    onChange={(e) => setCenterInputVal(e.target.value)}
                    onBlur={() => {
                      const parsed = parseFloat(centerInputVal);
                      if (Number.isFinite(parsed)) setCh1Center(parsed);
                      setEditingCenterCh(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const parsed = parseFloat(centerInputVal);
                        if (Number.isFinite(parsed)) setCh1Center(parsed);
                        setEditingCenterCh(null);
                      } else if (e.key === 'Escape') {
                        setEditingCenterCh(null);
                      }
                    }}
                    className="w-14 bg-bf-onfill text-bf-amber text-center text-[12px] font-bold px-0.5 rounded outline-none border border-bf-amber"
                  />
                ) : (
                  <span
                    onClick={() => {
                      setCenterInputVal(ch1Center.toString());
                      setEditingCenterCh('CH1');
                    }}
                    data-tooltip="CH1 vertical center (Click to type value)"
                    className="cursor-text px-0.5 font-bold text-bf-amber hover:underline"
                  >
                    {formatCompact(ch1Center, 2)}
                  </span>
                )}
                <button
                  onClick={() => setCh1Center((prev) => +(prev + ch1ScaleMv * 0.25).toFixed(3))}
                  data-tooltip="Shift CH1 vertical center up"
                  className="px-0.5 text-bf-faint hover:text-white"
                >
                  +
                </button>
              </div>

              {/* CH1 Horizontal Skew / Offset */}
              <div className="flex items-center border-l border-bf-line pl-1 ml-0.5 text-[10px]">
                <span className="text-bf-faint pr-0.5">Δt:</span>
                <button
                  onClick={() => setCh1TimeOffsetMs((prev) => prev - 5)}
                  data-tooltip="Shift CH1 waveform 5 ms earlier (negative delay)"
                  className="px-0.5 text-bf-faint hover:text-white"
                >
                  -
                </button>
                <span
                  onClick={() => setCh1TimeOffsetMs(0)}
                  data-tooltip="CH1 Horizontal Offset (Click to reset to 0ms)"
                  className={`cursor-pointer px-0.5 font-bold ${
                    ch1TimeOffsetMs !== 0 ? 'text-bf-amber' : 'text-bf-faint'
                  }`}
                >
                  {ch1TimeOffsetMs}ms
                </span>
                <button
                  onClick={() => setCh1TimeOffsetMs((prev) => prev + 5)}
                  data-tooltip="Shift CH1 waveform 5 ms later (positive delay)"
                  className="px-0.5 text-bf-faint hover:text-white"
                >
                  +
                </button>
              </div>
            </div>

            {/* CH2 Stem */}
            <div className="flex items-center gap-1 bg-bf-panel border border-bf-line rounded px-1.5 py-0.5 text-[11px]">
              <button
                onClick={() => toggleChannel('ch2')}
                data-tooltip={`Toggle Channel 2 (${ch2Field})`}
                className={`flex items-center gap-1 px-1 py-0.2 rounded font-bold transition-colors ${
                  ch2Visible
                    ? 'bg-bf-cyan/20 border border-bf-cyan/60 text-bf-cyan'
                    : 'text-bf-faint hover:text-bf-mute'
                }`}
              >
                {ch2Visible ? <Eye className="w-2.5 h-2.5" /> : <EyeOff className="w-2.5 h-2.5" />}
                <span>CH2</span>
              </button>

              <select
                value={ch2Field}
                onChange={(e) => handleSelectChannelField('CH2', e.target.value)}
                data-tooltip="Bind Channel 2 to any decoded telemetry field"
                className="bg-bf-deep text-bf-cyan border border-bf-line rounded px-1 py-0 text-[11px] font-bold max-w-[108px] outline-none"
              >
                {ch2Options.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>

              <button
                onClick={() => stepCh2Scale('down')}
                data-tooltip="Decrease CH2 vertical scale"
                className="px-0.5 text-bf-mute hover:text-bf-cyan"
              >
                <Minus className="w-2 h-2" />
              </button>
              <button
                onClick={() => {
                  if (ch2Unit === 'rad/s') {
                    const idx = CH2_SCALE_PRESETS.indexOf(ch2ScaleRad);
                    setCh2ScaleRad(CH2_SCALE_PRESETS[(idx + 1) % CH2_SCALE_PRESETS.length]);
                  } else {
                    setCh2ScaleRad((prev) => (prev >= 1000 ? 0.1 : stepNice125(prev, 'up', 0.005, 10000)));
                  }
                }}
                data-tooltip="CH2 Scale: Click to cycle presets"
                className="text-bf-cyan font-bold hover:underline px-0.5"
              >
                {formatScaleLabel(ch2ScaleRad, ch2Field, ch2Unit)}
              </button>
              <button
                onClick={() => stepCh2Scale('up')}
                data-tooltip="Increase CH2 vertical scale"
                className="px-0.5 text-bf-mute hover:text-bf-cyan"
              >
                <Plus className="w-2 h-2" />
              </button>

              {/* CH2 Vertical Center / Offset */}
              <div className="flex items-center border-l border-bf-line pl-1 ml-0.5 text-[10px]">
                <span className="text-bf-faint pr-0.5">Y₀:</span>
                <button
                  onClick={() => setCh2Center((prev) => +(prev - ch2ScaleRad * 0.25).toFixed(3))}
                  data-tooltip="Shift CH2 vertical center down"
                  className="px-0.5 text-bf-faint hover:text-white"
                >
                  -
                </button>
                {editingCenterCh === 'CH2' ? (
                  <input
                    type="number"
                    step="any"
                    autoFocus
                    value={centerInputVal}
                    onChange={(e) => setCenterInputVal(e.target.value)}
                    onBlur={() => {
                      const parsed = parseFloat(centerInputVal);
                      if (Number.isFinite(parsed)) setCh2Center(parsed);
                      setEditingCenterCh(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const parsed = parseFloat(centerInputVal);
                        if (Number.isFinite(parsed)) setCh2Center(parsed);
                        setEditingCenterCh(null);
                      } else if (e.key === 'Escape') {
                        setEditingCenterCh(null);
                      }
                    }}
                    className="w-14 bg-bf-onfill text-bf-cyan text-center text-[12px] font-bold px-0.5 rounded outline-none border border-bf-cyan"
                  />
                ) : (
                  <span
                    onClick={() => {
                      setCenterInputVal(ch2Center.toString());
                      setEditingCenterCh('CH2');
                    }}
                    data-tooltip="CH2 vertical center (Click to type value)"
                    className="cursor-text px-0.5 font-bold text-bf-cyan hover:underline"
                  >
                    {formatCompact(ch2Center, 2)}
                  </span>
                )}
                <button
                  onClick={() => setCh2Center((prev) => +(prev + ch2ScaleRad * 0.25).toFixed(3))}
                  data-tooltip="Shift CH2 vertical center up"
                  className="px-0.5 text-bf-faint hover:text-white"
                >
                  +
                </button>
              </div>

              {/* CH2 Horizontal Skew / Offset */}
              <div className="flex items-center border-l border-bf-line pl-1 ml-0.5 text-[10px]">
                <span className="text-bf-faint pr-0.5">Δt:</span>
                <button
                  onClick={() => setCh2TimeOffsetMs((prev) => prev - 5)}
                  data-tooltip="Shift CH2 waveform 5 ms earlier (negative delay)"
                  className="px-0.5 text-bf-faint hover:text-white"
                >
                  -
                </button>
                <span
                  onClick={() => setCh2TimeOffsetMs(0)}
                  data-tooltip="CH2 Horizontal Offset (Click to reset to 0ms)"
                  className={`cursor-pointer px-0.5 font-bold ${
                    ch2TimeOffsetMs !== 0 ? 'text-bf-cyan' : 'text-bf-faint'
                  }`}
                >
                  {ch2TimeOffsetMs}ms
                </span>
                <button
                  onClick={() => setCh2TimeOffsetMs((prev) => prev + 5)}
                  data-tooltip="Shift CH2 waveform 5 ms later (positive delay)"
                  className="px-0.5 text-bf-faint hover:text-white"
                >
                  +
                </button>
              </div>
            </div>

            {/* MATH Stem */}
            <div className="flex items-center gap-1 bg-bf-panel border border-bf-line rounded px-1.5 py-0.5 text-[11px]">
              <button
                onClick={() => setMathVisible(!mathVisible)}
                data-tooltip="Toggle Oscilloscope Math Channel (Differential, FFT, Inverted)"
                className={`flex items-center gap-1 px-1 py-0.2 rounded font-bold transition-colors ${
                  mathVisible
                    ? 'bg-bf-math/20 border border-bf-math text-bf-math'
                    : 'text-bf-faint hover:text-bf-math'
                }`}
              >
                <Activity className="w-2.5 h-2.5" />
                <span>MATH</span>
              </button>

              {mathVisible && (
                <>
                  <button
                    onClick={() => {
                      const idx = (MATH_OPERATIONS.indexOf(mathOp) + 1) % MATH_OPERATIONS.length;
                      setMathOp(MATH_OPERATIONS[idx]);
                    }}
                    data-tooltip="Cycle Math Operator: CH1-CH2, CH1+CH2, CH1*CH2, FFT, INV CH1"
                    className="px-1 text-bf-math font-bold hover:underline"
                  >
                    {mathOp}
                  </button>
                  <button
                    onClick={() => setMathScale((prev) => (prev === 0.5 ? 1.0 : prev === 1.0 ? 2.0 : 0.5))}
                    data-tooltip="Cycle Math Amplitude Scale Multiplier"
                    className="px-1 text-bf-mute text-[11px] hover:text-white border-l border-bf-line"
                  >
                    {mathScale}x
                  </button>

                  <div className="flex items-center border-l border-bf-line pl-1 ml-0.5 text-[10px]">
                    <span className="text-bf-faint pr-0.5">Δt:</span>
                    <button
                      onClick={() => setMathTimeOffsetMs((prev) => prev - 5)}
                      data-tooltip="Shift Math waveform 5 ms earlier"
                      className="px-0.5 text-bf-faint hover:text-white"
                    >
                      -
                    </button>
                    <span
                      onClick={() => setMathTimeOffsetMs(0)}
                      data-tooltip="Math Horizontal Offset (Click to reset to 0ms)"
                      className={`cursor-pointer px-0.5 font-bold ${
                        mathTimeOffsetMs !== 0 ? 'text-bf-math' : 'text-bf-faint'
                      }`}
                    >
                      {mathTimeOffsetMs}ms
                    </span>
                    <button
                      onClick={() => setMathTimeOffsetMs((prev) => prev + 5)}
                      data-tooltip="Shift Math waveform 5 ms later"
                      className="px-0.5 text-bf-faint hover:text-white"
                    >
                      +
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* Bound Field Trace Stems (spec 5.4) */}
            {traceBindings.map((binding, index) => {
              const hidden = !!traceHidden[binding.id];
              const color = TRACE_COLORS[index % TRACE_COLORS.length];
              return (
                <div key={binding.id} className="flex items-center gap-1 border-l border-bf-line pl-1 ml-0.5">
                  <button
                    onClick={() => toggleTraceVisibility(binding.id)}
                    data-tooltip={`Toggle trace lane for bound field ${binding.name}`}
                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] transition-colors border ${
                      hidden
                        ? 'bg-bf-panel border-bf-line text-bf-faint hover:text-bf-mute'
                        : 'bg-bf-panel text-bf-body'
                    }`}
                    style={hidden ? undefined : { borderColor: `${color}80` }}
                  >
                    {hidden ? <EyeOff className="w-2.5 h-2.5" /> : <Eye className="w-2.5 h-2.5" />}
                    <span style={{ color: hidden ? undefined : color }}>{binding.name}</span>
                  </button>
                  <button
                    onClick={() => unbindScopeTrace(binding.id)}
                    data-tooltip={`Unbind ${binding.name} and remove its trace lane`}
                    className="text-bf-faint hover:text-bf-fault text-[11px] px-0.5"
                  >
                    ×
                  </button>
                </div>
              );
            })}

            {/* LOGIC Stem */}
            <button
              onClick={() => toggleChannel('logic')}
              data-tooltip="Toggle Digital Logic State Rails (D0-D2: RUN, ARMED, FAULT)"
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] transition-colors border ${
                logicRailsVisible
                  ? 'bg-bf-ok/20 border-bf-ok/60 text-bf-ok'
                  : 'bg-bf-panel border-bf-line text-bf-faint hover:text-bf-mute'
              }`}
            >
              {logicRailsVisible ? <Eye className="w-2.5 h-2.5" /> : <EyeOff className="w-2.5 h-2.5" />}
              <span>LOGIC</span>
            </button>
          </div>
        </div>

        {/* ROW 2: Trigger Engine, Independent Channel Cursors, Layout/GPU, Zoom & HUD */}
        <div className="h-[30px] px-2 flex items-center justify-between gap-2 overflow-x-auto text-[11px]">
          {/* Left: Trigger Engine */}
          <div className="flex items-center gap-1.5 shrink-0">
            <div className="flex items-center gap-1 bg-bf-panel border border-bf-line rounded px-1.5 py-0.5">
              <span className="text-bf-faint font-bold">TRIG:</span>

              <button
                onClick={handleCycleTriggerMode}
                data-tooltip="Trigger Mode: AUTO (continuous), NORM (hold on crossing), SINGLE (arm & freeze), ROLL (tail)"
                className="text-bf-body font-bold hover:text-bf-cyan px-0.5"
              >
                {triggerMode}
              </button>

              <button
                onClick={() => {
                  normHeldWindowRef.current = null;
                  setTriggerSource((prev) => (prev === 'CH1' ? 'CH2' : 'CH1'));
                }}
                data-tooltip="Trigger Channel Source: Click to switch between CH1 and CH2"
                className={`font-bold px-1 rounded transition-colors ${
                  triggerSource === 'CH1' ? 'text-bf-amber bg-bf-amber/10' : 'text-bf-cyan bg-bf-cyan/10'
                }`}
              >
                {triggerSource}
              </button>

              <div className="flex items-center gap-0.5 border-l border-bf-line pl-1">
                <button
                  onClick={() => stepTriggerLevel('down')}
                  data-tooltip="Decrease trigger threshold"
                  className="px-0.5 text-bf-faint hover:text-white"
                >
                  -
                </button>
                {isEditingTrigLevel ? (
                  <input
                    type="number"
                    step="any"
                    autoFocus
                    value={trigInputVal}
                    onChange={(e) => setTrigInputVal(e.target.value)}
                    onBlur={() => {
                      const parsed = parseFloat(trigInputVal);
                      if (Number.isFinite(parsed)) {
                        if (triggerSource === 'CH1') {
                          triggerLevelCh1Ref.current = parsed;
                          setTriggerLevelCh1Mv(parsed);
                        } else {
                          triggerLevelCh2Ref.current = parsed;
                          setTriggerLevelCh2Rad(parsed);
                        }
                        normHeldWindowRef.current = null;
                        lastNormScanTUsRef.current = 0;
                        dirtyRef.current = true;
                      }
                      setIsEditingTrigLevel(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const parsed = parseFloat(trigInputVal);
                        if (Number.isFinite(parsed)) {
                          if (triggerSource === 'CH1') {
                            triggerLevelCh1Ref.current = parsed;
                            setTriggerLevelCh1Mv(parsed);
                          } else {
                            triggerLevelCh2Ref.current = parsed;
                            setTriggerLevelCh2Rad(parsed);
                          }
                          normHeldWindowRef.current = null;
                          lastNormScanTUsRef.current = 0;
                          dirtyRef.current = true;
                        }
                        setIsEditingTrigLevel(false);
                      } else if (e.key === 'Escape') {
                        setIsEditingTrigLevel(false);
                      }
                    }}
                    className="w-14 bg-bf-onfill text-bf-amber text-center text-[12px] font-bold px-0.5 rounded outline-none border border-bf-amber"
                  />
                ) : (
                  <span
                    onClick={() => {
                      setTrigInputVal(trigDispVal.toString());
                      setIsEditingTrigLevel(true);
                    }}
                    data-tooltip="Trigger Threshold: Click to type value, step with +/-, or drag arrow on right canvas border"
                    className="text-bf-mute hover:text-white px-0.5 cursor-text font-bold"
                  >
                    {formatChannelVal(trigDispVal, trigFieldName, trigUnitName)}
                  </span>
                )}
                <button
                  onClick={() => stepTriggerLevel('up')}
                  data-tooltip="Increase trigger threshold"
                  className="px-0.5 text-bf-faint hover:text-white"
                >
                  +
                </button>
              </div>

              <button
                onClick={() => {
                  normHeldWindowRef.current = null;
                  lastNormScanTUsRef.current = 0;
                  setTriggerSlope((prev) => TRIGGER_SLOPES[(TRIGGER_SLOPES.indexOf(prev) + 1) % TRIGGER_SLOPES.length]);
                }}
                data-tooltip={`Trigger Slope: ${triggerSlope} Edge`}
                className="text-bf-amber hover:text-white ml-0.5"
              >
                {triggerSlope === 'RISING' ? (
                  <ArrowUpRight className="w-3 h-3" />
                ) : triggerSlope === 'FALLING' ? (
                  <ArrowDownRight className="w-3 h-3" />
                ) : (
                  <ArrowUpDown className="w-3 h-3" />
                )}
              </button>
            </div>
          </div>

          {/* Center: Independent Marker Cursors Per Channel */}
          <div className="flex items-center gap-1.5 shrink-0">
            <div className="flex items-center gap-1 bg-bf-panel border border-bf-line rounded px-1.5 py-0.5">
              <Crosshair className="w-3 h-3 text-bf-cyan" />
              <span className="text-bf-faint font-bold">CURSORS FOR:</span>
              {(['CH1', 'CH2', 'MATH'] as const).map((ch) => (
                <button
                  key={ch}
                  onClick={() => setCursorTargetChannel(ch)}
                  data-tooltip={`Switch active cursors to ${ch}`}
                  className={`px-1.5 py-0.2 rounded font-bold transition-colors ${
                    cursorTargetChannel === ch
                      ? ch === 'CH1'
                        ? 'bg-bf-amber text-bf-onfill'
                        : ch === 'CH2'
                        ? 'bg-bf-cyan text-bf-onfill'
                        : 'bg-bf-math text-bf-onfill'
                      : 'text-bf-faint hover:text-white'
                  }`}
                >
                  {ch}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-0.5 bg-bf-panel border border-bf-line rounded px-1 py-0.5">
              {(['OFF', 'TIME', 'VOLT', 'BOTH'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setCursorMode(mode)}
                  data-tooltip={`Cursor Mode: ${
                    mode === 'TIME' ? 'Time (X1, X2)' : mode === 'VOLT' ? 'Signal (Y1, Y2)' : mode === 'BOTH' ? 'Dual (X + Y)' : 'Disabled'
                  }`}
                  className={`px-1 py-0.2 rounded font-bold transition-colors ${
                    cursorMode === mode ? 'bg-bf-cyan text-bf-onfill' : 'text-bf-faint hover:text-bf-body'
                  }`}
                >
                  {mode === 'TIME' ? 'X' : mode === 'VOLT' ? 'Y' : mode === 'BOTH' ? 'X+Y' : 'OFF'}
                </button>
              ))}
            </div>

            {cursorMode !== 'OFF' && (
              <div className="flex items-center gap-0.5 bg-bf-panel border border-bf-line rounded px-1 py-0.5">
                <span className="text-bf-faint px-0.5">SET:</span>
                {(cursorMode === 'TIME' || cursorMode === 'BOTH') && (
                  <>
                    <button
                      onClick={() => setActiveMarker('X1')}
                      data-tooltip={`Active: ${cursorTargetChannel}:X1 (Click canvas to place)`}
                      className={`px-1 py-0.2 rounded font-bold ${
                        activeMarker === 'X1' ? 'bg-bf-cyan text-bf-onfill' : 'text-bf-cyan hover:bg-bf-cyan/20'
                      }`}
                    >
                      X1
                    </button>
                    <button
                      onClick={() => setActiveMarker('X2')}
                      data-tooltip={`Active: ${cursorTargetChannel}:X2 (Click canvas to place)`}
                      className={`px-1 py-0.2 rounded font-bold ${
                        activeMarker === 'X2' ? 'bg-bf-amber text-bf-onfill' : 'text-bf-amber hover:bg-bf-amber/20'
                      }`}
                    >
                      X2
                    </button>
                  </>
                )}
                {(cursorMode === 'VOLT' || cursorMode === 'BOTH') && (
                  <>
                    <button
                      onClick={() => setActiveMarker('Y1')}
                      data-tooltip={`Active: ${cursorTargetChannel}:Y1 (Click canvas to place)`}
                      className={`px-1 py-0.2 rounded font-bold ${
                        activeMarker === 'Y1' ? 'bg-bf-ok text-bf-onfill' : 'text-bf-ok hover:bg-bf-ok/20'
                      }`}
                    >
                      Y1
                    </button>
                    <button
                      onClick={() => setActiveMarker('Y2')}
                      data-tooltip={`Active: ${cursorTargetChannel}:Y2 (Click canvas to place)`}
                      className={`px-1 py-0.2 rounded font-bold ${
                        activeMarker === 'Y2' ? 'bg-bf-purple text-bf-onfill' : 'text-bf-purple hover:bg-bf-purple/20'
                      }`}
                    >
                      Y2
                    </button>
                  </>
                )}
                <button
                  onClick={handleCenterCursors}
                  data-tooltip={`Center active ${cursorTargetChannel} cursors symmetrically in view`}
                  className="px-1 py-0.2 text-bf-faint hover:text-bf-cyan ml-0.5 border-l border-bf-line"
                >
                  CTR
                </button>
                <button
                  onClick={handleSnapToPeaks}
                  data-tooltip={`Snap ${cursorTargetChannel} Y cursors to min/max waveform peaks`}
                  className="px-1 py-0.2 text-bf-faint hover:text-bf-amber"
                >
                  SNAP
                </button>
                <button
                  onClick={handleClearCursors}
                  data-tooltip={`Clear cursors for ${cursorTargetChannel}`}
                  className="px-1 py-0.2 text-bf-faint hover:text-bf-fault"
                >
                  CLR
                </button>
              </div>
            )}
          </div>

          {/* Right: Layout Mode (OVERLAY/STACKED), Renderer (GPU/2D), Zoom & HUD */}
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => setLayoutMode((prev) => (prev === 'OVERLAY' ? 'STACKED' : 'OVERLAY'))}
              data-tooltip="Toggle Layout: OVERLAY (shared graticule) vs STACKED (split horizontal lanes)"
              className={`px-1.5 py-0.5 rounded border font-bold transition-colors ${
                layoutMode === 'STACKED'
                  ? 'bg-bf-cyan/15 border-bf-cyan/40 text-bf-cyan'
                  : 'bg-bf-panel border-bf-line text-bf-mute hover:text-white'
              }`}
            >
              {layoutMode}
            </button>

            <button
              onClick={() => setGpuAccel((prev) => !prev)}
              data-tooltip="Toggle WebGL2 GPU waveform rendering vs Canvas 2D stroke"
              className={`px-1.5 py-0.5 rounded border font-bold transition-colors ${
                gpuAccel
                  ? 'bg-bf-ok/15 border-bf-ok/50 text-bf-ok'
                  : 'bg-bf-panel border-bf-line text-bf-mute hover:text-white'
              }`}
            >
              {gpuAccel ? 'GPU' : '2D'}
            </button>

            <div className="flex items-center gap-1 bg-bf-panel border border-bf-line rounded px-1.5 py-0.5">
              <ZoomIn className="w-3 h-3 text-bf-faint" />
              <button
                onClick={() => setZoomLevel((prev) => Math.max(0.2, Math.round(prev * 0.8 * 100) / 100))}
                data-tooltip="Zoom out waveform view"
                className="px-0.5 text-bf-faint hover:text-white"
              >
                -
              </button>
              <span className="text-bf-cyan font-bold px-0.5">{zoomLevel.toFixed(1)}x</span>
              <button
                onClick={() => setZoomLevel((prev) => Math.min(10.0, Math.round(prev * 1.25 * 100) / 100))}
                data-tooltip="Zoom in waveform view"
                className="px-0.5 text-bf-faint hover:text-white"
              >
                +
              </button>
              {(zoomLevel !== 1.0 || panOffsetUs !== 0) && (
                <button
                  onClick={() => {
                    setZoomLevel(1.0);
                    panOffsetUsRef.current = 0;
                    setPanOffsetUs(0);
                    dirtyRef.current = true;
                  }}
                  data-tooltip="Reset waveform zoom and pan to 1.0x"
                  className="text-bf-amber hover:text-white ml-0.5 border-l border-bf-line pl-1"
                >
                  FIT
                </button>
              )}
            </div>

            <button
              onClick={() => setIsHudVisible(!isHudVisible)}
              data-tooltip="Toggle on-screen draggable measurement HUD card"
              className={`px-1.5 py-0.5 rounded border transition-colors ${
                isHudVisible
                  ? 'bg-bf-cyan/15 border-bf-cyan/40 text-bf-cyan'
                  : 'bg-bf-panel border-bf-line text-bf-faint hover:text-white'
              }`}
            >
              HUD {isHudVisible ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
      </div>

      {/* Main Canvas Area with Movable HUD */}
      <div className="relative flex-1 w-full overflow-hidden">
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          style={{
            cursor:
              draggedMarker ||
              (hoveredMarker &&
                typeof hoveredMarker === 'object' &&
                (hoveredMarker.marker === 'X1' || hoveredMarker.marker === 'X2'))
                ? 'col-resize'
                : hoveredMarker === 'TRIG' ||
                  (hoveredMarker &&
                    typeof hoveredMarker === 'object' &&
                    (hoveredMarker.marker === 'Y1' || hoveredMarker.marker === 'Y2'))
                ? 'row-resize'
                : 'crosshair',
          }}
          className="w-full h-full block"
        />

        {/* Movable & Draggable Measurement Readout HUD */}
        {isHudVisible && (
          <div
            style={{
              transform: `translate(${hudPos.x}px, ${hudPos.y}px)`,
              pointerEvents: 'none',
            }}
            className={`absolute top-0 left-0 bg-bf-surface/90 border border-bf-line-strong backdrop-blur-md rounded-lg shadow-[0_8px_24px_rgb(var(--bf-shadow-rgb)/0.7)] text-[11px] transition-shadow z-20 ${
              isDraggingHud ? 'shadow-[0_0_16px_rgb(var(--bf-cyan-rgb)/0.4)] border-bf-cyan/70' : ''
            }`}
          >
            {/* Drag Handle & HUD Header */}
            <div
              onMouseDown={handleHudMouseDown}
              style={{ pointerEvents: 'auto' }}
              className="h-[26px] bg-bf-head border-b border-bf-line px-2 flex items-center justify-between cursor-grab active:cursor-grabbing select-none rounded-t-lg gap-2"
            >
              <div className="flex items-center gap-1.5 text-bf-mute font-semibold text-[11px]">
                <GripHorizontal className="w-3 h-3 text-bf-faint" />
                <span className="tracking-wider uppercase text-bf-dim">
                  MEASUREMENTS [{cursorTargetChannel}]
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsHudCollapsed(!isHudCollapsed);
                  }}
                  className="text-bf-faint hover:text-bf-body p-0.5 rounded transition-colors"
                >
                  {isHudCollapsed ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
                </button>
              </div>
            </div>

            {/* HUD Body */}
            {!isHudCollapsed ? (
              <div className="p-2.5 flex flex-col gap-1.5 min-w-[250px]">
                {(cursorMode === 'TIME' || cursorMode === 'BOTH') && (
                  <div className="space-y-1">
                    <div className="text-[11px] text-bf-faint uppercase tracking-wider font-bold">
                      TIME CURSORS (X) · {cursorTargetChannel}
                    </div>
                    {deltaTUs !== null ? (
                      <>
                        <div className="flex items-center justify-between gap-3 text-[11px]">
                          <span className="text-bf-mute">Δt (X2 - X1):</span>
                          <span className="text-bf-cyan font-bold">{deltaTUs.toLocaleString()} μs</span>
                        </div>
                        <div className="flex items-center justify-between gap-3 text-[11px]">
                          <span className="text-bf-mute">1/Δt (Freq):</span>
                          <span className="text-bf-amber font-bold">{freqHz} Hz</span>
                        </div>
                      </>
                    ) : (
                      <div className="text-bf-faint text-[11px]">Drag X1/X2 markers on screen</div>
                    )}
                  </div>
                )}

                {(cursorMode === 'VOLT' || cursorMode === 'BOTH') && (
                  <div className="space-y-1 border-t border-bf-line pt-1">
                    <div className="flex items-center justify-between text-[11px] text-bf-faint uppercase tracking-wider font-bold">
                      <span>SIGNAL CURSORS (Y)</span>
                      <span
                        className={
                          cursorTargetChannel === 'CH1'
                            ? 'text-bf-amber'
                            : cursorTargetChannel === 'CH2'
                            ? 'text-bf-cyan'
                            : 'text-bf-math'
                        }
                      >
                        [{cursorTargetChannel}]
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 text-[11px]">
                      <span className="text-bf-ok">
                        Y1:{' '}
                        {cursorTargetChannel === 'CH1'
                          ? formatChannelVal(activeCursors.y1, ch1Field, ch1Unit)
                          : cursorTargetChannel === 'CH2'
                          ? formatChannelVal(activeCursors.y1, ch2Field, ch2Unit)
                          : activeCursors.y1.toFixed(2)}
                      </span>
                      <span className="text-bf-purple">
                        Y2:{' '}
                        {cursorTargetChannel === 'CH1'
                          ? formatChannelVal(activeCursors.y2, ch1Field, ch1Unit)
                          : cursorTargetChannel === 'CH2'
                          ? formatChannelVal(activeCursors.y2, ch2Field, ch2Unit)
                          : activeCursors.y2.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 text-[11px]">
                      <span className="text-bf-mute">ΔY (|Y2 - Y1|):</span>
                      <span className="text-bf-ok font-bold">{deltaY}</span>
                    </div>
                    {slewRate && (
                      <div className="flex items-center justify-between gap-3 text-[11px]">
                        <span className="text-bf-mute">Slew / Rate:</span>
                        <span className="text-bf-body">{slewRate}</span>
                      </div>
                    )}
                  </div>
                )}

                <div className="space-y-1 border-t border-bf-line pt-1">
                  <div className="text-[11px] text-bf-faint uppercase tracking-wider font-bold">
                    WAVEFORM METRICS
                  </div>
                  <div className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="text-bf-amber">CH1 ({ch1Field}) Pk-Pk:</span>
                    <span className="text-bf-body font-semibold">
                      {formatStatVal(metricsSnapshot.pkPk1, ch1Field, ch1Unit)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="text-bf-amber">CH1 Mean:</span>
                    <span className="text-bf-body">{formatStatVal(metricsSnapshot.mean1, ch1Field, ch1Unit)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="text-bf-amber">CH1 Min/Max:</span>
                    <span className="text-bf-body">
                      {formatCompact(metricsSnapshot.min1, 2)} / {formatStatVal(metricsSnapshot.max1, ch1Field, ch1Unit)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="text-bf-amber">CH1 RMS:</span>
                    <span className="text-bf-body">{formatStatVal(metricsSnapshot.rms1, ch1Field, ch1Unit)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="text-bf-cyan">CH2 ({ch2Field}) Pk-Pk:</span>
                    <span className="text-bf-body font-semibold">
                      {formatStatVal(metricsSnapshot.pkPk2, ch2Field, ch2Unit)}
                    </span>
                  </div>
                </div>

                {mathVisible && (
                  <div className="space-y-1 border-t border-bf-line pt-1">
                    <div className="text-[11px] text-bf-math uppercase tracking-wider font-bold">
                      MATH: {mathOp}
                    </div>
                    {mathOp === 'FFT' ? (
                      <div className="flex items-center justify-between gap-3 text-[11px]">
                        <span className="text-bf-faint">Dominant Peak:</span>
                        <span className="text-bf-math font-bold">{metricsSnapshot.fftPeakHz} Hz</span>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-3 text-[11px]">
                        <span className="text-bf-faint">Scale:</span>
                        <span className="text-bf-math font-bold">{mathScale}x Multiplier</span>
                      </div>
                    )}
                  </div>
                )}

                <div className="text-[10px] text-bf-ghost pt-0.5 border-t border-bf-btn">
                  Drag card to reposition · Click & drag markers
                </div>
              </div>
            ) : (
              <div className="px-2 py-1 flex items-center gap-3 text-[11px]">
                {deltaTUs !== null && (
                  <span className="text-bf-cyan font-bold">Δt: {deltaTUs.toLocaleString()} μs</span>
                )}
                <span className="text-bf-amber">Pk-Pk: {formatStatVal(metricsSnapshot.pkPk1, ch1Field, ch1Unit)}</span>
                <span className="text-bf-cyan">CH2: {formatStatVal(metricsSnapshot.pkPk2, ch2Field, ch2Unit)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
