/**
 * BaudForge Pure Pratt Recursive-Descent Expression Parser & Evaluator
 * Zero external dependencies. Zero eval() or new Function(). Safe for real-time telemetry.
 */

export type TokenType =
  | 'NUMBER'
  | 'STRING'
  | 'BOOLEAN'
  | 'NULL'
  | 'IDENT'
  | 'DOT'
  | 'COMMA'
  | 'LPAREN'
  | 'RPAREN'
  | 'OP'
  | 'EOF'

export interface Token {
  type: TokenType
  value: any
  pos: number
}

// Tokenizer
export class Lexer {
  private pos = 0
  private input: string
  constructor(input: string) {
    this.input = input
  }

  nextToken(): Token {
    while (this.pos < this.input.length && /\s/.test(this.input[this.pos])) {
      this.pos++
    }

    if (this.pos >= this.input.length) {
      return { type: 'EOF', value: null, pos: this.pos }
    }

    const startPos = this.pos
    const char = this.input[this.pos]

    // Numbers (decimal, float, hex 0x, binary 0b)
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(this.input[this.pos + 1] || ''))) {
      if (char === '0' && (this.input[this.pos + 1] === 'x' || this.input[this.pos + 1] === 'X')) {
        this.pos += 2
        const hexStart = this.pos
        while (this.pos < this.input.length && /[0-9a-fA-F]/.test(this.input[this.pos])) {
          this.pos++
        }
        const hexStr = this.input.slice(hexStart, this.pos)
        return { type: 'NUMBER', value: parseInt(hexStr, 16) || 0, pos: startPos }
      }

      if (char === '0' && (this.input[this.pos + 1] === 'b' || this.input[this.pos + 1] === 'B')) {
        this.pos += 2
        const binStart = this.pos
        while (this.pos < this.input.length && /[01]/.test(this.input[this.pos])) {
          this.pos++
        }
        const binStr = this.input.slice(binStart, this.pos)
        return { type: 'NUMBER', value: parseInt(binStr, 2) || 0, pos: startPos }
      }

      let hasDot = false
      while (this.pos < this.input.length) {
        const c = this.input[this.pos]
        if (c === '.') {
          if (hasDot) break
          hasDot = true
          this.pos++
        } else if (/[0-9]/.test(c)) {
          this.pos++
        } else {
          break
        }
      }
      const numStr = this.input.slice(startPos, this.pos)
      return { type: 'NUMBER', value: parseFloat(numStr), pos: startPos }
    }

    // Strings ('...' or "...")
    if (char === "'" || char === '"') {
      const quote = char
      this.pos++
      let str = ''
      while (this.pos < this.input.length) {
        const c = this.input[this.pos]
        if (c === '\\') {
          this.pos++
          const esc = this.input[this.pos]
          if (esc === 'n') str += '\n'
          else if (esc === 't') str += '\t'
          else if (esc === 'r') str += '\r'
          else str += esc
          this.pos++
        } else if (c === quote) {
          this.pos++
          return { type: 'STRING', value: str, pos: startPos }
        } else {
          str += c
          this.pos++
        }
      }
      throw new Error(`Unterminated string starting at index ${startPos}`)
    }

    // Identifiers & Keywords
    if (/[a-zA-Z_$]/.test(char)) {
      while (this.pos < this.input.length && /[a-zA-Z0-9_$]/.test(this.input[this.pos])) {
        this.pos++
      }
      const ident = this.input.slice(startPos, this.pos)
      if (ident === 'true') return { type: 'BOOLEAN', value: true, pos: startPos }
      if (ident === 'false') return { type: 'BOOLEAN', value: false, pos: startPos }
      if (ident === 'null') return { type: 'NULL', value: null, pos: startPos }
      return { type: 'IDENT', value: ident, pos: startPos }
    }

    // Punctuation
    if (char === '.') {
      this.pos++
      return { type: 'DOT', value: '.', pos: startPos }
    }
    if (char === ',') {
      this.pos++
      return { type: 'COMMA', value: ',', pos: startPos }
    }
    if (char === '(') {
      this.pos++
      return { type: 'LPAREN', value: '(', pos: startPos }
    }
    if (char === ')') {
      this.pos++
      return { type: 'RPAREN', value: ')', pos: startPos }
    }

    // Two-character operators
    const twoChars = this.input.slice(this.pos, this.pos + 2)
    if (['==', '!=', '<=', '>=', '&&', '||', '<<', '>>'].includes(twoChars)) {
      this.pos += 2
      return { type: 'OP', value: twoChars, pos: startPos }
    }

    // Single-character operators
    if (['+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '<', '>'].includes(char)) {
      this.pos++
      return { type: 'OP', value: char, pos: startPos }
    }

    throw new Error(`Unexpected character '${char}' at index ${this.pos}`)
  }
}

