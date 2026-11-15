// Safe math expression evaluator for derived ("math") channels. A tiny
// recursive-descent parser — deliberately NOT eval/new Function, matching the
// repo's no-unsafe-dynamic-code posture. Identifiers resolve through a
// caller-supplied variable map (channel name → value), so unknown channels
// are a validation error, never a global lookup.

export class ExprError extends Error {}

const CONSTS: Record<string, number> = {
  PI: Math.PI,
  E: Math.E,
  TAU: Math.PI * 2,
};

export const EXPR_CONSTS = Object.keys(CONSTS);

const FUNCS: Record<string, (...args: number[]) => number> = {
  abs: Math.abs,
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  hypot: Math.hypot,
  deg: (radVal: number) => (radVal * 180) / Math.PI,
  rad: (degVal: number) => (degVal * Math.PI) / 180,
  clamp: (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x)),
  ln: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  exp: Math.exp,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
};

export const EXPR_FUNCS = Object.keys(FUNCS);

type Token =
  | { t: 'num'; v: number }
  | { t: 'ident'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lp' }
  | { t: 'rp' }
  | { t: 'comma' };

const tokenize = (src: string): Token[] => {
  const toks: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ExprError(`bad number at position ${i}`);
      toks.push({ t: 'num', v: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      toks.push({ t: 'ident', v: m[0] });
      i += m[0].length;
      continue;
    }
    if ('+-*/%^'.includes(c)) {
      toks.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (c === '(') {
      toks.push({ t: 'lp' });
      i++;
      continue;
    }
    if (c === ')') {
      toks.push({ t: 'rp' });
      i++;
      continue;
    }
    if (c === ',') {
      toks.push({ t: 'comma' });
      i++;
      continue;
    }
    throw new ExprError(`unexpected character '${c}' at position ${i}`);
  }
  return toks;
};

class Parser {
  private pos = 0;
  constructor(
    private readonly toks: Token[],
    private readonly refs: Set<string>
  ) {}

  private peek(): Token | undefined {
    return this.toks[this.pos];
  }

  private eat(): Token {
    const tok = this.toks[this.pos];
    if (!tok) throw new ExprError('unexpected end of expression');
    this.pos++;
    return tok;
  }

  parse(): (vars: Record<string, number>) => number {
    const fn = this.expr();
    if (this.pos < this.toks.length) throw new ExprError(`unexpected trailing input at token ${this.pos}`);
    return fn;
  }

  // expr := term (('+'|'-') term)*
  private expr(): (vars: Record<string, number>) => number {
    let left = this.term();
    for (;;) {
      const tok = this.peek();
      if (tok && tok.t === 'op' && (tok.v === '+' || tok.v === '-')) {
        this.eat();
        const right = this.term();
        const l = left;
        left = tok.v === '+' ? (v) => l(v) + right(v) : (v) => l(v) - right(v);
      } else return left;
    }
  }

  // term := unary (('*'|'/'|'%') unary)*
  private term(): (vars: Record<string, number>) => number {
    let left = this.unary();
    for (;;) {
      const tok = this.peek();
      if (tok && tok.t === 'op' && (tok.v === '*' || tok.v === '/' || tok.v === '%')) {
        this.eat();
        const right = this.unary();
        const l = left;
        left =
          tok.v === '*'
            ? (v) => l(v) * right(v)
            : tok.v === '/'
              ? (v) => l(v) / right(v)
              : (v) => l(v) % right(v);
      } else return left;
    }
  }

  // unary := ('-'|'+') unary | power
  private unary(): (vars: Record<string, number>) => number {
    const tok = this.peek();
    if (tok && tok.t === 'op' && (tok.v === '-' || tok.v === '+')) {
      this.eat();
      const operand = this.unary();
      return tok.v === '-' ? (v) => -operand(v) : operand;
    }
    return this.power();
  }

  // power := atom ('^' unary)?  — right-associative, binds tighter than unary minus
  private power(): (vars: Record<string, number>) => number {
    const base = this.atom();
    const tok = this.peek();
    if (tok && tok.t === 'op' && tok.v === '^') {
      this.eat();
      const exponent = this.unary();
      return (v) => Math.pow(base(v), exponent(v));
    }
    return base;
  }

  // atom := number | ident | ident '(' args ')' | '(' expr ')'
  private atom(): (vars: Record<string, number>) => number {
    const tok = this.eat();
    if (tok.t === 'num') {
      const n = tok.v;
      return () => n;
    }
    if (tok.t === 'lp') {
      const inner = this.expr();
      const close = this.eat();
      if (close.t !== 'rp') throw new ExprError('expected closing parenthesis');
      return inner;
    }
    if (tok.t === 'ident') {
      const name = tok.v;
      const next = this.peek();
      if (next && next.t === 'lp') {
        this.eat();
        const args: Array<(vars: Record<string, number>) => number> = [];
        const first = this.peek();
        if (first && first.t !== 'rp') {
          args.push(this.expr());
          for (;;) {
            const sep = this.peek();
            if (sep && sep.t === 'comma') {
              this.eat();
              args.push(this.expr());
            } else break;
          }
        }
        const close = this.eat();
        if (close.t !== 'rp') throw new ExprError(`expected ')' after ${name}(...)`);
        const fn = Object.prototype.hasOwnProperty.call(FUNCS, name) ? FUNCS[name] : undefined;
        if (!fn) throw new ExprError(`unknown function '${name}'`);
        if (args.length === 0) return () => fn();
        if (args.length === 1) {
          const a0 = args[0];
          return (v) => fn(a0(v));
        }
        if (args.length === 2) {
          const a0 = args[0];
          const a1 = args[1];
          return (v) => fn(a0(v), a1(v));
        }
        if (args.length === 3) {
          const a0 = args[0];
          const a1 = args[1];
          const a2 = args[2];
          return (v) => fn(a0(v), a1(v), a2(v));
        }
        const scratch = new Array<number>(args.length);
        return (v) => {
          for (let i = 0; i < args.length; i++) scratch[i] = args[i](v);
          return fn(...scratch);
        };
      }
      if (Object.prototype.hasOwnProperty.call(CONSTS, name)) {
        const c = CONSTS[name];
        return () => c;
      }
      this.refs.add(name);
      return (v) => {
        const val = v[name];
        if (typeof val !== 'number' || !Number.isFinite(val)) return NaN;
        return val;
      };
    }
    throw new ExprError(`unexpected token '${JSON.stringify(tok)}'`);
  }
}

export interface CompiledExpr {
  ok: true;
  /** Evaluate against a variable map; returns NaN for missing/invalid vars. */
  fn: (vars: Record<string, number>) => number;
  /** Channel identifiers referenced by the expression (dedup, in source order). */
  refs: string[];
}

/**
 * Parse `src` into a closure. Returns `{ ok: false, error }` instead of
 * throwing so the channel-creation UI can show inline validation.
 */
export function compileExpr(src: string): CompiledExpr | { ok: false; error: string } {
  const refs = new Set<string>();
  try {
    const trimmed = src.trim();
    if (!trimmed) throw new ExprError('empty expression');
    const fn = new Parser(tokenize(trimmed), refs).parse();
    return { ok: true, fn, refs: [...refs] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
