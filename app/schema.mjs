/** Ordered, append-only Postgres migrations for the MMS application.
 * Each entry runs once inside a transaction; applied ids are recorded in mms_migrations.
 */
export const MIGRATIONS = [
 ['001_accounts', `
CREATE TABLE IF NOT EXISTS users (
 id BIGSERIAL PRIMARY KEY,
 email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 display_name TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 disabled BOOLEAN NOT NULL DEFAULT false,
 bootstrap BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS user_roles (
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK (role IN ('admin','producer','judge','entrant','fan','industry')),
 PRIMARY KEY (user_id, role)
);
CREATE TABLE IF NOT EXISTS sessions (
 id TEXT PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 csrf TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS settings (
 key TEXT PRIMARY KEY,
 value JSONB NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_log (
 id BIGSERIAL PRIMARY KEY,
 at TIMESTAMPTZ NOT NULL DEFAULT now(),
 actor_user_id BIGINT,
 action TEXT NOT NULL,
 detail JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS notifications (
 id BIGSERIAL PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 at TIMESTAMPTZ NOT NULL DEFAULT now(),
 message TEXT NOT NULL,
 read BOOLEAN NOT NULL DEFAULT false
);`],
 ['002_engine', `
CREATE TABLE IF NOT EXISTS events (
 id BIGSERIAL PRIMARY KEY,
 slug TEXT NOT NULL UNIQUE,
 title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 venue TEXT NOT NULL DEFAULT '',
 starts_at TIMESTAMPTZ,
 status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','live','completed','archived')),
 published BOOLEAN NOT NULL DEFAULT false,
 voting_enabled BOOLEAN NOT NULL DEFAULT false,
 votes_per_fan INT NOT NULL DEFAULT 1 CHECK (votes_per_fan BETWEEN 1 AND 10),
 vote_weight_bps INT NOT NULL DEFAULT 0 CHECK (vote_weight_bps BETWEEN 0 AND 10000),
 tie_rule TEXT NOT NULL DEFAULT 'manual-review',
 stream_url TEXT,
 champion_entrant_id BIGINT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 finalized_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS criteria (
 id BIGSERIAL PRIMARY KEY,
 event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 weight_bps INT NOT NULL CHECK (weight_bps BETWEEN 1 AND 10000),
 max_score INT NOT NULL DEFAULT 10 CHECK (max_score BETWEEN 1 AND 100),
 position INT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rounds (
 id BIGSERIAL PRIMARY KEY,
 event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 position INT NOT NULL,
 name TEXT NOT NULL,
 kind TEXT NOT NULL DEFAULT 'qualifier' CHECK (kind IN ('qualifier','semifinal','final','heat','battle')),
 time_limit_seconds INT NOT NULL CHECK (time_limit_seconds BETWEEN 10 AND 3600),
 advance_count INT NOT NULL DEFAULT 1 CHECK (advance_count BETWEEN 0 AND 1000),
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','live','closed')),
 UNIQUE (event_id, position)
);
CREATE TABLE IF NOT EXISTS heats (
 id BIGSERIAL PRIMARY KEY,
 round_id BIGINT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
 position INT NOT NULL,
 name TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','live','closed','finalized')),
 voting_open BOOLEAN NOT NULL DEFAULT false,
 timer_entry_id BIGINT,
 timer_started_at TIMESTAMPTZ,
 timer_elapsed_ms BIGINT NOT NULL DEFAULT 0,
 timer_running BOOLEAN NOT NULL DEFAULT false,
 UNIQUE (round_id, position)
);
CREATE TABLE IF NOT EXISTS entrants (
 id BIGSERIAL PRIMARY KEY,
 event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 display_name TEXT NOT NULL,
 user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
 application_id BIGINT,
 seed INT,
 status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn','disqualified')),
 publish_consent BOOLEAN NOT NULL DEFAULT false,
 UNIQUE (event_id, user_id)
);
CREATE TABLE IF NOT EXISTS heat_entries (
 id BIGSERIAL PRIMARY KEY,
 heat_id BIGINT NOT NULL REFERENCES heats(id) ON DELETE CASCADE,
 entrant_id BIGINT NOT NULL REFERENCES entrants(id) ON DELETE CASCADE,
 position INT NOT NULL DEFAULT 0,
 performed_ms BIGINT,
 overtime BOOLEAN NOT NULL DEFAULT false,
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','performing','done','no_show','forfeit')),
 recording_url TEXT,
 captions TEXT,
 captions_corrected BOOLEAN NOT NULL DEFAULT false,
 UNIQUE (heat_id, entrant_id)
);
CREATE TABLE IF NOT EXISTS judges (
 event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY (event_id, user_id)
);
CREATE TABLE IF NOT EXISTS scores (
 heat_entry_id BIGINT NOT NULL REFERENCES heat_entries(id) ON DELETE CASCADE,
 judge_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 criterion_id BIGINT NOT NULL REFERENCES criteria(id) ON DELETE CASCADE,
 value NUMERIC(6,2) NOT NULL CHECK (value >= 0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (heat_entry_id, judge_user_id, criterion_id)
);
CREATE TABLE IF NOT EXISTS votes (
 id BIGSERIAL PRIMARY KEY,
 heat_id BIGINT NOT NULL REFERENCES heats(id) ON DELETE CASCADE,
 heat_entry_id BIGINT NOT NULL REFERENCES heat_entries(id) ON DELETE CASCADE,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 ip_hash TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE (heat_id, user_id, heat_entry_id)
);
CREATE INDEX IF NOT EXISTS votes_ip ON votes(heat_id, ip_hash);
CREATE TABLE IF NOT EXISTS results (
 heat_id BIGINT NOT NULL REFERENCES heats(id) ON DELETE CASCADE,
 entrant_id BIGINT NOT NULL REFERENCES entrants(id) ON DELETE CASCADE,
 rank INT NOT NULL,
 judge_score NUMERIC(8,3) NOT NULL,
 vote_count INT NOT NULL,
 combined NUMERIC(8,3) NOT NULL,
 tied BOOLEAN NOT NULL DEFAULT false,
 advanced BOOLEAN NOT NULL DEFAULT false,
 note TEXT NOT NULL DEFAULT '',
 PRIMARY KEY (heat_id, entrant_id)
);`],
 ['003_applications', `
CREATE TABLE IF NOT EXISTS applications (
 id BIGSERIAL PRIMARY KEY,
 user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 event_id BIGINT REFERENCES events(id) ON DELETE SET NULL,
 status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','under_review','shortlisted','accepted','declined','withdrawn')),
 stage_name TEXT NOT NULL,
 pronouns TEXT NOT NULL DEFAULT '',
 city TEXT NOT NULL DEFAULT '',
 bio TEXT NOT NULL DEFAULT '',
 representation TEXT NOT NULL CHECK (representation IN ('none','agency','manager','self-represented')),
 agency_name TEXT NOT NULL DEFAULT '',
 union_status TEXT NOT NULL CHECK (union_status IN ('prefer-not-to-say','union','non-union')),
 monologue_title TEXT NOT NULL,
 monologue_source TEXT NOT NULL DEFAULT '',
 monologue_seconds INT NOT NULL CHECK (monologue_seconds BETWEEN 10 AND 600),
 headshot_url TEXT,
 resume_url TEXT,
 reel_url TEXT,
 consent_version TEXT NOT NULL,
 consent_review BOOLEAN NOT NULL,
 consent_discovery BOOLEAN NOT NULL DEFAULT false,
 consent_contact BOOLEAN NOT NULL DEFAULT false,
 consent_publication BOOLEAN NOT NULL DEFAULT false,
 consent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 consent_ip_hash TEXT NOT NULL DEFAULT '',
 consent_generation INT NOT NULL DEFAULT 1,
 producer_notes TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS applications_user ON applications(user_id);
CREATE TABLE IF NOT EXISTS media (
 id BIGSERIAL PRIMARY KEY,
 owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 application_id BIGINT REFERENCES applications(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK (kind IN ('headshot','resume')),
 mime TEXT NOT NULL,
 size INT NOT NULL,
 sha256 TEXT NOT NULL,
 iv BYTEA NOT NULL,
 tag BYTEA NOT NULL,
 ciphertext BYTEA NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS industry_profiles (
 user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 company TEXT NOT NULL,
 title TEXT NOT NULL,
 website TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
 decided_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS saved_actors (
 industry_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 application_id BIGINT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (industry_user_id, application_id)
);
CREATE TABLE IF NOT EXISTS contact_requests (
 id BIGSERIAL PRIMARY KEY,
 industry_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 application_id BIGINT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
 generation INT NOT NULL,
 message TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 decided_at TIMESTAMPTZ,
 UNIQUE (industry_user_id, application_id, generation)
);
CREATE TABLE IF NOT EXISTS sponsors (
 id BIGSERIAL PRIMARY KEY,
 name TEXT NOT NULL,
 url TEXT NOT NULL DEFAULT '',
 blurb TEXT NOT NULL DEFAULT '',
 active BOOLEAN NOT NULL DEFAULT true,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`],
];

export async function migrate(pool) {
 const client = await pool.connect();
 try {
  await client.query('SELECT pg_advisory_lock(727001)');
  await client.query('CREATE TABLE IF NOT EXISTS mms_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await client.query('SELECT id FROM mms_migrations')).rows.map(r => r.id));
  for (const [id, sql] of MIGRATIONS) {
   if (done.has(id)) continue;
   await client.query('BEGIN');
   try { await client.query(sql); await client.query('INSERT INTO mms_migrations(id) VALUES ($1)', [id]); await client.query('COMMIT'); }
   catch (e) { await client.query('ROLLBACK'); throw e; }
  }
 } finally {
  await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
  client.release();
 }
}
