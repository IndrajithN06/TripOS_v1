/**
 * A tiny in-memory stand-in for the `Db` service, for DB-free unit tests of services that only use simple Prisma operations.
 *
 * Models just enough of a real database to make retry/duplicate tests meaningful:
 *  - filters: equality (incl. compound-unique objects like agencyId_phoneE164), `not`, `in`, `lt`, `startsWith`, `OR`/`AND`/`NOT`;
 *    like SQL/Prisma, `{ not: x }` does NOT match NULL;
 *  - writes: create/update/updateMany/upsert, `{ increment }`;
 *  - optional unique constraints (`unique`): a violating create throws `{ code: 'P2002' }` like Prisma;
 *  - transactions: `tenant()`/`system()` roll EVERYTHING back if the callback throws (a failed effect leaves no trace);
 *  - `serialize: true` runs transactions one after another, which models a unique index making a concurrent duplicate wait for the
 *    first transaction to commit or roll back. It is a model, not real isolation: RLS, real locking and migrations still need the
 *    e2e suite against a migrated database.
 *  - `failOnce('model.method', error)` makes the next such operation throw, to simulate a handler failing part-way.
 */
type Row = Record<string, any>;

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !(v instanceof Date);
const OPS = ['not', 'in', 'lt', 'startsWith'];

export function matches(row: Row, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as any[]).some((w) => matches(row, w));
    if (k === 'AND') return (v as any[]).every((w) => matches(row, w));
    if (k === 'NOT') return !matches(row, v);
    const cur = row[k];
    if (isObj(v)) {
      if ('not' in v) return v.not === null ? cur != null : cur != null && cur !== v.not;
      if ('in' in v) return (v.in as any[]).includes(cur);
      if ('lt' in v) return cur != null && cur < v.lt;
      if ('startsWith' in v) return typeof cur === 'string' && cur.startsWith(v.startsWith);
      if (cur === undefined && !Object.keys(v).some((x) => OPS.includes(x))) return matches(row, v); // compound unique, e.g. agencyId_phoneE164
      throw new Error(`fake-db: unsupported filter on ${k}: ${Object.keys(v).join(',')}`);
    }
    return (cur ?? null) === (v ?? null);
  });
}

function applyData(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (isObj(v) && 'increment' in v) row[k] = (row[k] ?? 0) + v.increment;
    else row[k] = v;
  }
}

export class FakeDb {
  /** Every operation in order, e.g. "whatsappAccount.updateMany". Kept even when a transaction rolls back. */
  ops: string[] = [];
  /** Rows actually changed by writes (an UPDATE that matches nothing changes nothing). Not rolled back. */
  rowsChanged = 0;
  private seq = 0;
  private lock: Promise<unknown> = Promise.resolve();
  private failures = new Map<string, Error>();
  tables: Record<string, Row[]>;
  readonly tx: any;

  constructor(tables: Record<string, Row[]> = {}, private readonly opts: { serialize?: boolean; unique?: Record<string, string[][]> } = {}) {
    this.tables = { whatsappAccount: [], whatsappSignupAttempt: [], auditLog: [], ...tables };
    const model = (name: string) => {
      const rows = () => this.tables[name] ?? (this.tables[name] = []);
      const enter = (m: string) => {
        this.ops.push(`${name}.${m}`);
        const f = this.failures.get(`${name}.${m}`);
        if (f) { this.failures.delete(`${name}.${m}`); throw f; }
      };
      const find = (where: any) => rows().find((r) => matches(r, where)) ?? null;
      return {
        findFirst: async ({ where }: any = {}) => { enter('findFirst'); return find(where); },
        findUnique: async ({ where }: any = {}) => { enter('findUnique'); return find(where); },
        findFirstOrThrow: async ({ where }: any = {}) => { enter('findFirstOrThrow'); const r = find(where); if (!r) throw new Error(`fake-db: ${name} not found`); return r; },
        findMany: async ({ where }: any = {}) => { enter('findMany'); return rows().filter((r) => matches(r, where)); },
        count: async ({ where }: any = {}) => { enter('count'); return rows().filter((r) => matches(r, where)).length; },
        create: async ({ data }: any) => {
          enter('create');
          for (const cols of this.opts.unique?.[name] ?? []) {
            if (rows().some((r) => cols.every((c) => (r[c] ?? null) === (data[c] ?? null)))) throw Object.assign(new Error(`Unique constraint failed on ${cols.join(',')}`), { code: 'P2002' });
          }
          const r = { id: `id-${++this.seq}`, ...data }; rows().push(r); this.rowsChanged++; return r;
        },
        update: async ({ where, data }: any) => { enter('update'); const r = find(where); if (!r) throw new Error(`fake-db: ${name} not found`); applyData(r, data); this.rowsChanged++; return r; },
        updateMany: async ({ where, data }: any) => { enter('updateMany'); const hit = rows().filter((r) => matches(r, where)); hit.forEach((r) => applyData(r, data)); this.rowsChanged += hit.length; return { count: hit.length }; },
        upsert: async ({ where, create, update }: any) => {
          enter('upsert'); const r = find(where);
          this.rowsChanged++;
          if (r) { applyData(r, update); return r; }
          const c = { id: `id-${++this.seq}`, ...create }; rows().push(c); return c;
        },
      };
    };
    this.tx = new Proxy({}, { get: (_t, name: string) => model(name) });
  }

  /** The next `model.method` call throws `err` once. */
  failOnce(op: string, err: Error = new Error(`fake-db: injected failure in ${op}`)) { this.failures.set(op, err); }

  private async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const run = async () => {
      const before = structuredClone(this.tables);
      try { return await fn(this.tx); } catch (e) { this.tables = before; throw e; } // all-or-nothing, like a database transaction
    };
    if (!this.opts.serialize) return run();
    const p = this.lock.then(run, run);
    this.lock = p.catch(() => undefined);
    return p;
  }
  async tenant<T>(_agencyId: string, fn: (tx: any) => Promise<T>): Promise<T> { return this.transaction(fn); }
  async system<T>(fn: (tx: any) => Promise<T>): Promise<T> { return this.transaction(fn); }

  /** A snapshot copy of a table, safe to compare before/after. */
  snapshot(name: string): Row[] { return (this.tables[name] ?? []).map((r) => ({ ...r })); }
}
