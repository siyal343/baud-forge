// Safe expression evaluator verification: precedence, functions, refs, errors.
import { describe, it, expect } from 'vitest';
import { compileExpr, EXPR_FUNCS, EXPR_CONSTS } from './expr';

const evalOk = (src: string, vars: Record<string, number> = {}): number => {
  const res = compileExpr(src);
  if (!res.ok) throw new Error(`expected ${src} to compile: ${res.error}`);
  return res.fn(vars);
};

describe('compileExpr', () => {
  it('evaluates arithmetic with standard precedence', () => {
    expect(evalOk('2 + 3 * 4')).toBe(14);
    expect(evalOk('(2 + 3) * 4')).toBe(20);
    expect(evalOk('7 % 3')).toBe(1);
    expect(evalOk('10 / 4')).toBe(2.5);
    expect(evalOk('1 - 2 - 3')).toBe(-4); // left-assoc
  });

  it('binds unary minus and ^ correctly (right-assoc power)', () => {
    expect(evalOk('-2^2')).toBe(-4); // power binds tighter than unary minus
    expect(evalOk('2^3^2')).toBe(512); // right-assoc: 2^(3^2)
    expect(evalOk('2^-3')).toBe(0.125);
    expect(evalOk('--3')).toBe(3);
  });

  it('parses number formats', () => {
    expect(evalOk('.5')).toBe(0.5);
    expect(evalOk('1e3')).toBe(1000);
    expect(evalOk('2.5e-1')).toBe(0.25);
  });

  it('calls the built-in functions', () => {
    expect(evalOk('abs(0 - 5)')).toBe(5);
    expect(evalOk('min(3, 1, 2)')).toBe(1);
    expect(evalOk('max(3, 1, 2)')).toBe(3);
    expect(evalOk('sqrt(9)')).toBe(3);
    expect(evalOk('round(2.6)')).toBe(3);
    expect(evalOk('sign(0 - 2)')).toBe(-1);
    expect(EXPR_FUNCS).toContain('log10');
  });

  it('resolves variables and collects refs (dedup)', () => {
    const res = compileExpr('a + b * a - sqrt(c)');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.refs).toEqual(['a', 'b', 'c']);
      expect(res.fn({ a: 2, b: 3, c: 9 })).toBe(2 + 3 * 2 - 3);
    }
  });

  it('returns NaN for missing or non-finite variables without throwing', () => {
    expect(evalOk('a + 1', {})).toBeNaN();
    expect(evalOk('a + 1', { a: NaN })).toBeNaN();
  });

  it('uses JS division semantics (÷0 → Infinity)', () => {
    expect(evalOk('1 / 0')).toBe(Infinity);
  });

  it('reports helpful errors instead of throwing', () => {
    expect(compileExpr('')).toEqual({ ok: false, error: 'empty expression' });
    expect(compileExpr('1 +').ok).toBe(false);
    expect(compileExpr('1 2').ok).toBe(false);
    expect(compileExpr('foo(1)').ok).toBe(false); // unknown function
    expect(compileExpr('(1 + 2').ok).toBe(false);
    expect(compileExpr('1 @ 2').ok).toBe(false);
    expect(compileExpr('abs(1,').ok).toBe(false);
  });

  it('never reaches globals: identifiers resolve only via the vars map', () => {
    // `Math` or `globalThis` must not be reachable as identifiers.
    const res = compileExpr('Math');
    expect(res.ok).toBe(true); // parses as a variable reference
    if (res.ok) expect(res.fn({})).toBeNaN(); // but resolves to NaN, not the object
  });

  it('supports built-in constants PI, E, TAU without adding them to refs', () => {
    const res = compileExpr('sin(PI / 2) + ln(E) + TAU / PI + x');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.refs).toEqual(['x']);
      expect(res.fn({ x: 1 })).toBeCloseTo(1 + 1 + 2 + 1, 12);
    }
    expect(EXPR_CONSTS).toEqual(['PI', 'E', 'TAU']);
  });

  it('supports atan2, hypot, deg, rad, and clamp', () => {
    expect(evalOk('atan2(1, 1)')).toBeCloseTo(Math.PI / 4, 12);
    expect(evalOk('hypot(3, 4)')).toBeCloseTo(5, 12);
    expect(evalOk('deg(PI)')).toBeCloseTo(180, 12);
    expect(evalOk('rad(180)')).toBeCloseTo(Math.PI, 12);
    expect(evalOk('deg(rad(42))')).toBeCloseTo(42, 12);
    expect(evalOk('clamp(-5, 0, 10)')).toBe(0);
    expect(evalOk('clamp(5, 0, 10)')).toBe(5);
    expect(evalOk('clamp(25, 0, 10)')).toBe(10);
    expect(evalOk('min(4, 3, 2, 1)')).toBe(1);
    expect(EXPR_FUNCS).toEqual(expect.arrayContaining(['atan2', 'hypot', 'deg', 'rad', 'clamp']));
  });
});