// AST Nodes
export type ASTNode =
  | { type: 'literal'; value: any }
  | { type: 'ident'; name: string }
  | { type: 'member'; object: ASTNode; property: string }
  | { type: 'call'; callee: string; args: ASTNode[] }
  | { type: 'unary'; op: string; expr: ASTNode }
  | { type: 'binary'; op: string; left: ASTNode; right: ASTNode }

// Precedence Table (higher number binds tighter)
const PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6,
  '!=': 6,
  '<': 7,
  '<=': 7,
  '>': 7,
  '>=': 7,
  '<<': 8,
  '>>': 8,
  '+': 9,
  '-': 9,
  '*': 10,
  '/': 10,
  '%': 10,
}

export class Parser {
  private current: Token
  private lexer: Lexer
  constructor(lexer: Lexer) {
    this.lexer = lexer
    this.current = this.lexer.nextToken()
  }

  private peek(): Token {
    return this.current
  }

  private consume(): Token {
    const prev = this.current
    this.current = this.lexer.nextToken()
    return prev
  }

  private expect(type: TokenType, value?: any): Token {
    const token = this.peek()
    if (token.type !== type || (value !== undefined && token.value !== value)) {
      throw new Error(
        `Expected ${type}${value !== undefined ? ` ('${value}')` : ''} but got ${token.type} ('${token.value}') at index ${token.pos}`,
      )
    }
    return this.consume()
  }

  parse(): ASTNode {
    const node = this.parseExpression(0)
    if (this.peek().type !== 'EOF') {
      throw new Error(`Unexpected trailing token '${this.peek().value}' at index ${this.peek().pos}`)
    }
    return node
  }

  private parseExpression(rbp: number): ASTNode {
    let left = this.parsePrefix()

    while (true) {
      const token = this.peek()

      // Member access `.`
      if (token.type === 'DOT') {
        this.consume()
        const propToken = this.expect('IDENT')
        left = { type: 'member', object: left, property: propToken.value }
        continue
      }

      // Function call `(`
      if (token.type === 'LPAREN' && left.type === 'ident') {
        this.consume()
        const args: ASTNode[] = []
        if (this.peek().type !== 'RPAREN') {
          while (true) {
            args.push(this.parseExpression(0))
            if (this.peek().type === 'COMMA') {
              this.consume()
            } else {
              break
            }
          }
        }
        this.expect('RPAREN')
        left = { type: 'call', callee: left.name, args }
        continue
      }

      // Binary operators
      if (token.type === 'OP') {
        const op = token.value as string
        const lbp = PRECEDENCE[op] || 0
        if (lbp <= rbp) {
          break
        }
        this.consume()
        const right = this.parseExpression(lbp)
        left = { type: 'binary', op, left, right }
        continue
      }

      break
    }

    return left
  }

  private parsePrefix(): ASTNode {
    const token = this.peek()

    if (token.type === 'NUMBER' || token.type === 'STRING' || token.type === 'BOOLEAN' || token.type === 'NULL') {
      this.consume()
      return { type: 'literal', value: token.value }
    }

    if (token.type === 'IDENT') {
      this.consume()
      return { type: 'ident', name: token.value }
    }

    if (token.type === 'LPAREN') {
      this.consume()
      const expr = this.parseExpression(0)
      this.expect('RPAREN')
      return expr
    }

    if (token.type === 'OP' && ['-', '!', '~', '+'].includes(token.value)) {
      this.consume()
      const op = token.value
      const expr = this.parseExpression(11) // High precedence for unary
      if (op === '+') return expr // Unary plus is a no-op
      return { type: 'unary', op, expr }
    }

    throw new Error(`Unexpected token '${token.value}' at index ${token.pos}`)
  }
}

