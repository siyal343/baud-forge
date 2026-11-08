// Safe expression evaluator verification: precedence, functions, refs, errors.
import { describe, it, expect } from 'vitest';
import { compileExpr, EXPR_FUNCS } from './expr';

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
});
