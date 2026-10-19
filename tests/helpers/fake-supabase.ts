/* Minimal in-memory stand-in for the parts of supabase-js (PostgREST) used by the API routes. */
/* eslint-disable @typescript-eslint/no-explicit-any */

export type Row = Record<string, any>

const asTime = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : v)

function compare(a: unknown, b: unknown): number {
  const x = asTime(a)
  const y = asTime(b)
  if (typeof x === 'number' && typeof y === 'number') return x - y
  return String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0
}

function splitTopLevel(columns: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of columns) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
    } else current += ch
  }
  if (current.trim()) out.push(current.trim())
  return out
}

export class FakeDb {
  tables: Record<string, Row[]> = {}
  failures: Record<string, string> = {}
  private ids: Record<string, number> = {}
  log: string[] = []

  nextId(table: string) {
    this.ids[table] = (this.ids[table] ?? 0) + 1
    return this.ids[table]
  }

  seed(table: string, rows: Row[]) {
    this.tables[table] ??= []
    for (const row of rows) {
      const withId = { ...row }
      if (withId.id === undefined) withId.id = this.nextId(table)
      else this.ids[table] = Math.max(this.ids[table] ?? 0, Number(withId.id))
      this.tables[table].push(withId)
    }
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= [])
  }

  from(table: string) {
    return new Builder(this, table)
  }

  client() {
    return { from: (table: string) => this.from(table) }
  }
}

class Builder implements PromiseLike<{ data: any; error: { message: string } | null }> {
  private filters: ((row: Row) => boolean)[] = []
  private orders: { col: string; asc: boolean }[] = []
  private rangeFrom?: number
  private rangeTo?: number
  private limitN?: number
  private mode: 'select' | 'upsert' | 'insert' | 'delete' = 'select'
  private payload: any
  private opts: any
  private columns = '*'
  private returning = false
  private expect: 'many' | 'single' | 'maybeSingle' = 'many'

  constructor(private db: FakeDb, private table: string) {}

  select(columns = '*') {
    this.columns = columns
    if (this.mode !== 'select') this.returning = true
    return this
  }
  upsert(payload: any, opts: any = {}) {
    this.mode = 'upsert'
    this.payload = payload
    this.opts = opts
    return this
  }
  insert(payload: any) {
    this.mode = 'insert'
    this.payload = payload
    return this
  }
  delete() {
    this.mode = 'delete'
    return this
  }
  eq(col: string, value: unknown) {
    this.filters.push(row => compare(row[col], value) === 0)
    return this
  }
  lte(col: string, value: unknown) {
    this.filters.push(row => compare(row[col], value) <= 0)
    return this
  }
  gte(col: string, value: unknown) {
    this.filters.push(row => compare(row[col], value) >= 0)
    return this
  }
  gt(col: string, value: unknown) {
    this.filters.push(row => compare(row[col], value) > 0)
    return this
  }
  order(col: string, opts: { ascending?: boolean } = {}) {
    this.orders.push({ col, asc: opts.ascending !== false })
    return this
  }
  range(from: number, to: number) {
    this.rangeFrom = from
    this.rangeTo = to
    return this
  }
  limit(n: number) {
    this.limitN = n
    return this
  }
  single() {
    this.expect = 'single'
    return this
  }
  maybeSingle() {
    this.expect = 'maybeSingle'
    return this
  }

  then<T1 = any, T2 = never>(
    resolve?: ((value: { data: any; error: { message: string } | null }) => T1 | PromiseLike<T1>) | null,
    reject?: ((reason: any) => T2 | PromiseLike<T2>) | null,
  ) {
    return Promise.resolve().then(() => this.run()).then(resolve, reject)
  }

  private project(row: Row): Row {
    if (this.columns.trim() === '*') return { ...row }
    const out: Row = {}
    for (const part of splitTopLevel(this.columns)) {
      const embed = part.match(/^(\w+)\((.*)\)$/)
      if (embed) {
        const [, child, childCols] = embed
        const wanted = childCols.split(',').map(c => c.trim())
        out[child] = this.db.rows(child)
          .filter(c => c.signal_id === row.id)
          .map(c => Object.fromEntries(wanted.map(w => [w, c[w]])))
      } else out[part] = row[part]
    }
    return out
  }

  private finish(rows: Row[]) {
    if (this.expect === 'many') return { data: rows, error: null }
    if (this.expect === 'maybeSingle') return { data: rows[0] ?? null, error: null }
    return rows.length === 1
      ? { data: rows[0], error: null }
      : { data: null, error: { message: `expected a single row, got ${rows.length}` } }
  }

  private run(): { data: any; error: { message: string } | null } {
    const failure = this.db.failures[`${this.table}:${this.mode}`]
    if (failure) return { data: null, error: { message: failure } }
    this.db.log.push(`${this.mode} ${this.table}`)
    const rows = this.db.rows(this.table)

    if (this.mode === 'insert') {
      const created = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((r: Row) => ({ id: this.db.nextId(this.table), ...r }))
      rows.push(...created)
      return this.returning ? this.finish(created.map(r => this.project(r))) : { data: null, error: null }
    }

    if (this.mode === 'upsert') {
      const keys = String(this.opts.onConflict ?? 'id').split(',').map((k: string) => k.trim())
      const touched: Row[] = []
      for (const incoming of Array.isArray(this.payload) ? this.payload : [this.payload]) {
        const existing = rows.find(r => keys.every(k => compare(r[k], incoming[k]) === 0))
        if (existing) {
          if (!this.opts.ignoreDuplicates) {
            Object.assign(existing, incoming)
            touched.push(existing)
          }
        } else {
          const created = { id: this.db.nextId(this.table), ...incoming }
          rows.push(created)
          touched.push(created)
        }
      }
      return this.returning ? this.finish(touched.map(r => this.project(r))) : { data: null, error: null }
    }

    if (this.mode === 'delete') {
      const doomed = rows.filter(r => this.filters.every(f => f(r)))
      this.db.tables[this.table] = rows.filter(r => !doomed.includes(r))
      if (this.table === 'news_briefings') {
        const ids = new Set(doomed.map(r => r.id))
        this.db.tables.news_items = this.db.rows('news_items').filter(i => !ids.has(i.briefing_id))
      }
      return { data: null, error: null }
    }

    let found = rows.filter(r => this.filters.every(f => f(r)))
    for (const { col, asc } of [...this.orders].reverse()) {
      found = [...found].sort((a, b) => (asc ? 1 : -1) * compare(a[col], b[col]))
    }
    if (this.rangeFrom !== undefined) found = found.slice(this.rangeFrom, (this.rangeTo ?? found.length) + 1)
    if (this.limitN !== undefined) found = found.slice(0, this.limitN)
    return this.finish(found.map(r => this.project(r)))
  }
}