// Built-in Pure Math Functions
const BUILTINS: Record<string, (...args: any[]) => any> = {
  min: (...args: number[]) => (args.length === 0 ? 0 : Math.min(...args)),
  max: (...args: number[]) => (args.length === 0 ? 0 : Math.max(...args)),
  abs: (x: number) => Math.abs(x ?? 0),
  clamp: (val: number, min: number, max: number) => {
    const v = Number(val) || 0
    const lo = Number(min) || 0
    const hi = Number(max) || 0
    return Math.min(Math.max(v, lo), hi)
  },
  round: (x: number, n: number = 0) => {
    const factor = Math.pow(10, n || 0)
    return Math.round((Number(x) || 0) * factor) / factor
  },
  sqrt: (x: number) => Math.sqrt(Math.max(0, Number(x) || 0)),
  floor: (x: number) => Math.floor(Number(x) || 0),
  ceil: (x: number) => Math.ceil(Number(x) || 0),
}

// Evaluator
export function evaluateAST(node: ASTNode, context: Record<string, any>): any {
  switch (node.type) {
    case 'literal':
      return node.value

    case 'ident': {
      if (context == null) return undefined
      if (node.name in context) return context[node.name]
      // Fallback search in standard BaudForge telemetry buckets: fields, rx, stats
      if (context.fields && typeof context.fields === 'object' && node.name in context.fields) {
        return context.fields[node.name]
      }
      if (context.rx && typeof context.rx === 'object' && node.name in context.rx) {
        return context.rx[node.name]
      }
      if (context.stats && typeof context.stats === 'object' && node.name in context.stats) {
        return context.stats[node.name]
      }
      return undefined
    }

    case 'member': {
      const obj = evaluateAST(node.object, context)
      if (obj == null) return undefined
      return obj[node.property]
    }

    case 'call': {
      const fn = BUILTINS[node.callee]
      if (!fn) {
        throw new Error(`Unknown dashboard function: '${node.callee}'`)
      }
      const evaluatedArgs = node.args.map((arg) => evaluateAST(arg, context))
      return fn(...evaluatedArgs)
    }

    case 'unary': {
      const val = evaluateAST(node.expr, context)
      if (node.op === '-') return -(val ?? 0)
      if (node.op === '!') return !val
      if (node.op === '~') return ~(val ?? 0)
      throw new Error(`Unsupported unary operator: '${node.op}'`)
    }

    case 'binary': {
      // Short-circuit logical operators
      if (node.op === '&&') {
        const leftVal = evaluateAST(node.left, context)
        return leftVal ? evaluateAST(node.right, context) : leftVal
      }
      if (node.op === '||') {
        const leftVal = evaluateAST(node.left, context)
        return leftVal ? leftVal : evaluateAST(node.right, context)
      }

      const left = evaluateAST(node.left, context)
      const right = evaluateAST(node.right, context)

      switch (node.op) {
        case '+':
          return (left ?? 0) + (right ?? 0)
        case '-':
          return (left ?? 0) - (right ?? 0)
        case '*':
          return (left ?? 0) * (right ?? 0)
        case '/':
          return right === 0 ? 0 : (left ?? 0) / right
        case '%':
          return right === 0 ? 0 : (left ?? 0) % right
        case '&':
          return (left ?? 0) & (right ?? 0)
        case '|':
          return (left ?? 0) | (right ?? 0)
        case '^':
          return (left ?? 0) ^ (right ?? 0)
        case '<<':
          return (left ?? 0) << (right ?? 0)
        case '>>':
          return (left ?? 0) >> (right ?? 0)
        case '==':
          return left == right
        case '!=':
          return left != right
        case '<':
          return (left ?? 0) < (right ?? 0)
        case '<=':
          return (left ?? 0) <= (right ?? 0)
        case '>':
          return (left ?? 0) > (right ?? 0)
        case '>=':
          return (left ?? 0) >= (right ?? 0)
        default:
          throw new Error(`Unsupported binary operator: '${node.op}'`)
      }
    }
  }
}

