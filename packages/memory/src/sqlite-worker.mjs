import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

const db = new DatabaseSync(workerData.path);
db.exec(
  'PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;',
);
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, goal_id TEXT, seq INTEGER NOT NULL, at REAL NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, UNIQUE(session_id, seq));
  CREATE INDEX IF NOT EXISTS events_session_goal_seq ON events(session_id, goal_id, seq);
  CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, content_json TEXT NOT NULL, updated_at REAL NOT NULL);
  CREATE INDEX IF NOT EXISTS goals_session_updated ON goals(session_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, status TEXT NOT NULL, content_json TEXT NOT NULL, updated_at REAL NOT NULL);
  CREATE INDEX IF NOT EXISTS tasks_goal_updated ON tasks(goal_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, goal_id TEXT, entity_id TEXT, dimension TEXT, x REAL, y REAL, z REAL, text TEXT NOT NULL, source TEXT NOT NULL, observed_at REAL NOT NULL, expires_at REAL, confidence REAL, confirmed INTEGER NOT NULL, metadata_json TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS facts_session_goal_entity ON facts(session_id, goal_id, entity_id, observed_at DESC);
  CREATE INDEX IF NOT EXISTS facts_position ON facts(session_id, dimension, x, y, z);
  CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(id UNINDEXED, text);
  CREATE TABLE IF NOT EXISTS summaries (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, goal_id TEXT, text TEXT NOT NULL, event_from INTEGER NOT NULL, event_to INTEGER NOT NULL, created_at REAL NOT NULL);
  CREATE INDEX IF NOT EXISTS summaries_session_goal_created ON summaries(session_id, goal_id, created_at DESC);
`);
db.prepare('INSERT OR IGNORE INTO schema_migrations(version) VALUES (1)').run();

const insertEvent = db.prepare(
  'INSERT OR IGNORE INTO events(id,session_id,goal_id,seq,at,type,payload_json) VALUES(?,?,?,?,?,?,?)',
);
const insertGoal = db.prepare(
  'INSERT INTO goals(id,session_id,revision,status,content_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,revision=excluded.revision,status=excluded.status,content_json=excluded.content_json,updated_at=excluded.updated_at WHERE excluded.revision>=goals.revision',
);
const insertTask = db.prepare(
  'INSERT INTO tasks(id,goal_id,status,content_json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET goal_id=excluded.goal_id,status=excluded.status,content_json=excluded.content_json,updated_at=excluded.updated_at',
);
const insertFact = db.prepare(
  'INSERT INTO facts(id,session_id,goal_id,entity_id,dimension,x,y,z,text,source,observed_at,expires_at,confidence,confirmed,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,goal_id=excluded.goal_id,entity_id=excluded.entity_id,dimension=excluded.dimension,x=excluded.x,y=excluded.y,z=excluded.z,text=excluded.text,source=excluded.source,observed_at=excluded.observed_at,expires_at=excluded.expires_at,confidence=excluded.confidence,confirmed=excluded.confirmed,metadata_json=excluded.metadata_json',
);
const insertSummary = db.prepare(
  'INSERT INTO summaries(id,session_id,goal_id,text,event_from,event_to,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,event_from=excluded.event_from,event_to=excluded.event_to,created_at=excluded.created_at',
);

parentPort.on('message', ({ id, op, payload }) => {
  try {
    let value;
    if (op === 'ready') value = true;
    else if (op === 'writeBatch') value = writeBatch(payload);
    else if (op === 'search') value = search(payload);
    else if (op === 'close') {
      db.close();
      value = true;
    } else throw new Error(`unknown memory operation: ${op}`);
    parentPort.postMessage({ id, ok: true, value });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

function writeBatch(batch) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const e of batch.events ?? [])
      insertEvent.run(
        e.id ?? randomUUID(),
        e.sessionId,
        e.goalId ?? null,
        e.seq,
        e.at,
        e.type,
        JSON.stringify(e.payload),
      );
    for (const g of batch.goals ?? [])
      insertGoal.run(
        g.id,
        g.sessionId,
        g.revision,
        g.status,
        JSON.stringify(g.content),
        g.updatedAt,
      );
    for (const t of batch.tasks ?? [])
      insertTask.run(t.id, t.goalId, t.status, JSON.stringify(t.content), t.updatedAt);
    for (const f of batch.facts ?? []) {
      const id = f.id ?? randomUUID();
      insertFact.run(
        id,
        f.sessionId,
        f.goalId ?? null,
        f.entityId ?? null,
        f.dimension ?? null,
        f.x ?? null,
        f.y ?? null,
        f.z ?? null,
        f.text,
        f.source,
        f.observedAt,
        f.expiresAt ?? null,
        f.confidence ?? null,
        f.confirmed ? 1 : 0,
        JSON.stringify(f.metadata ?? null),
      );
      db.prepare('DELETE FROM facts_fts WHERE id=?').run(id);
      db.prepare('INSERT INTO facts_fts(id,text) VALUES(?,?)').run(id, f.text);
    }
    for (const s of batch.summaries ?? [])
      insertSummary.run(
        s.id,
        s.sessionId,
        s.goalId ?? null,
        s.text,
        s.eventFrom,
        s.eventTo,
        s.createdAt,
      );
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function search(input) {
  const askedLimit = Number.isFinite(input.limit) ? Math.trunc(input.limit) : 20;
  const limit = Math.max(1, Math.min(200, askedLimit));
  const now = input.now ?? Date.now();
  const position = input.position;
  const radius = position?.radius;
  const query = input.query?.trim();
  const terms = query
    ? query
        .split(/\s+/)
        .map((term) => `"${term.replaceAll('"', '""')}"`)
        .join(' AND ')
    : null;
  const factSql = `SELECT * FROM facts WHERE session_id=? AND (? IS NULL OR goal_id=?) AND (? IS NULL OR entity_id=?) AND (? IS NULL OR dimension=?) AND (expires_at IS NULL OR expires_at>?) AND (? IS NULL OR (x BETWEEN ? AND ? AND y BETWEEN ? AND ? AND z BETWEEN ? AND ?))${terms ? ' AND id IN (SELECT id FROM facts_fts WHERE facts_fts MATCH ?)' : ''} ORDER BY confirmed DESC, observed_at DESC LIMIT ?`;
  const args = [
    input.sessionId,
    input.goalId ?? null,
    input.goalId ?? null,
    input.entityId ?? null,
    input.entityId ?? null,
    input.dimension ?? null,
    input.dimension ?? null,
    now,
    radius ?? null,
    (position?.x ?? 0) - (radius ?? 0),
    (position?.x ?? 0) + (radius ?? 0),
    (position?.y ?? 0) - (radius ?? 0),
    (position?.y ?? 0) + (radius ?? 0),
    (position?.z ?? 0) - (radius ?? 0),
    (position?.z ?? 0) + (radius ?? 0),
    ...(terms ? [terms] : []),
    limit,
  ];
  const facts = db.prepare(factSql).all(...args);
  const events = db
    .prepare(
      'SELECT * FROM events WHERE session_id=? AND (? IS NULL OR goal_id=?) ORDER BY seq DESC LIMIT ?',
    )
    .all(input.sessionId, input.goalId ?? null, input.goalId ?? null, limit)
    .map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      goalId: r.goal_id,
      seq: r.seq,
      at: r.at,
      type: r.type,
      payload: JSON.parse(r.payload_json),
    }));
  const summaries = db
    .prepare(
      'SELECT * FROM summaries WHERE session_id=? AND (? IS NULL OR goal_id=?) ORDER BY created_at DESC LIMIT ?',
    )
    .all(input.sessionId, input.goalId ?? null, input.goalId ?? null, limit)
    .map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      goalId: r.goal_id,
      text: r.text,
      eventFrom: r.event_from,
      eventTo: r.event_to,
      createdAt: r.created_at,
    }));
  const mappedFacts = facts.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    goalId: r.goal_id,
    entityId: r.entity_id,
    dimension: r.dimension,
    x: r.x,
    y: r.y,
    z: r.z,
    text: r.text,
    source: r.source,
    observedAt: r.observed_at,
    expiresAt: r.expires_at,
    confidence: r.confidence,
    confirmed: Boolean(r.confirmed),
    metadata: JSON.parse(r.metadata_json),
  }));
  return { events, facts: mappedFacts, summaries };
}
