import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { ScopeSignalSample } from '../types';
import {
  Eye,
  EyeOff,
  Play,
  Pause,
  ArrowUpRight,
  ArrowDownRight,
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
const MATH_OPERATIONS = ['CH1 - CH2', 'CH1 + CH2', 'CH1 * CH2', 'FFT', 'INV CH1'] as const;
type MathOp = typeof MATH_OPERATIONS[number];
type CursorMode = 'OFF' | 'TIME' | 'VOLT' | 'BOTH';
type CursorChannel = 'CH1' | 'CH2' | 'MATH';
type TriggerSource = 'CH1' | 'CH2';

interface ChannelCursors {
  x1Us: number | null;
  x2Us: number | null;
  y1: number;
  y2: number;
}

export const OscilloscopeView: React.FC = () => {
  const {
    scopeSamples,
    ch1Visible,
    ch2Visible,
    logicRailsVisible,
    toggleChannel,
  } = useWorkstationStore(
    useShallow((s) => ({
      scopeSamples: s.scopeSamples,
      ch1Visible: s.ch1Visible,
      ch2Visible: s.ch2Visible,
      logicRailsVisible: s.logicRailsVisible,
      toggleChannel: s.toggleChannel,
    }))
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // DSO Engine State: Run/Stop & Snapshot Freezing
  const [isRunning, setIsRunning] = useState(true);
  const [singleArmed, setSingleArmed] = useState(false);
  const [frozenSnapshot, setFrozenSnapshot] = useState<{
    samples: ScopeSignalSample[];
    tMin: number;
    tMax: number;
  } | null>(null);

  // Horizontal Timebase: Editable & Presets
  const [timeDivMs, setTimeDivMs] = useState(50); // 50 ms default -> 500 ms window
  const [isEditingTime, setIsEditingTime] = useState(false);
  const [timeInputVal, setTimeInputVal] = useState('50');

  // Channel-Based Horizontal Time Skews (Offsets in ms)
  const [ch1TimeOffsetMs, setCh1TimeOffsetMs] = useState(0);
  const [ch2TimeOffsetMs, setCh2TimeOffsetMs] = useState(0);
  const [mathTimeOffsetMs, setMathTimeOffsetMs] = useState(0);

  // Channel Scales: Editable & Presets
  const [ch1ScaleMv, setCh1ScaleMv] = useState(1000); // 1000 mV/div
  const [ch2ScaleRad, setCh2ScaleRad] = useState(0.5); // 0.5 rad/s/div
  const [mathScale, setMathScale] = useState(1.0); // 1.0x

  // Trigger Sourcing & Thresholds
  const [triggerSource, setTriggerSource] = useState<TriggerSource>('CH1');
  const [triggerMode, setTriggerMode] = useState<'AUTO' | 'NORM' | 'SINGLE'>('AUTO');
  const [triggerSlope, setTriggerSlope] = useState<'RISING' | 'FALLING'>('RISING');
  const [triggerLevelCh1Mv, setTriggerLevelCh1Mv] = useState<number>(7400); // 7.4 V
  const [triggerLevelCh2Rad, setTriggerLevelCh2Rad] = useState<number>(0.2); // 0.2 rad/s

  // Interactive Zoom & Pan State
  const [zoomLevel, setZoomLevel] = useState<number>(1.0);
  const [panOffsetUs, setPanOffsetUs] = useState<number>(0);
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, initialPan: 0 });

  // Independent Marker Cursors Per Channel
  const [cursorTargetChannel, setCursorTargetChannel] = useState<CursorChannel>('CH1');
  const [cursorMode, setCursorMode] = useState<CursorMode>('TIME');
  const [activeMarker, setActiveMarker] = useState<'X1' | 'X2' | 'Y1' | 'Y2'>('X1');

  const [channelCursors, setChannelCursors] = useState<Record<CursorChannel, ChannelCursors>>({
    CH1: { x1Us: null, x2Us: null, y1: 7200, y2: 7600 },
    CH2: { x1Us: null, x2Us: null, y1: -0.25, y2: 0.25 },
    MATH: { x1Us: null, x2Us: null, y1: -0.5, y2: 0.5 },
  });

  const [hoveredMarker, setHoveredMarker] = useState<{
    ch: CursorChannel;
    marker: 'X1' | 'X2' | 'Y1' | 'Y2';
  } | 'TRIG' | null>(null);

  const [draggedMarker, setDraggedMarker] = useState<{
    ch: CursorChannel;
    marker: 'X1' | 'X2' | 'Y1' | 'Y2';
  } | 'TRIG' | null>(null);

  const draggedMarkerRef = useRef<{
    ch: CursorChannel;
    marker: 'X1' | 'X2' | 'Y1' | 'Y2';
  } | 'TRIG' | null>(null);

  // Math Channel State
  const [mathVisible, setMathVisible] = useState(false);
  const [mathOp, setMathOp] = useState<MathOp>('CH1 - CH2');

  // Draggable HUD State
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

  // Display samples: frozen snapshot when stopped, or live stream from store
  const displaySamples = useMemo(() => {
    if (!isRunning && frozenSnapshot) {
      return frozenSnapshot.samples;
    }
    return scopeSamples;
  }, [isRunning, frozenSnapshot, scopeSamples]);

  // Handle single trigger catch
  useEffect(() => {
    if (singleArmed && isRunning && scopeSamples.length > 0) {
      // Catch one frame, freeze scope
      const tx = getTransforms();
      setFrozenSnapshot({
        samples: [...scopeSamples],
        tMin: tx?.tMin ?? 0,
        tMax: tx?.tMax ?? 1000,
      });
      setIsRunning(false);
      setSingleArmed(false);
    }
  }, [singleArmed, isRunning, scopeSamples]);

  // Statistics calculation on CH1 (v_batt) and CH2 (gyro_z)
  const stats = useMemo(() => {
    if (!displaySamples.length) {
      return { minV: 0, maxV: 0, meanV: 0, pkPkV: 0, rmsV: 0, gyroMin: 0, gyroMax: 0, gyroPkPk: 0, fftPeakFreq: 0 };
    }
    const vBatts = displaySamples.map((s) => s.vBattMv);
    const gyros = displaySamples.map((s) => s.gyroZ);

    const minV = Math.min(...vBatts);
    const maxV = Math.max(...vBatts);
    const sum = vBatts.reduce((a, b) => a + b, 0);
    const meanV = Math.round(sum / vBatts.length);
    const pkPkV = maxV - minV;
    const sumSq = vBatts.reduce((a, b) => a + b * b, 0);
    const rmsV = Math.round(Math.sqrt(sumSq / vBatts.length));

    const gyroMin = Math.min(...gyros);
    const gyroMax = Math.max(...gyros);
    const gyroPkPk = +(gyroMax - gyroMin).toFixed(3);

    // Compute FFT Peak Frequency on visible window (up to 64 samples)
    let fftPeakFreq = 0;
    const N = Math.min(64, displaySamples.length);
    if (N >= 8) {
      const slice = vBatts.slice(-N);
      const sliceMean = slice.reduce((a, b) => a + b, 0) / N;
      const dtSec = ((displaySamples[displaySamples.length - 1].timestampUs - displaySamples[0].timestampUs) / (displaySamples.length * 1000000)) || 0.01;
      const sampleRate = 1 / dtSec;

      let maxMag = 0;
      for (let k = 1; k < Math.floor(N / 2); k++) {
        let re = 0;
        let im = 0;
        for (let n = 0; n < N; n++) {
          const angle = (2 * Math.PI * k * n) / N;
          const val = slice[n] - sliceMean;
          re += val * Math.cos(angle);
          im -= val * Math.sin(angle);
        }
        const mag = Math.sqrt(re * re + im * im);
        if (mag > maxMag) {
          maxMag = mag;
          fftPeakFreq = +((k * sampleRate) / N).toFixed(1);
        }
      }
    }

    return { minV, maxV, meanV, pkPkV, rmsV, gyroMin, gyroMax, gyroPkPk, fftPeakFreq };
  }, [displaySamples]);

  // Coordinate transforms
  const getTransforms = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !displaySamples.length) return null;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    // Nominal horizontal window = 10 divisions * timeDivMs
    const nominalSpanUs = Math.max(1000, timeDivMs * 10 * 1000);
    const visibleSpanUs = Math.max(500, nominalSpanUs / zoomLevel);

    let tMin: number;
    let tMax: number;

    if (!isRunning && frozenSnapshot) {
      const snapCenter = (frozenSnapshot.tMin + frozenSnapshot.tMax) / 2 + panOffsetUs;
      tMin = snapCenter - visibleSpanUs / 2;
      tMax = snapCenter + visibleSpanUs / 2;
    } else {
      const latestSample = displaySamples[displaySamples.length - 1];
      const rightEdge = latestSample ? latestSample.timestampUs : 100000;
      const tCenter = rightEdge - visibleSpanUs / 2 + panOffsetUs;
      tMin = tCenter - visibleSpanUs / 2;
      tMax = tCenter + visibleSpanUs / 2;
    }
    const tSpan = Math.max(1, tMax - tMin);

    const analogHeight = logicRailsVisible ? height * 0.7 : height - 20;

    // CH1 Vertical Range
    const ch1SpanMv = (ch1ScaleMv * 6) / zoomLevel;
    const ch1CenterMv = 7400; // 7.4V nominal center
    const ch1Min = ch1CenterMv - ch1SpanMv / 2;
    const ch1Max = ch1CenterMv + ch1SpanMv / 2;

    // CH2 Vertical Range
    const ch2SpanRad = (ch2ScaleRad * 6) / zoomLevel;
    const ch2CenterRad = 0.0;
    const ch2Min = ch2CenterRad - ch2SpanRad / 2;
    const ch2Max = ch2CenterRad + ch2SpanRad / 2;

    // MATH Vertical Range
    const mathSpan = (2.0 * mathScale) / zoomLevel;
    const mathMin = -mathSpan / 2;
    const mathMax = mathSpan / 2;

    const timeToX = (tUs: number) => ((tUs - tMin) / tSpan) * width;
    const xToTime = (x: number) => Math.round(tMin + (x / width) * tSpan);

    const voltToY = (vMv: number) => analogHeight - ((vMv - ch1Min) / (ch1Max - ch1Min)) * (analogHeight - 20) - 10;
    const yToVolt = (y: number) => Math.round(ch1Min + ((analogHeight - 10 - y) / (analogHeight - 20)) * (ch1Max - ch1Min));

    const gyroToY = (gRad: number) => analogHeight - ((gRad - ch2Min) / (ch2Max - ch2Min)) * (analogHeight - 20) - 10;
    const yToGyro = (y: number) => +(ch2Min + ((analogHeight - 10 - y) / (analogHeight - 20)) * (ch2Max - ch2Min)).toFixed(3);

    const mathToY = (mVal: number) => analogHeight - ((mVal - mathMin) / (mathMax - mathMin)) * (analogHeight - 20) - 10;
    const yToMath = (y: number) => +(mathMin + ((analogHeight - 10 - y) / (analogHeight - 20)) * (mathMax - mathMin)).toFixed(3);

    return {
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
      timeToX,
      xToTime,
      voltToY,
      yToVolt,
      gyroToY,
      yToGyro,
      mathToY,
      yToMath,
    };
  }, [
    displaySamples,
    isRunning,
    frozenSnapshot,
    timeDivMs,
    ch1ScaleMv,
    ch2ScaleRad,
    mathScale,
    zoomLevel,
    panOffsetUs,
    logicRailsVisible,
  ]);

  // Clean RUN / STOP Toggle Handler
  const handleToggleRunStop = useCallback(() => {
    if (isRunning) {
      const tx = getTransforms();
      const currentSamples = [...scopeSamples];
      setFrozenSnapshot({
        samples: currentSamples,
        tMin: tx?.tMin ?? 0,
        tMax: tx?.tMax ?? 1000,
      });
      setIsRunning(false);
      setSingleArmed(false);
    } else {
      setFrozenSnapshot(null);
      setIsRunning(true);
    }
  }, [isRunning, scopeSamples, getTransforms]);

  // Single shot trigger arm
  const handleSingleShot = () => {
    if (!isRunning) {
      setFrozenSnapshot(null);
      setIsRunning(true);
    }
    setSingleArmed(true);
  };

  // Preset Stepper Functions for 1-2-5 decades
  const stepTimeDiv = (dir: 'up' | 'down') => {
    const idx = TIME_DIV_PRESETS.findIndex((v) => v >= timeDivMs);
    let nextIdx = idx === -1 ? 5 : idx;
    if (dir === 'up') nextIdx = Math.min(TIME_DIV_PRESETS.length - 1, nextIdx + 1);
    else nextIdx = Math.max(0, nextIdx - 1);
    setTimeDivMs(TIME_DIV_PRESETS[nextIdx]);
  };

  const stepCh1Scale = (dir: 'up' | 'down') => {
    const idx = CH1_SCALE_PRESETS.findIndex((v) => v >= ch1ScaleMv);
    let nextIdx = idx === -1 ? 4 : idx;
    if (dir === 'up') nextIdx = Math.min(CH1_SCALE_PRESETS.length - 1, nextIdx + 1);
    else nextIdx = Math.max(0, nextIdx - 1);
    setCh1ScaleMv(CH1_SCALE_PRESETS[nextIdx]);
  };

  const stepCh2Scale = (dir: 'up' | 'down') => {
    const idx = CH2_SCALE_PRESETS.findIndex((v) => v >= ch2ScaleRad);
    let nextIdx = idx === -1 ? 4 : idx;
    if (dir === 'up') nextIdx = Math.min(CH2_SCALE_PRESETS.length - 1, nextIdx + 1);
    else nextIdx = Math.max(0, nextIdx - 1);
    setCh2ScaleRad(CH2_SCALE_PRESETS[nextIdx]);
  };

  // Canvas 60 FPS Render Loop
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Handle high DPI display
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
    }
    ctx.resetTransform();
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;

    // Background fill
    ctx.fillStyle = '#0A0D13';
    ctx.fillRect(0, 0, width, height);

    // Grid Dimensions (10 Horizontal divisions, 8 Vertical divisions)
    const gridRows = 8;
    const gridCols = 10;
    const rowStep = height / gridRows;
    const colStep = width / gridCols;

    // Graticule Grid
    ctx.strokeStyle = '#161F2E';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);

    for (let r = 1; r < gridRows; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * rowStep);
      ctx.lineTo(width, r * rowStep);
      ctx.stroke();
    }

    for (let c = 1; c < gridCols; c++) {
      ctx.beginPath();
      ctx.moveTo(c * colStep, 0);
      ctx.lineTo(c * colStep, height);
      ctx.stroke();
    }
    ctx.setLineDash([]); // Reset dash

    // Sub-graticule tick marks along center crosshairs
    const midX = width / 2;
    const midY = height / 2;
    ctx.strokeStyle = '#222D3D';
    for (let x = 0; x < width; x += colStep / 5) {
      ctx.beginPath();
      ctx.moveTo(x, midY - 2);
      ctx.lineTo(x, midY + 2);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += rowStep / 5) {
      ctx.beginPath();
      ctx.moveTo(midX - 2, y);
      ctx.lineTo(midX + 2, y);
      ctx.stroke();
    }

    if (!displaySamples.length) {
      ctx.fillStyle = '#64748B';
      ctx.font = '12px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Awaiting continuous telemetry samples...', width / 2, height / 2);
      return;
    }

    const tx = getTransforms();
    if (!tx) return;
    const { analogHeight, tMin, tMax, timeToX, voltToY, gyroToY, mathToY } = tx;

    // --- Channel 1: v_batt_mv with Channel Horizontal Offset (Amber) ---
    if (ch1Visible) {
      ctx.strokeStyle = '#FBBF24';
      ctx.lineWidth = 1.6;
      ctx.beginPath();

      const ch1ShiftUs = ch1TimeOffsetMs * 1000;
      let hasDrawn = false;
      displaySamples.forEach((sample) => {
        const x = timeToX(sample.timestampUs + ch1ShiftUs);
        const y = voltToY(sample.vBattMv);

        if (!hasDrawn) {
          ctx.moveTo(x, y);
          hasDrawn = true;
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
    }

    // --- Channel 2: gyro_z with Channel Horizontal Offset (Cyan) ---
    if (ch2Visible) {
      ctx.strokeStyle = '#00E5FF';
      ctx.lineWidth = 1.6;
      ctx.beginPath();

      const ch2ShiftUs = ch2TimeOffsetMs * 1000;
      let hasDrawn = false;
      displaySamples.forEach((sample) => {
        const x = timeToX(sample.timestampUs + ch2ShiftUs);
        const y = gyroToY(sample.gyroZ);

        if (!hasDrawn) {
          ctx.moveTo(x, y);
          hasDrawn = true;
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
    }

    // --- Channel Math: Operational Waveform with Channel Offset (Magenta) ---
    if (mathVisible) {
      ctx.strokeStyle = '#D946EF';
      ctx.lineWidth = 1.8;

      if (mathOp === 'FFT') {
        const N = Math.min(64, displaySamples.length);
        if (N >= 8) {
          const vBatts = displaySamples.slice(-N).map((s) => s.vBattMv);
          const mean = vBatts.reduce((a, b) => a + b, 0) / N;
          const bins = Math.floor(N / 2);
          const binWidth = width / bins;

          ctx.fillStyle = '#D946EF25';
          ctx.beginPath();
          ctx.moveTo(0, analogHeight - 10);

          let maxMag = 1;
          const mags: number[] = [];
          for (let k = 0; k < bins; k++) {
            let re = 0;
            let im = 0;
            for (let n = 0; n < N; n++) {
              const angle = (2 * Math.PI * k * n) / N;
              const val = vBatts[n] - mean;
              re += val * Math.cos(angle);
              im -= val * Math.sin(angle);
            }
            const m = Math.sqrt(re * re + im * im) * mathScale;
            mags.push(m);
            if (m > maxMag) maxMag = m;
          }

          for (let k = 0; k < bins; k++) {
            const h = (mags[k] / maxMag) * (analogHeight - 40);
            const x = k * binWidth;
            const y = analogHeight - 10 - h;
            ctx.lineTo(x + binWidth / 2, y);
          }
          ctx.lineTo(width, analogHeight - 10);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = '#D946EF';
          ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
          ctx.textAlign = 'left';
          ctx.fillText(`MATH FFT [Peak: ${stats.fftPeakFreq} Hz]`, 10, 22);
        }
      } else {
        const mathShiftUs = mathTimeOffsetMs * 1000;
        ctx.beginPath();
        let hasDrawn = false;
        displaySamples.forEach((sample) => {
          const x = timeToX(sample.timestampUs + mathShiftUs);
          const vNorm = (sample.vBattMv - 7400) / 1000;
          const gNorm = sample.gyroZ;

          let mathVal = 0;
          switch (mathOp) {
            case 'CH1 - CH2':
              mathVal = (vNorm - gNorm) * mathScale;
              break;
            case 'CH1 + CH2':
              mathVal = (vNorm + gNorm) * mathScale;
              break;
            case 'CH1 * CH2':
              mathVal = (vNorm * gNorm * 4) * mathScale;
              break;
            case 'INV CH1':
              mathVal = -vNorm * mathScale;
              break;
          }

          const y = mathToY(mathVal);

          if (!hasDrawn) {
            ctx.moveTo(x, y);
            hasDrawn = true;
          } else {
            ctx.lineTo(x, y);
          }
        });
        ctx.stroke();

        ctx.fillStyle = '#D946EF';
        ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`MATH (${mathOp}) · ${mathScale}x`, 10, 22);
      }
    }

    // --- Trigger Line & Marker ---
    const isCh1Trig = triggerSource === 'CH1';
    const trigY = isCh1Trig ? voltToY(triggerLevelCh1Mv) : gyroToY(triggerLevelCh2Rad);
    const trigColor = isCh1Trig ? '#FBBF24' : '#00E5FF';
    const trigLabel = isCh1Trig ? `T: ${(triggerLevelCh1Mv / 1000).toFixed(2)}V` : `T: ${triggerLevelCh2Rad.toFixed(2)}r/s`;

    if (trigY >= 0 && trigY <= analogHeight) {
      const isTrigHovered = hoveredMarker === 'TRIG' || draggedMarker === 'TRIG';
      ctx.strokeStyle = isTrigHovered ? '#FFFFFF' : `${trigColor}88`;
      ctx.lineWidth = isTrigHovered ? 2 : 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, trigY);
      ctx.lineTo(width, trigY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = isTrigHovered ? '#FFFFFF' : trigColor;
      ctx.beginPath();
      ctx.moveTo(width - 10, trigY - 5);
      ctx.lineTo(width, trigY);
      ctx.lineTo(width - 10, trigY + 5);
      ctx.closePath();
      ctx.fill();

      ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(trigLabel, width - 14, trigY - 2);
    }

    // --- Digital Logic Rails ---
    if (logicRailsVisible) {
      const logicHeight = height - analogHeight;
      const railCount = 3;
      const railStep = logicHeight / railCount;
      const railLabels = ['D0: RUN', 'D1: ARMED', 'D2: FAULT'];
      const railColors = ['#10B981', '#38BDF8', '#EF4444'];

      for (let r = 0; r < railCount; r++) {
        const baseY = analogHeight + (r + 1) * railStep - 4;
        const highY = baseY - (railStep - 8);

        ctx.strokeStyle = '#1E2638';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, baseY);
        ctx.lineTo(width, baseY);
        ctx.stroke();

        ctx.fillStyle = '#64748B';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(railLabels[r], 6, baseY - 2);

        ctx.strokeStyle = railColors[r];
        ctx.lineWidth = 1.5;
        ctx.beginPath();

        let prevY = baseY;
        displaySamples.forEach((sample, idx) => {
          const x = timeToX(sample.timestampUs);
          const bitVal = sample.flags[r] || 0;
          const y = bitVal ? highY : baseY;

          if (idx === 0) {
            ctx.moveTo(x, y);
          } else {
            if (y !== prevY) ctx.lineTo(x, prevY);
            ctx.lineTo(x, y);
          }
          prevY = y;
        });
        ctx.stroke();
      }
    }

    // --- Render Independent Cursors for Each Channel ---
    const channelsToRender: CursorChannel[] = cursorMode !== 'OFF' ? [cursorTargetChannel] : [];

    channelsToRender.forEach((ch) => {
      const cursors = channelCursors[ch];
      const isSelectedCh = ch === cursorTargetChannel;
      const chColor = ch === 'CH1' ? '#FBBF24' : ch === 'CH2' ? '#00E5FF' : '#D946EF';

      // Horizontal / Time Cursors (X1 & X2)
      if (cursorMode === 'TIME' || cursorMode === 'BOTH') {
        // X1
        if (cursors.x1Us !== null && cursors.x1Us >= tMin && cursors.x1Us <= tMax) {
          const x1 = timeToX(cursors.x1Us);
          const isHovered =
            (hoveredMarker && typeof hoveredMarker === 'object' && hoveredMarker.ch === ch && hoveredMarker.marker === 'X1') ||
            (draggedMarker && typeof draggedMarker === 'object' && draggedMarker.ch === ch && draggedMarker.marker === 'X1');

          ctx.strokeStyle = isHovered ? '#FFFFFF' : chColor;
          ctx.lineWidth = isHovered ? 2.2 : isSelectedCh ? 1.6 : 1.0;
          ctx.setLineDash([4, 2]);
          ctx.beginPath();
          ctx.moveTo(x1, 0);
          ctx.lineTo(x1, height);
          ctx.stroke();
          ctx.setLineDash([]);

          // Tag
          ctx.fillStyle = isHovered ? '#FFFFFF' : chColor;
          ctx.fillRect(x1 - 18, 2, 36, 14);
          ctx.fillStyle = '#0A0D13';
          ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText(`${ch}:X1`, x1, 12);
        }

        // X2
        if (cursors.x2Us !== null && cursors.x2Us >= tMin && cursors.x2Us <= tMax) {
          const x2 = timeToX(cursors.x2Us);
          const isHovered =
            (hoveredMarker && typeof hoveredMarker === 'object' && hoveredMarker.ch === ch && hoveredMarker.marker === 'X2') ||
            (draggedMarker && typeof draggedMarker === 'object' && draggedMarker.ch === ch && draggedMarker.marker === 'X2');

          ctx.strokeStyle = isHovered ? '#FFFFFF' : chColor;
          ctx.lineWidth = isHovered ? 2.2 : isSelectedCh ? 1.6 : 1.0;
          ctx.setLineDash([4, 2]);
          ctx.beginPath();
          ctx.moveTo(x2, 0);
          ctx.lineTo(x2, height);
          ctx.stroke();
          ctx.setLineDash([]);

          // Tag
          ctx.fillStyle = isHovered ? '#FFFFFF' : chColor;
          ctx.fillRect(x2 - 18, 18, 36, 14);
          ctx.fillStyle = '#0A0D13';
          ctx.font = 'bold 8.5px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText(`${ch}:X2`, x2, 28);
        }
      }

      // Vertical / Signal Cursors (Y1 & Y2)
      if (cursorMode === 'VOLT' || cursorMode === 'BOTH') {
        let y1Pos = 0;
        let y2Pos = 0;
        let y1Text = '';
        let y2Text = '';

        if (ch === 'CH1') {
          y1Pos = voltToY(cursors.y1);
          y2Pos = voltToY(cursors.y2);
          y1Text = `Y1 ${(cursors.y1 / 1000).toFixed(2)}V`;
          y2Text = `Y2 ${(cursors.y2 / 1000).toFixed(2)}V`;
        } else if (ch === 'CH2') {
          y1Pos = gyroToY(cursors.y1);
          y2Pos = gyroToY(cursors.y2);
          y1Text = `Y1 ${cursors.y1.toFixed(2)}r/s`;
          y2Text = `Y2 ${cursors.y2.toFixed(2)}r/s`;
        } else {
          y1Pos = mathToY(cursors.y1);
          y2Pos = mathToY(cursors.y2);
          y1Text = `Y1 ${cursors.y1.toFixed(2)}`;
          y2Text = `Y2 ${cursors.y2.toFixed(2)}`;
        }

        // Y1
        if (y1Pos >= 0 && y1Pos <= analogHeight) {
          const isHovered =
            (hoveredMarker && typeof hoveredMarker === 'object' && hoveredMarker.ch === ch && hoveredMarker.marker === 'Y1') ||
            (draggedMarker && typeof draggedMarker === 'object' && draggedMarker.ch === ch && draggedMarker.marker === 'Y1');

          ctx.strokeStyle = isHovered ? '#FFFFFF' : '#10B981';
          ctx.lineWidth = isHovered ? 2.2 : isSelectedCh ? 1.6 : 1.0;
          ctx.setLineDash([4, 2]);
          ctx.beginPath();
          ctx.moveTo(0, y1Pos);
          ctx.lineTo(width, y1Pos);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = isHovered ? '#FFFFFF' : '#10B981';
          ctx.fillRect(2, y1Pos - 8, 62, 16);
          ctx.fillStyle = '#0A0D13';
          ctx.font = 'bold 8px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText(y1Text, 33, y1Pos + 3);
        }

        // Y2
        if (y2Pos >= 0 && y2Pos <= analogHeight) {
          const isHovered =
            (hoveredMarker && typeof hoveredMarker === 'object' && hoveredMarker.ch === ch && hoveredMarker.marker === 'Y2') ||
            (draggedMarker && typeof draggedMarker === 'object' && draggedMarker.ch === ch && draggedMarker.marker === 'Y2');

          ctx.strokeStyle = isHovered ? '#FFFFFF' : '#A855F7';
          ctx.lineWidth = isHovered ? 2.2 : isSelectedCh ? 1.6 : 1.0;
          ctx.setLineDash([4, 2]);
          ctx.beginPath();
          ctx.moveTo(0, y2Pos);
          ctx.lineTo(width, y2Pos);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = isHovered ? '#FFFFFF' : '#A855F7';
          ctx.fillRect(66, y2Pos - 8, 62, 16);
          ctx.fillStyle = '#0A0D13';
          ctx.font = 'bold 8px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText(y2Text, 97, y2Pos + 3);
        }
      }
    });

    // --- Stopped / Single Indicator Badge ---
    if (!isRunning) {
      ctx.fillStyle = '#EF444422';
      ctx.strokeStyle = '#EF4444';
      ctx.lineWidth = 1;
      ctx.fillRect(width - 110, 8, 100, 22);
      ctx.strokeRect(width - 110, 8, 100, 22);

      ctx.fillStyle = '#EF4444';
      ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(singleArmed ? '● ARMED SINGLE' : '■ STOPPED', width - 60, 22);
    }
  }, [
    displaySamples,
    isRunning,
    singleArmed,
    ch1Visible,
    ch2Visible,
    logicRailsVisible,
    ch1TimeOffsetMs,
    ch2TimeOffsetMs,
    mathTimeOffsetMs,
    cursorMode,
    cursorTargetChannel,
    channelCursors,
    hoveredMarker,
    draggedMarker,
    mathVisible,
    mathOp,
    mathScale,
    triggerSource,
    triggerLevelCh1Mv,
    triggerLevelCh2Rad,
    getTransforms,
    stats.fftPeakFreq,
  ]);

  // Mirror of isRunning for the render loop (no effect-lag on toggle).
  const runningRef = useRef(isRunning);
  runningRef.current = isRunning;

  // Request Animation Frame Render Loop
  useEffect(() => {
    let animId: number;
    const loop = () => {
      renderCanvas();
      // While STOPPED the frame is static: draw once per state change
      // (cursor drags, HUD moves and ribbon tweaks re-create renderCanvas,
      // re-running this effect) instead of repainting at 60 fps forever.
      if (!runningRef.current) return;
      animId = requestAnimationFrame(loop);
    };
    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [renderCanvas]);

  // Zoom timebase via mouse wheel
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.25 : 0.8;
    setZoomLevel((prev) => Math.min(10.0, Math.max(0.2, Math.round(prev * factor * 100) / 100)));
  };

  // Mouse Down
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const tx = getTransforms();
    if (!tx) return;

    if (hoveredMarker) {
      setDraggedMarker(hoveredMarker);
      draggedMarkerRef.current = hoveredMarker;
      return;
    }

    // Pan waveform
    isPanningRef.current = true;
    panStartRef.current = {
      x: e.clientX,
      initialPan: panOffsetUs,
    };
  };

  // Mouse Move
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const tx = getTransforms();
    if (!tx) return;
    const {
      timeToX,
      xToTime,
      voltToY,
      yToVolt,
      gyroToY,
      yToGyro,
      mathToY,
      yToMath,
      tMin,
      tMax,
      ch1Min,
      ch1Max,
      ch2Min,
      ch2Max,
      mathMin,
      mathMax,
    } = tx;

    // 1. Live Marker Dragging
    const activeDrag = draggedMarkerRef.current;
    if (activeDrag) {
      if (activeDrag === 'TRIG') {
        if (triggerSource === 'CH1') {
          setTriggerLevelCh1Mv(Math.max(ch1Min, Math.min(ch1Max, yToVolt(mouseY))));
        } else {
          setTriggerLevelCh2Rad(Math.max(ch2Min, Math.min(ch2Max, yToGyro(mouseY))));
        }
      } else {
        const { ch, marker } = activeDrag;
        const current = { ...channelCursors[ch] };

        if (marker === 'X1') {
          current.x1Us = Math.max(tMin, Math.min(tMax, xToTime(mouseX)));
        } else if (marker === 'X2') {
          current.x2Us = Math.max(tMin, Math.min(tMax, xToTime(mouseX)));
        } else if (marker === 'Y1') {
          if (ch === 'CH1') current.y1 = Math.max(ch1Min, Math.min(ch1Max, yToVolt(mouseY)));
          else if (ch === 'CH2') current.y1 = Math.max(ch2Min, Math.min(ch2Max, yToGyro(mouseY)));
          else current.y1 = Math.max(mathMin, Math.min(mathMax, yToMath(mouseY)));
        } else if (marker === 'Y2') {
          if (ch === 'CH1') current.y2 = Math.max(ch1Min, Math.min(ch1Max, yToVolt(mouseY)));
          else if (ch === 'CH2') current.y2 = Math.max(ch2Min, Math.min(ch2Max, yToGyro(mouseY)));
          else current.y2 = Math.max(mathMin, Math.min(mathMax, yToMath(mouseY)));
        }

        setChannelCursors((prev) => ({ ...prev, [ch]: current }));
      }
      return;
    }

    // 2. Waveform Pan Dragging
    if (isPanningRef.current) {
      const deltaX = e.clientX - panStartRef.current.x;
      const nominalSpanUs = timeDivMs * 10 * 1000;
      const visibleSpanUs = nominalSpanUs / zoomLevel;
      const usPerPx = visibleSpanUs / canvas.clientWidth;
      setPanOffsetUs(panStartRef.current.initialPan - deltaX * usPerPx);
      return;
    }

    // 3. Hover Detection
    let detected: { ch: CursorChannel; marker: 'X1' | 'X2' | 'Y1' | 'Y2' } | 'TRIG' | null = null;
    const threshold = 8; // px

    // Check Trigger Arrow hover
    const isCh1Trig = triggerSource === 'CH1';
    const trigY = isCh1Trig ? voltToY(triggerLevelCh1Mv) : gyroToY(triggerLevelCh2Rad);
    if (Math.abs(mouseY - trigY) <= threshold) {
      detected = 'TRIG';
    }

    // Check Cursors for active target channel
    if (!detected && cursorMode !== 'OFF') {
      const ch = cursorTargetChannel;
      const cursors = channelCursors[ch];

      if (cursorMode === 'TIME' || cursorMode === 'BOTH') {
        if (cursors.x1Us !== null && Math.abs(mouseX - timeToX(cursors.x1Us)) <= threshold) {
          detected = { ch, marker: 'X1' };
        } else if (cursors.x2Us !== null && Math.abs(mouseX - timeToX(cursors.x2Us)) <= threshold) {
          detected = { ch, marker: 'X2' };
        }
      }

      if (!detected && (cursorMode === 'VOLT' || cursorMode === 'BOTH')) {
        let y1Pos = 0;
        let y2Pos = 0;
        if (ch === 'CH1') {
          y1Pos = voltToY(cursors.y1);
          y2Pos = voltToY(cursors.y2);
        } else if (ch === 'CH2') {
          y1Pos = gyroToY(cursors.y1);
          y2Pos = gyroToY(cursors.y2);
        } else {
          y1Pos = mathToY(cursors.y1);
          y2Pos = mathToY(cursors.y2);
        }

        if (Math.abs(mouseY - y1Pos) <= threshold) {
          detected = { ch, marker: 'Y1' };
        } else if (Math.abs(mouseY - y2Pos) <= threshold) {
          detected = { ch, marker: 'Y2' };
        }
      }
    }

    setHoveredMarker(detected);
  };

  // Mouse Up
  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (draggedMarkerRef.current) {
      draggedMarkerRef.current = null;
      setDraggedMarker(null);
      return;
    }

    if (isPanningRef.current) {
      const deltaX = Math.abs(e.clientX - panStartRef.current.x);
      isPanningRef.current = false;
      if (deltaX < 4) {
        handleCanvasClick(e);
      }
    }
  };

  // Direct Placement on Canvas Click
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !displaySamples.length) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const tx = getTransforms();
    if (!tx) return;

    const ch = cursorTargetChannel;
    const current = { ...channelCursors[ch] };

    if (activeMarker === 'X1') {
      current.x1Us = tx.xToTime(clickX);
    } else if (activeMarker === 'X2') {
      current.x2Us = tx.xToTime(clickX);
    } else if (activeMarker === 'Y1') {
      if (ch === 'CH1') current.y1 = tx.yToVolt(clickY);
      else if (ch === 'CH2') current.y1 = tx.yToGyro(clickY);
      else current.y1 = tx.yToMath(clickY);
    } else if (activeMarker === 'Y2') {
      if (ch === 'CH1') current.y2 = tx.yToVolt(clickY);
      else if (ch === 'CH2') current.y2 = tx.yToGyro(clickY);
      else current.y2 = tx.yToMath(clickY);
    }

    setChannelCursors((prev) => ({ ...prev, [ch]: current }));
  };

  // Quick Action: Center Cursors for active channel
  const handleCenterCursors = () => {
    const tx = getTransforms();
    if (!tx) return;
    const { tMin, tMax, ch1Min, ch1Max, ch2Min, ch2Max, mathMin, mathMax } = tx;
    const tSpan = tMax - tMin;
    const ch = cursorTargetChannel;

    const updated = { ...channelCursors[ch] };
    updated.x1Us = Math.round(tMin + tSpan * 0.3);
    updated.x2Us = Math.round(tMin + tSpan * 0.7);

    if (ch === 'CH1') {
      const vSpan = ch1Max - ch1Min;
      updated.y1 = Math.round(ch1Min + vSpan * 0.3);
      updated.y2 = Math.round(ch1Min + vSpan * 0.7);
    } else if (ch === 'CH2') {
      const gSpan = ch2Max - ch2Min;
      updated.y1 = +(ch2Min + gSpan * 0.3).toFixed(3);
      updated.y2 = +(ch2Min + gSpan * 0.7).toFixed(3);
    } else {
      const mSpan = mathMax - mathMin;
      updated.y1 = +(mathMin + mSpan * 0.3).toFixed(3);
      updated.y2 = +(mathMin + mSpan * 0.7).toFixed(3);
    }

    setChannelCursors((prev) => ({ ...prev, [ch]: updated }));
  };

  // Quick Action: Snap Y Cursors to Waveform Min/Max Peaks
  const handleSnapToPeaks = () => {
    const ch = cursorTargetChannel;
    const updated = { ...channelCursors[ch] };
    if (ch === 'CH1' && stats.minV && stats.maxV) {
      updated.y1 = stats.minV;
      updated.y2 = stats.maxV;
    } else if (ch === 'CH2' && stats.gyroMin !== undefined && stats.gyroMax !== undefined) {
      updated.y1 = stats.gyroMin;
      updated.y2 = stats.gyroMax;
    }
    setChannelCursors((prev) => ({ ...prev, [ch]: updated }));
  };

  // Quick Action: Clear Cursors for active channel
  const handleClearCursors = () => {
    const ch = cursorTargetChannel;
    setChannelCursors((prev) => ({
      ...prev,
      [ch]: { x1Us: null, x2Us: null, y1: ch === 'CH1' ? 7400 : 0, y2: ch === 'CH1' ? 7400 : 0 },
    }));
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

    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - hudDragStart.current.mouseX;
      const dy = e.clientY - hudDragStart.current.mouseY;
      const container = containerRef.current;
      const maxW = container ? container.clientWidth - 260 : 600;
      const maxH = container ? container.clientHeight - 80 : 400;

      const newX = Math.max(8, Math.min(maxW, hudDragStart.current.startX + dx));
      const newY = Math.max(8, Math.min(maxH, hudDragStart.current.startY + dy));

      setHudPos({ x: newX, y: newY });
    };

    const handleMouseUp = () => {
      setIsDraggingHud(false);
      try {
        localStorage.setItem('bforge_scope_hud_pos', JSON.stringify(hudPos));
      } catch (_) {}
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingHud, hudPos]);

  // Delta calculations for currently selected cursor channel
  const activeCursors = channelCursors[cursorTargetChannel];
  const deltaTUs =
    activeCursors.x1Us !== null && activeCursors.x2Us !== null
      ? Math.abs(activeCursors.x2Us - activeCursors.x1Us)
      : null;
  const freqHz = deltaTUs && deltaTUs > 0 ? (1000000 / deltaTUs).toFixed(1) : null;

  const deltaY = useMemo(() => {
    if (cursorTargetChannel === 'CH1') {
      const d = Math.abs(activeCursors.y2 - activeCursors.y1);
      return `${d} mV (${(d / 1000).toFixed(2)} V)`;
    } else if (cursorTargetChannel === 'CH2') {
      const d = +(Math.abs(activeCursors.y2 - activeCursors.y1)).toFixed(3);
      return `${d} rad/s`;
    } else {
      const d = +(Math.abs(activeCursors.y2 - activeCursors.y1)).toFixed(3);
      return `${d}`;
    }
  }, [cursorTargetChannel, activeCursors]);

  const slewRate = useMemo(() => {
    if (!deltaTUs || deltaTUs === 0) return null;
    if (cursorTargetChannel === 'CH1') {
      const dV = Math.abs(activeCursors.y2 - activeCursors.y1) / 1000;
      const dtSec = deltaTUs / 1000000;
      return `${(dV / dtSec).toFixed(1)} V/s`;
    } else if (cursorTargetChannel === 'CH2') {
      const dW = Math.abs(activeCursors.y2 - activeCursors.y1);
      const dtSec = deltaTUs / 1000000;
      return `${(dW / dtSec).toFixed(1)} rad/s²`;
    }
    return null;
  }, [deltaTUs, cursorTargetChannel, activeCursors]);

  return (
    <div ref={containerRef} className="flex flex-col h-full bg-[#0E121B] select-none text-[11px] font-mono">
      {/* 2-ROW DSO CONTROLS RIBBON */}
      <div className="flex flex-col bg-[#161C28] border-b border-[#222D3D] shrink-0">
        {/* ROW 1: Acquisition Engine & Per-Channel Stems (Timebase, Scale, Channel Offsets) */}
        <div className="h-[30px] border-b border-[#222D3D]/60 px-2 flex items-center justify-between gap-2 overflow-x-auto">
          {/* Left: RUN/STOP, SINGLE, and Horizontal Timebase */}
          <div className="flex items-center gap-1.5 shrink-0">
            {/* RUN / STOP Trigger */}
            <button
              onClick={handleToggleRunStop}
              data-tooltip={isRunning ? 'Freeze scope acquisition (Stop)' : 'Resume real-time telemetry streaming (Run)'}
              data-tooltip-shortcut="Space"
              className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded text-[10px] font-bold transition-all shadow-sm ${
                isRunning
                  ? 'bg-[#10B981]/20 border border-[#10B981] text-[#10B981] hover:bg-[#10B981]/30'
                  : 'bg-[#EF4444] text-white animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.6)]'
              }`}
            >
              {isRunning ? <Play className="w-2.5 h-2.5 fill-current" /> : <Pause className="w-2.5 h-2.5 fill-current" />}
              <span>{isRunning ? 'RUNNING' : 'STOPPED'}</span>
            </button>

            {/* SINGLE Trigger Shot */}
            <button
              onClick={handleSingleShot}
              data-tooltip="Arm Single Capture: Ingest one complete frame and freeze acquisition"
              className={`px-2 py-0.5 rounded text-[9.5px] font-bold border transition-colors ${
                singleArmed
                  ? 'bg-[#F59E0B] text-[#0A0D13] border-[#F59E0B] animate-pulse'
                  : 'bg-[#10141D] text-[#94A3B8] border-[#222D3D] hover:text-white'
              }`}
            >
              SINGLE
            </button>

            {/* Horizontal Timebase Stepper / Direct Input */}
            <div className="flex items-center gap-0.5 bg-[#10141D] border border-[#222D3D] rounded px-1 py-0.5 text-[9.5px]">
              <span className="text-[#64748B] pl-0.5 font-bold">TIME:</span>
              <button
                onClick={() => stepTimeDiv('down')}
                data-tooltip="Step timebase faster (fewer ms/div)"
                className="px-1 text-[#94A3B8] hover:text-[#00E5FF] hover:bg-[#1E2638] rounded"
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
                  className="w-12 bg-[#0A0D13] text-[#00E5FF] text-center font-bold px-0.5 rounded outline-none border border-[#00E5FF]"
                />
              ) : (
                <span
                  onClick={() => {
                    setTimeInputVal(timeDivMs.toString());
                    setIsEditingTime(true);
                  }}
                  data-tooltip="Click to type custom Time/Div value (ms)"
                  className="text-[#00E5FF] font-bold px-1 cursor-text hover:underline"
                >
                  {timeDivMs} ms/div
                </span>
              )}

              <button
                onClick={() => stepTimeDiv('up')}
                data-tooltip="Step timebase slower (more ms/div)"
                className="px-1 text-[#94A3B8] hover:text-[#00E5FF] hover:bg-[#1E2638] rounded"
              >
                <Plus className="w-2.5 h-2.5" />
              </button>
              <span className="text-[#64748B] text-[8.5px] pr-0.5">({timeDivMs * 10}ms)</span>
            </div>
          </div>

          {/* Right: Per-Channel Stems (CH1, CH2, MATH, LOGIC) with Vertical Scale & Horizontal Skew */}
          <div className="flex items-center gap-1.5 shrink-0">
            {/* CH1 Stem */}
            <div className="flex items-center gap-1 bg-[#10141D] border border-[#222D3D] rounded px-1.5 py-0.5 text-[9.5px]">
              <button
                onClick={() => toggleChannel('ch1')}
                data-tooltip="Toggle Channel 1 (Battery Voltage Telemetry)"
                className={`flex items-center gap-1 px-1 py-0.2 rounded font-bold transition-colors ${
                  ch1Visible
                    ? 'bg-[#FBBF24]/20 border border-[#FBBF24]/60 text-[#FBBF24]'
                    : 'text-[#64748B] hover:text-[#94A3B8]'
                }`}
              >
                {ch1Visible ? <Eye className="w-2.5 h-2.5" /> : <EyeOff className="w-2.5 h-2.5" />}
                <span>CH1</span>
              </button>

              {/* CH1 Vertical Scale */}
              <button
                onClick={() => stepCh1Scale('down')}
                data-tooltip="Decrease CH1 Volts/Div scale"
                className="px-0.5 text-[#94A3B8] hover:text-[#FBBF24]"
              >
                <Minus className="w-2 h-2" />
              </button>
              <button
                onClick={() => {
                  const idx = (CH1_SCALE_PRESETS.indexOf(ch1ScaleMv) + 1) % CH1_SCALE_PRESETS.length;
                  setCh1ScaleMv(CH1_SCALE_PRESETS[idx]);
                }}
                data-tooltip="CH1 Scale: Click to cycle standard 1-2-5 decade presets"
                className="text-[#FBBF24] font-bold hover:underline px-0.5"
              >
                {ch1ScaleMv >= 1000 ? `${ch1ScaleMv / 1000} V` : `${ch1ScaleMv} mV`}/div
              </button>
              <button
                onClick={() => stepCh1Scale('up')}
                data-tooltip="Increase CH1 Volts/Div scale"
                className="px-0.5 text-[#94A3B8] hover:text-[#FBBF24]"
              >
                <Plus className="w-2 h-2" />
              </button>

              {/* CH1 Horizontal Skew / Offset */}
              <div className="flex items-center border-l border-[#222D3D] pl-1 ml-0.5 text-[9px]">
                <span className="text-[#64748B] pr-0.5">Δt:</span>
                <button
                  onClick={() => setCh1TimeOffsetMs((prev) => prev - 5)}
                  data-tooltip="Shift CH1 waveform 5 ms earlier (negative delay)"
                  className="px-0.5 text-[#64748B] hover:text-white"
                >
                  -
                </button>
                <span
                  onClick={() => setCh1TimeOffsetMs(0)}
                  data-tooltip="CH1 Horizontal Offset (Click to reset to 0ms)"
                  className={`cursor-pointer px-0.5 font-bold ${
                    ch1TimeOffsetMs !== 0 ? 'text-[#FBBF24]' : 'text-[#64748B]'
                  }`}
                >
                  {ch1TimeOffsetMs}ms
                </span>
                <button
                  onClick={() => setCh1TimeOffsetMs((prev) => prev + 5)}
                  data-tooltip="Shift CH1 waveform 5 ms later (positive delay)"
                  className="px-0.5 text-[#64748B] hover:text-white"
                >
                  +
                </button>
              </div>
            </div>

            {/* CH2 Stem */}
            <div className="flex items-center gap-1 bg-[#10141D] border border-[#222D3D] rounded px-1.5 py-0.5 text-[9.5px]">
              <button
                onClick={() => toggleChannel('ch2')}
                data-tooltip="Toggle Channel 2 (Gyroscope Z Rate)"
                className={`flex items-center gap-1 px-1 py-0.2 rounded font-bold transition-colors ${
                  ch2Visible
                    ? 'bg-[#00E5FF]/20 border border-[#00E5FF]/60 text-[#00E5FF]'
                    : 'text-[#64748B] hover:text-[#94A3B8]'
                }`}
              >
                {ch2Visible ? <Eye className="w-2.5 h-2.5" /> : <EyeOff className="w-2.5 h-2.5" />}
                <span>CH2</span>
              </button>

              {/* CH2 Vertical Scale */}
              <button
                onClick={() => stepCh2Scale('down')}
                data-tooltip="Decrease CH2 rad/s scale"
                className="px-0.5 text-[#94A3B8] hover:text-[#00E5FF]"
              >
                <Minus className="w-2 h-2" />
              </button>
              <button
                onClick={() => {
                  const idx = (CH2_SCALE_PRESETS.indexOf(ch2ScaleRad) + 1) % CH2_SCALE_PRESETS.length;
                  setCh2ScaleRad(CH2_SCALE_PRESETS[idx]);
                }}
                data-tooltip="CH2 Scale: Click to cycle rad/s decade presets"
                className="text-[#00E5FF] font-bold hover:underline px-0.5"
              >
                {ch2ScaleRad} r/s/div
              </button>
              <button
                onClick={() => stepCh2Scale('up')}
                data-tooltip="Increase CH2 rad/s scale"
                className="px-0.5 text-[#94A3B8] hover:text-[#00E5FF]"
              >
                <Plus className="w-2 h-2" />
              </button>

              {/* CH2 Horizontal Skew / Offset */}
              <div className="flex items-center border-l border-[#222D3D] pl-1 ml-0.5 text-[9px]">
                <span className="text-[#64748B] pr-0.5">Δt:</span>
                <button
                  onClick={() => setCh2TimeOffsetMs((prev) => prev - 5)}
                  data-tooltip="Shift CH2 waveform 5 ms earlier (negative delay)"
                  className="px-0.5 text-[#64748B] hover:text-white"
                >
                  -
                </button>
                <span
                  onClick={() => setCh2TimeOffsetMs(0)}
                  data-tooltip="CH2 Horizontal Offset (Click to reset to 0ms)"
                  className={`cursor-pointer px-0.5 font-bold ${
                    ch2TimeOffsetMs !== 0 ? 'text-[#00E5FF]' : 'text-[#64748B]'
                  }`}
                >
                  {ch2TimeOffsetMs}ms
                </span>
                <button
                  onClick={() => setCh2TimeOffsetMs((prev) => prev + 5)}
                  data-tooltip="Shift CH2 waveform 5 ms later (positive delay)"
                  className="px-0.5 text-[#64748B] hover:text-white"
                >
                  +
                </button>
              </div>
            </div>

            {/* MATH Stem */}
            <div className="flex items-center gap-1 bg-[#10141D] border border-[#222D3D] rounded px-1.5 py-0.5 text-[9.5px]">
              <button
                onClick={() => setMathVisible(!mathVisible)}
                data-tooltip="Toggle Oscilloscope Math Channel (Differential, FFT, Inverted)"
                className={`flex items-center gap-1 px-1 py-0.2 rounded font-bold transition-colors ${
                  mathVisible
                    ? 'bg-[#D946EF]/20 border border-[#D946EF] text-[#D946EF]'
                    : 'text-[#64748B] hover:text-[#D946EF]'
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
                    className="px-1 text-[#D946EF] font-bold hover:underline"
                  >
                    {mathOp}
                  </button>
                  <button
                    onClick={() => setMathScale((prev) => (prev === 0.5 ? 1.0 : prev === 1.0 ? 2.0 : 0.5))}
                    data-tooltip="Cycle Math Amplitude Scale Multiplier"
                    className="px-1 text-[#94A3B8] text-[9px] hover:text-white border-l border-[#222D3D]"
                  >
                    {mathScale}x
                  </button>

                  <div className="flex items-center border-l border-[#222D3D] pl-1 ml-0.5 text-[9px]">
                    <span className="text-[#64748B] pr-0.5">Δt:</span>
                    <button
                      onClick={() => setMathTimeOffsetMs((prev) => prev - 5)}
                      data-tooltip="Shift Math waveform 5 ms earlier"
                      className="px-0.5 text-[#64748B] hover:text-white"
                    >
                      -
                    </button>
                    <span
                      onClick={() => setMathTimeOffsetMs(0)}
                      data-tooltip="Math Horizontal Offset (Click to reset to 0ms)"
                      className={`cursor-pointer px-0.5 font-bold ${
                        mathTimeOffsetMs !== 0 ? 'text-[#D946EF]' : 'text-[#64748B]'
                      }`}
                    >
                      {mathTimeOffsetMs}ms
                    </span>
                    <button
                      onClick={() => setMathTimeOffsetMs((prev) => prev + 5)}
                      data-tooltip="Shift Math waveform 5 ms later"
                      className="px-0.5 text-[#64748B] hover:text-white"
                    >
                      +
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* LOGIC Stem */}
            <button
              onClick={() => toggleChannel('logic')}
              data-tooltip="Toggle Digital Logic State Rails (D0-D2: RUN, ARMED, FAULT)"
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9.5px] transition-colors border ${
                logicRailsVisible
                  ? 'bg-[#10B981]/20 border-[#10B981]/60 text-[#10B981]'
                  : 'bg-[#10141D] border-[#222D3D] text-[#64748B] hover:text-[#94A3B8]'
              }`}
            >
              {logicRailsVisible ? <Eye className="w-2.5 h-2.5" /> : <EyeOff className="w-2.5 h-2.5" />}
              <span>LOGIC</span>
            </button>
          </div>
        </div>

        {/* ROW 2: Trigger Engine, Independent Channel Cursors, Display Zoom & HUD */}
        <div className="h-[30px] px-2 flex items-center justify-between gap-2 overflow-x-auto text-[9.5px]">
          {/* Left: Trigger Engine */}
          <div className="flex items-center gap-1.5 shrink-0">
            <div className="flex items-center gap-1 bg-[#10141D] border border-[#222D3D] rounded px-1.5 py-0.5">
              <span className="text-[#64748B] font-bold">TRIG:</span>

              {/* Mode */}
              <button
                onClick={() => {
                  const modes: Array<'AUTO' | 'NORM' | 'SINGLE'> = ['AUTO', 'NORM', 'SINGLE'];
                  const nextIdx = (modes.indexOf(triggerMode) + 1) % modes.length;
                  setTriggerMode(modes[nextIdx]);
                }}
                data-tooltip="Trigger Mode: AUTO (continuous), NORM (threshold), SINGLE (freeze on event)"
                className="text-[#E2E8F0] font-bold hover:text-[#00E5FF] px-0.5"
              >
                {triggerMode}
              </button>

              {/* Source */}
              <button
                onClick={() => setTriggerSource((prev) => (prev === 'CH1' ? 'CH2' : 'CH1'))}
                data-tooltip="Trigger Channel Source: Click to switch between CH1 and CH2"
                className={`font-bold px-1 rounded transition-colors ${
                  triggerSource === 'CH1' ? 'text-[#FBBF24] bg-[#FBBF24]/10' : 'text-[#00E5FF] bg-[#00E5FF]/10'
                }`}
              >
                {triggerSource}
              </button>

              {/* Level Stepper / Preset Cycler */}
              <button
                onClick={() => {
                  if (triggerSource === 'CH1') {
                    const presets = [6800, 7200, 7400, 7800, 8200];
                    const idx = (presets.indexOf(triggerLevelCh1Mv) + 1) % presets.length;
                    setTriggerLevelCh1Mv(presets[idx]);
                  } else {
                    const presets = [-0.5, -0.2, 0.0, 0.2, 0.5];
                    const idx = (presets.indexOf(triggerLevelCh2Rad) + 1) % presets.length;
                    setTriggerLevelCh2Rad(presets[idx]);
                  }
                }}
                data-tooltip="Trigger Threshold: Click to cycle presets, or drag arrow on canvas right border"
                className="text-[#94A3B8] hover:text-white px-0.5 border-l border-[#222D3D]"
              >
                {triggerSource === 'CH1' ? `${(triggerLevelCh1Mv / 1000).toFixed(2)}V` : `${triggerLevelCh2Rad.toFixed(2)}r/s`}
              </button>

              {/* Slope */}
              <button
                onClick={() => setTriggerSlope(triggerSlope === 'RISING' ? 'FALLING' : 'RISING')}
                data-tooltip={`Trigger Slope: ${triggerSlope} Edge`}
                className="text-[#FBBF24] hover:text-white ml-0.5"
              >
                {triggerSlope === 'RISING' ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
              </button>
            </div>
          </div>

          {/* Center: Independent Marker Cursors Per Channel */}
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Target Channel Selector */}
            <div className="flex items-center gap-1 bg-[#10141D] border border-[#222D3D] rounded px-1.5 py-0.5">
              <Crosshair className="w-3 h-3 text-[#00E5FF]" />
              <span className="text-[#64748B] font-bold">CURSORS FOR:</span>
              {(['CH1', 'CH2', 'MATH'] as const).map((ch) => (
                <button
                  key={ch}
                  onClick={() => setCursorTargetChannel(ch)}
                  data-tooltip={`Switch active cursors to ${ch}`}
                  className={`px-1.5 py-0.2 rounded font-bold transition-colors ${
                    cursorTargetChannel === ch
                      ? ch === 'CH1'
                        ? 'bg-[#FBBF24] text-[#0A0D13]'
                        : ch === 'CH2'
                        ? 'bg-[#00E5FF] text-[#0A0D13]'
                        : 'bg-[#D946EF] text-[#0A0D13]'
                      : 'text-[#64748B] hover:text-white'
                  }`}
                >
                  {ch}
                </button>
              ))}
            </div>

            {/* Cursor Mode for Target Channel */}
            <div className="flex items-center gap-0.5 bg-[#10141D] border border-[#222D3D] rounded px-1 py-0.5">
              {(['OFF', 'TIME', 'VOLT', 'BOTH'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setCursorMode(mode)}
                  data-tooltip={`Cursor Mode: ${mode === 'TIME' ? 'Time (X1, X2)' : mode === 'VOLT' ? 'Signal (Y1, Y2)' : mode === 'BOTH' ? 'Dual (X + Y)' : 'Disabled'}`}
                  className={`px-1 py-0.2 rounded font-bold transition-colors ${
                    cursorMode === mode
                      ? 'bg-[#00E5FF] text-[#0A0D13]'
                      : 'text-[#64748B] hover:text-[#E2E8F0]'
                  }`}
                >
                  {mode === 'TIME' ? 'X' : mode === 'VOLT' ? 'Y' : mode === 'BOTH' ? 'X+Y' : 'OFF'}
                </button>
              ))}
            </div>

            {/* Marker Set & Alignment Controls */}
            {cursorMode !== 'OFF' && (
              <div className="flex items-center gap-0.5 bg-[#10141D] border border-[#222D3D] rounded px-1 py-0.5">
                <span className="text-[#64748B] px-0.5">SET:</span>
                {(cursorMode === 'TIME' || cursorMode === 'BOTH') && (
                  <>
                    <button
                      onClick={() => setActiveMarker('X1')}
                      data-tooltip={`Active: ${cursorTargetChannel}:X1 (Click canvas to place)`}
                      className={`px-1 py-0.2 rounded font-bold ${
                        activeMarker === 'X1' ? 'bg-[#00E5FF] text-[#0A0D13]' : 'text-[#00E5FF] hover:bg-[#00E5FF]/20'
                      }`}
                    >
                      X1
                    </button>
                    <button
                      onClick={() => setActiveMarker('X2')}
                      data-tooltip={`Active: ${cursorTargetChannel}:X2 (Click canvas to place)`}
                      className={`px-1 py-0.2 rounded font-bold ${
                        activeMarker === 'X2' ? 'bg-[#FBBF24] text-[#0A0D13]' : 'text-[#FBBF24] hover:bg-[#FBBF24]/20'
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
                        activeMarker === 'Y1' ? 'bg-[#10B981] text-[#0A0D13]' : 'text-[#10B981] hover:bg-[#10B981]/20'
                      }`}
                    >
                      Y1
                    </button>
                    <button
                      onClick={() => setActiveMarker('Y2')}
                      data-tooltip={`Active: ${cursorTargetChannel}:Y2 (Click canvas to place)`}
                      className={`px-1 py-0.2 rounded font-bold ${
                        activeMarker === 'Y2' ? 'bg-[#A855F7] text-[#0A0D13]' : 'text-[#A855F7] hover:bg-[#A855F7]/20'
                      }`}
                    >
                      Y2
                    </button>
                  </>
                )}
                <button
                  onClick={handleCenterCursors}
                  data-tooltip={`Center active ${cursorTargetChannel} cursors symmetrically in view`}
                  className="px-1 py-0.2 text-[#64748B] hover:text-[#00E5FF] ml-0.5 border-l border-[#222D3D]"
                >
                  CTR
                </button>
                <button
                  onClick={handleSnapToPeaks}
                  data-tooltip={`Snap ${cursorTargetChannel} Y cursors to min/max waveform peaks`}
                  className="px-1 py-0.2 text-[#64748B] hover:text-[#FBBF24]"
                >
                  SNAP
                </button>
                <button
                  onClick={handleClearCursors}
                  data-tooltip={`Clear cursors for ${cursorTargetChannel}`}
                  className="px-1 py-0.2 text-[#64748B] hover:text-[#EF4444]"
                >
                  CLR
                </button>
              </div>
            )}
          </div>

          {/* Right: Display Zoom, Fit & HUD Toggle */}
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Zoom Stepper */}
            <div className="flex items-center gap-1 bg-[#10141D] border border-[#222D3D] rounded px-1.5 py-0.5">
              <ZoomIn className="w-3 h-3 text-[#64748B]" />
              <button
                onClick={() => setZoomLevel((prev) => Math.max(0.2, Math.round((prev * 0.8) * 100) / 100))}
                data-tooltip="Zoom out waveform view"
                className="px-0.5 text-[#64748B] hover:text-white"
              >
                -
              </button>
              <span className="text-[#00E5FF] font-bold px-0.5">{zoomLevel.toFixed(1)}x</span>
              <button
                onClick={() => setZoomLevel((prev) => Math.min(10.0, Math.round((prev * 1.25) * 100) / 100))}
                data-tooltip="Zoom in waveform view"
                className="px-0.5 text-[#64748B] hover:text-white"
              >
                +
              </button>
              {(zoomLevel !== 1.0 || panOffsetUs !== 0) && (
                <button
                  onClick={() => {
                    setZoomLevel(1.0);
                    setPanOffsetUs(0);
                  }}
                  data-tooltip="Reset waveform zoom and pan to 1.0x"
                  className="text-[#FBBF24] hover:text-white ml-0.5 border-l border-[#222D3D] pl-1"
                >
                  FIT
                </button>
              )}
            </div>

            {/* Measurement HUD Toggle */}
            <button
              onClick={() => setIsHudVisible(!isHudVisible)}
              data-tooltip="Toggle on-screen draggable measurement HUD card"
              className={`px-1.5 py-0.5 rounded border transition-colors ${
                isHudVisible
                  ? 'bg-[#00E5FF]/15 border-[#00E5FF]/40 text-[#00E5FF]'
                  : 'bg-[#10141D] border-[#222D3D] text-[#64748B] hover:text-white'
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
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          style={{
            cursor:
              draggedMarker || (hoveredMarker && typeof hoveredMarker === 'object' && (hoveredMarker.marker === 'X1' || hoveredMarker.marker === 'X2'))
                ? 'col-resize'
                : hoveredMarker === 'TRIG' || (hoveredMarker && typeof hoveredMarker === 'object' && (hoveredMarker.marker === 'Y1' || hoveredMarker.marker === 'Y2'))
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
            }}
            className={`absolute top-0 left-0 bg-[#0E131F]/90 border border-[#2D3A4E] backdrop-blur-md rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.7)] text-[10.5px] transition-shadow z-20 ${
              isDraggingHud ? 'shadow-[0_0_16px_rgba(0,229,255,0.4)] border-[#00E5FF]/70' : ''
            }`}
          >
            {/* Drag Handle & HUD Header */}
            <div
              onMouseDown={handleHudMouseDown}
              className="h-[26px] bg-[#141B29] border-b border-[#222D3D] px-2 flex items-center justify-between cursor-grab active:cursor-grabbing select-none rounded-t-lg gap-2"
            >
              <div className="flex items-center gap-1.5 text-[#94A3B8] font-semibold text-[10px]">
                <GripHorizontal className="w-3 h-3 text-[#64748B]" />
                <span className="tracking-wider uppercase text-[#CBD5E1]">
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
                  className="text-[#64748B] hover:text-[#E2E8F0] p-0.5 rounded transition-colors"
                >
                  {isHudCollapsed ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
                </button>
              </div>
            </div>

            {/* HUD Body */}
            {!isHudCollapsed ? (
              <div className="p-2.5 flex flex-col gap-1.5 min-w-[250px]">
                {/* Section 1: Time Cursors */}
                {(cursorMode === 'TIME' || cursorMode === 'BOTH') && (
                  <div className="space-y-1">
                    <div className="text-[9px] text-[#64748B] uppercase tracking-wider font-bold">
                      TIME CURSORS (X) · {cursorTargetChannel}
                    </div>
                    {deltaTUs !== null ? (
                      <>
                        <div className="flex items-center justify-between gap-3 text-[10px]">
                          <span className="text-[#94A3B8]">Δt (X2 - X1):</span>
                          <span className="text-[#00E5FF] font-bold">{deltaTUs.toLocaleString()} μs</span>
                        </div>
                        <div className="flex items-center justify-between gap-3 text-[10px]">
                          <span className="text-[#94A3B8]">1/Δt (Freq):</span>
                          <span className="text-[#FBBF24] font-bold">{freqHz} Hz</span>
                        </div>
                      </>
                    ) : (
                      <div className="text-[#64748B] text-[9.5px]">Drag X1/X2 markers on screen</div>
                    )}
                  </div>
                )}

                {/* Section 2: Voltage/Signal Cursors */}
                {(cursorMode === 'VOLT' || cursorMode === 'BOTH') && (
                  <div className="space-y-1 border-t border-[#222D3D] pt-1">
                    <div className="flex items-center justify-between text-[9px] text-[#64748B] uppercase tracking-wider font-bold">
                      <span>SIGNAL CURSORS (Y)</span>
                      <span className={cursorTargetChannel === 'CH1' ? 'text-[#FBBF24]' : cursorTargetChannel === 'CH2' ? 'text-[#00E5FF]' : 'text-[#D946EF]'}>
                        [{cursorTargetChannel}]
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 text-[10px]">
                      <span className="text-[#10B981]">
                        Y1: {cursorTargetChannel === 'CH1' ? `${(activeCursors.y1 / 1000).toFixed(2)} V` : cursorTargetChannel === 'CH2' ? `${activeCursors.y1.toFixed(2)} r/s` : activeCursors.y1.toFixed(2)}
                      </span>
                      <span className="text-[#A855F7]">
                        Y2: {cursorTargetChannel === 'CH1' ? `${(activeCursors.y2 / 1000).toFixed(2)} V` : cursorTargetChannel === 'CH2' ? `${activeCursors.y2.toFixed(2)} r/s` : activeCursors.y2.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 text-[10px]">
                      <span className="text-[#94A3B8]">ΔY (|Y2 - Y1|):</span>
                      <span className="text-[#10B981] font-bold">{deltaY}</span>
                    </div>
                    {slewRate && (
                      <div className="flex items-center justify-between gap-3 text-[10px]">
                        <span className="text-[#94A3B8]">Slew / Rate:</span>
                        <span className="text-[#E2E8F0]">{slewRate}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Section 3: Telemetry Channel Stats */}
                <div className="space-y-1 border-t border-[#222D3D] pt-1">
                  <div className="text-[9px] text-[#64748B] uppercase tracking-wider font-bold">
                    WAVEFORM METRICS
                  </div>
                  <div className="flex items-center justify-between gap-3 text-[9.5px]">
                    <span className="text-[#FBBF24]">CH1 Vpp:</span>
                    <span className="text-[#E2E8F0] font-semibold">{stats.pkPkV} mV</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-[9.5px]">
                    <span className="text-[#FBBF24]">CH1 Vmean:</span>
                    <span className="text-[#E2E8F0]">{stats.meanV} mV</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-[9.5px]">
                    <span className="text-[#00E5FF]">CH2 Gyro Pk-Pk:</span>
                    <span className="text-[#E2E8F0] font-semibold">{stats.gyroPkPk} rad/s</span>
                  </div>
                </div>

                {/* Section 4: Math Channel Output */}
                {mathVisible && (
                  <div className="space-y-1 border-t border-[#222D3D] pt-1">
                    <div className="text-[9px] text-[#D946EF] uppercase tracking-wider font-bold">
                      MATH: {mathOp}
                    </div>
                    {mathOp === 'FFT' ? (
                      <div className="flex items-center justify-between gap-3 text-[9.5px]">
                        <span className="text-[#64748B]">Dominant Peak:</span>
                        <span className="text-[#D946EF] font-bold">{stats.fftPeakFreq} Hz</span>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-3 text-[9.5px]">
                        <span className="text-[#64748B]">Scale:</span>
                        <span className="text-[#D946EF] font-bold">{mathScale}x Multiplier</span>
                      </div>
                    )}
                  </div>
                )}

                <div className="text-[8.5px] text-[#475569] pt-0.5 border-t border-[#1E293B]">
                  Drag card to reposition · Click & drag markers
                </div>
              </div>
            ) : (
              // Collapsed HUD pill view
              <div className="px-2 py-1 flex items-center gap-3 text-[10px]">
                {deltaTUs !== null && (
                  <span className="text-[#00E5FF] font-bold">Δt: {deltaTUs.toLocaleString()} μs</span>
                )}
                <span className="text-[#FBBF24]">Vpp: {stats.pkPkV} mV</span>
                <span className="text-[#00E5FF]">Gyro: {stats.gyroPkPk} r/s</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