const compileCache = new Map<string, ASTNode>()

export function compileExpr(expr: string): (ctx: Record<string, any>) => any {
  const trimmed = expr.trim()
  if (!trimmed) {
    return () => undefined
  }

  let ast = compileCache.get(trimmed)
  if (!ast) {
    const lexer = new Lexer(trimmed)
    const parser = new Parser(lexer)
    ast = parser.parse()
    if (compileCache.size < 1000) {
      compileCache.set(trimmed, ast)
    }
  }

  return (ctx: Record<string, any>) => evaluateAST(ast!, ctx)
}

export function evaluateExpr(expr: string, context: Record<string, any>): any {
  return compileExpr(expr)(context)
}

/**
 * Built-in Self Check Assertion Suite
 */
export function runExprSelfCheck(): { passed: number; failed: number } {
  let passed = 0
  let failed = 0

  function assert(name: string, condition: boolean) {
    if (condition) {
      passed++
    } else {
      failed++
      console.error(`[Expr SelfCheck FAIL] ${name}`)
    }
  }

  const ctx = {
    rx: { voltage: 12.6, current: 4.5 },
    fields: { rpm: 3200, temp: 45.2 },
    stats: { overruns: 2 },
    flags: 0b10110,
    active: true,
  }

  // Arithmetic & precedence
  assert('1 + 2 * 3 == 7', evaluateExpr('1 + 2 * 3', ctx) === 7)
  assert('(1 + 2) * 3 == 9', evaluateExpr('(1 + 2) * 3', ctx) === 9)
  assert('Hex literal', evaluateExpr('0x10 + 5', ctx) === 21)
  assert('Binary literal', evaluateExpr('0b101 + 1', ctx) === 6)
  assert('Float math', evaluateExpr('10.5 / 2', ctx) === 5.25)
  assert('Modulo', evaluateExpr('17 % 5', ctx) === 2)

  // Bitwise
  assert('Bitwise AND', evaluateExpr('0x0F & 0x07', ctx) === 7)
  assert('Bitwise OR & Shift', evaluateExpr('(0x01 << 4) | 0x02', ctx) === 18)
  assert('Bitwise XOR', evaluateExpr('(8 >> 1) ^ 1', ctx) === 5)
  assert('Bitwise NOT', evaluateExpr('~0', ctx) === -1)

  // Unary
  assert('Unary minus', evaluateExpr('-5 + 10', ctx) === 5)
  assert('Unary not', evaluateExpr('!active', ctx) === false)

  // Logical & Comparisons
  assert('Logical AND', evaluateExpr('true && false', ctx) === false)
  assert('Logical OR', evaluateExpr('true || false', ctx) === true)
  assert('Comparisons < and >', evaluateExpr('10 > 5 && 3 < 4', ctx) === true)
  assert('Equality', evaluateExpr('10 == 10 && 5 != 6', ctx) === true)

  // Identifiers & Context Lookups
  assert('Member access rx.voltage', evaluateExpr('rx.voltage', ctx) === 12.6)
  assert('Member access fields.rpm', evaluateExpr('fields.rpm', ctx) === 3200)
  assert('Fallback lookup temp', evaluateExpr('temp', ctx) === 45.2)
  assert('Fallback lookup overruns', evaluateExpr('overruns', ctx) === 2)
  assert('Calculated power', evaluateExpr('rx.voltage * rx.current', ctx) === 12.6 * 4.5)

  // Math functions
  assert('min(a, b)', evaluateExpr('min(10, 20)', ctx) === 10)
  assert('max(a, b)', evaluateExpr('max(10, 20)', ctx) === 20)
  assert('abs(-42)', evaluateExpr('abs(-42)', ctx) === 42)
  assert('clamp within', evaluateExpr('clamp(50, 0, 100)', ctx) === 50)
  assert('clamp above', evaluateExpr('clamp(150, 0, 100)', ctx) === 100)
  assert('clamp below', evaluateExpr('clamp(-10, 0, 100)', ctx) === 0)
  assert('round', evaluateExpr('round(3.14159, 2)', ctx) === 3.14)

  return { passed, failed }
}
