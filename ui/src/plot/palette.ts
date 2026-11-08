// Theme-aware canvas palette for Plot Forge. Same contract as the
// Oscilloscope's scopePalette: read --color-bf-* tokens via getComputedStyle
// once per frame so a theme switch repaints on the very next frame with zero
// re-wiring (and works unchanged inside popout windows).

export interface PlotPalette {
  canvas: string;
  gridMinor: string;
  grid: string;
  text: string;
  textDim: string;
  textFaint: string;
  line: string;
  cyan: string;
  amber: string;
  ok: string;
  fault: string;
  sky: string;
  math: string;
  cursor: string;
}

const FALLBACK: PlotPalette = {
  canvas: '#0A0D13',
  gridMinor: '#161F2E',
  grid: '#222D3D',
  text: '#E6EDF7',
  textDim: '#8B98AC',
  textFaint: '#5B6779',
  line: '#222D3D',
  cyan: '#00E5FF',
  amber: '#FBBF24',
  ok: '#10B981',
  fault: '#EF4444',
  sky: '#38BDF8',
  math: '#D946EF',
  cursor: '#FBBF24',
};

export const plotPalette = (): PlotPalette => {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  return {
    canvas: v('--color-bf-canvas', FALLBACK.canvas),
    gridMinor: v('--color-bf-line-soft', FALLBACK.gridMinor),
    grid: v('--color-bf-line', FALLBACK.grid),
    text: v('--color-bf-bright', FALLBACK.text),
    textDim: v('--color-bf-dim', FALLBACK.textDim),
    textFaint: v('--color-bf-faint', FALLBACK.textFaint),
    line: v('--color-bf-line', FALLBACK.line),
    cyan: v('--color-bf-cyan', FALLBACK.cyan),
    amber: v('--color-bf-amber', FALLBACK.amber),
    ok: v('--color-bf-ok', FALLBACK.ok),
    fault: v('--color-bf-fault', FALLBACK.fault),
    sky: v('--color-bf-sky', FALLBACK.sky),
    math: v('--color-bf-math', FALLBACK.math),
    cursor: v('--color-bf-amber', FALLBACK.cursor),
  };
};

/**
 * Channel color cycle — the same literal set the Oscilloscope uses for bound
 * field traces, kept literal (user data, not chrome) per the theme system's
 * convention so channels keep identity across themes.
 */
export const PLOT_COLORS = ['#A855F7', '#F97316', '#38BDF8', '#F472B6', '#84CC16', '#FACC15', '#2DD4BF', '#FB7185'];

export const nextPlotColor = (usedCount: number): string => PLOT_COLORS[usedCount % PLOT_COLORS.length];
