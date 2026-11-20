import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 一次办理可以覆盖单只箱，也可以覆盖一票换箱/拆箱后的多只箱。存储里用
 * 规范化后的范围文本作键，保证同一组箱重复办理时读到同一批收据。
 */
function scopeOf(scope) {
  if (typeof scope === 'string') return scope;
  if (Array.isArray(scope) || scope instanceof Set) return [...scope].map(String).sort().join(',');
  if (scope && typeof scope[Symbol.iterator] === 'function') return [...scope].map(String).sort().join(',');
  return String(scope);
}

export class Archive {
  constructor(directory) { this.directory = directory; }

  async start() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    this.database = new DatabaseSync(join(this.directory, 'receipts.sqlite'));
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
    this.database.exec(`CREATE TABLE IF NOT EXISTS evidence (
      digest TEXT PRIMARY KEY, location TEXT NOT NULL, observed_at TEXT NOT NULL, size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (
      scope TEXT NOT NULL, business_key TEXT NOT NULL, digest TEXT NOT NULL, record TEXT NOT NULL,
      decision TEXT NOT NULL, PRIMARY KEY(scope,business_key,digest));`);
    return this;
  }

  async preserve(document) {
    const digest = createHash('sha256').update(document.bytes).digest('hex');
    const destination = join(this.directory, 'objects', digest);
    const temporary = destination + '.' + process.pid + '.' + crypto.randomUUID();
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(document.bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, destination);
    this.database.prepare('INSERT OR IGNORE INTO evidence VALUES(?,?,?,?)')
      .run(digest, document.location, document.observedAt, document.bytes.length);
    return digest;
  }

  /**
   * 写入收据。同一份原文的领域结论会随后续观察更新；不同内容的原文仍是
   * 独立原件。是否互斥由调用方依据箱、装箱与核准依据判断。
   */
  put(scope, key, digest, record, decision) {
    if (!this.database.prepare('SELECT digest FROM evidence WHERE digest=?').get(digest)) throw new Error('原文尚未保存');
    this.database.prepare(`INSERT INTO receipts VALUES(?,?,?,?,?)
      ON CONFLICT(scope,business_key,digest) DO UPDATE SET decision=excluded.decision`)
      .run(scopeOf(scope), key, digest, JSON.stringify(record), JSON.stringify(decision));
  }

  records(scope) {
    return this.database.prepare('SELECT * FROM receipts WHERE scope=? ORDER BY business_key,digest').all(scopeOf(scope))
      .map(row => ({ ...row, record: JSON.parse(row.record), decision: JSON.parse(row.decision) }));
  }

  /** 把某个业务身份下仍为 accepted 的收据改记为被替代，原件和原文都保留。 */
  supersede(scope, key, decision) {
    const rows = this.database.prepare('SELECT digest,decision FROM receipts WHERE scope=? AND business_key=?').all(scopeOf(scope), key);
    let changed = 0;
    for (const row of rows) {
      if (JSON.parse(row.decision).status !== 'accepted') continue;
      this.database.prepare('UPDATE receipts SET decision=? WHERE scope=? AND business_key=? AND digest=?')
        .run(JSON.stringify(decision), scopeOf(scope), key, row.digest);
      changed += 1;
    }
    return changed;
  }

  /**
   * 同一箱只能保留一份有效申报。新申报得到受理后，旧箱/旧封志/旧装箱的有效
   * 结论改为被替代，避免互相排斥的 accepted 同时存在。
   */
  supersedeContainer(scope, container, keepKey, decision) {
    const rows = this.database.prepare('SELECT business_key,digest,record,decision FROM receipts WHERE scope=?').all(scopeOf(scope));
    let changed = 0;
    for (const row of rows) {
      const record = JSON.parse(row.record);
      if (record.container !== container) continue;
      if (row.business_key === keepKey) continue;
      if (JSON.parse(row.decision).status !== 'accepted') continue;
      this.database.prepare('UPDATE receipts SET decision=? WHERE scope=? AND business_key=? AND digest=?')
        .run(JSON.stringify(decision), scopeOf(scope), row.business_key, row.digest);
      changed += 1;
    }
    return changed;
  }

  async original(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('原文摘要无效');
    const content = await readFile(join(this.directory, 'objects', digest));
    if (createHash('sha256').update(content).digest('hex') !== digest) throw new Error('原文完整性校验失败');
    return content;
  }

  /** 按业务身份取得仍为有效的收据，供复查操作依据与远端结果。 */
  receipt(scope, key) {
    return this.database.prepare('SELECT * FROM receipts WHERE scope=? AND business_key=? ORDER BY digest')
      .all(scopeOf(scope), key)
      .map(row => ({ ...row, record: JSON.parse(row.record), decision: JSON.parse(row.decision) }));
  }

  close() { this.database?.close(); }
}

