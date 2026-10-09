export interface Migration {
  version: number;
  sql: string;
}

// All SQL here is plain Postgres so it runs identically on pg and PGlite.
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE source_items (
  id            UUID PRIMARY KEY,
  source        TEXT NOT NULL,
  kind          TEXT NOT NULL,            -- news | results | trend | reddit | internal
  pillar        TEXT,
  url           TEXT,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  body_text     TEXT NOT NULL DEFAULT '',
  published_at  TIMESTAMPTZ,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_hash  TEXT NOT NULL UNIQUE,
  metrics       JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding     JSONB
);
CREATE INDEX source_items_published_idx ON source_items (published_at DESC);
CREATE INDEX source_items_fetched_idx ON source_items (fetched_at DESC);

CREATE TABLE content (
  id               UUID PRIMARY KEY,
  correlation_id   UUID NOT NULL,
  status           TEXT NOT NULL,
  pillar           TEXT NOT NULL,
  template         TEXT NOT NULL,
  topic            TEXT NOT NULL,
  hook_style       TEXT,
  idea             JSONB NOT NULL DEFAULT '{}'::jsonb,
  script           JSONB,
  voice            JSONB,
  render           JSONB,
  qa               JSONB,
  score            DOUBLE PRECISION,
  regen_count      INT NOT NULL DEFAULT 0,
  qa_feedback      TEXT,
  source_item_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
  embedding        JSONB,
  error            TEXT,
  failed_stage     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX content_status_idx ON content (status);
CREATE INDEX content_created_idx ON content (created_at DESC);

CREATE TABLE content_events (
  id             BIGSERIAL PRIMARY KEY,
  content_id     UUID NOT NULL,
  correlation_id UUID,
  from_status    TEXT,
  to_status      TEXT,
  stage          TEXT,
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
  at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX content_events_content_idx ON content_events (content_id, id);

CREATE TABLE qa_results (
  id          BIGSERIAL PRIMARY KEY,
  content_id  UUID NOT NULL,
  attempt     INT NOT NULL,
  passed      BOOLEAN NOT NULL,
  scores      JSONB NOT NULL DEFAULT '{}'::jsonb,
  reasons     JSONB NOT NULL DEFAULT '[]'::jsonb,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX qa_results_created_idx ON qa_results (created_at DESC);

CREATE TABLE publications (
  id            UUID PRIMARY KEY,
  content_id    UUID NOT NULL,
  platform      TEXT NOT NULL,
  status        TEXT NOT NULL,            -- scheduled | publishing | published | failed | skipped
  scheduled_at  TIMESTAMPTZ,
  published_at  TIMESTAMPTZ,
  external_id   TEXT,
  url           TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  error         TEXT,
  attempts      INT NOT NULL DEFAULT 0,
  dry_run       BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (content_id, platform)
);
CREATE INDEX publications_status_idx ON publications (status, scheduled_at);

CREATE TABLE analytics_snapshots (
  id                 BIGSERIAL PRIMARY KEY,
  publication_id     UUID NOT NULL,
  checkpoint         TEXT NOT NULL,       -- 1h | 24h | 7d
  taken_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  views              DOUBLE PRECISION,
  likes              DOUBLE PRECISION,
  comments           DOUBLE PRECISION,
  shares             DOUBLE PRECISION,
  saves              DOUBLE PRECISION,
  follows            DOUBLE PRECISION,
  watch_time_s       DOUBLE PRECISION,
  avg_view_duration_s DOUBLE PRECISION,
  retention_pct      DOUBLE PRECISION,
  raw                JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (publication_id, checkpoint)
);

CREATE TABLE weight_versions (
  version     SERIAL PRIMARY KEY,
  weights     JSONB NOT NULL,
  reason      TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'auto',   -- initial | auto | rollback
  rolled_back_to INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE spend_ledger (
  id             BIGSERIAL PRIMARY KEY,
  provider       TEXT NOT NULL,
  category       TEXT NOT NULL,
  units          DOUBLE PRECISION NOT NULL DEFAULT 0,
  usd            DOUBLE PRECISION NOT NULL,
  content_id     UUID,
  correlation_id UUID,
  at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX spend_provider_at_idx ON spend_ledger (provider, at);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);

CREATE TABLE oauth_tokens (
  platform            TEXT PRIMARY KEY,
  access_token_enc    TEXT NOT NULL,
  refresh_token_enc   TEXT,
  expires_at          TIMESTAMPTZ,
  refresh_expires_at  TIMESTAMPTZ,
  scopes              TEXT,
  account_id          TEXT,
  account_name        TEXT,
  meta                JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_refresh_error  TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE alerts_log (
  id        BIGSERIAL PRIMARY KEY,
  key       TEXT NOT NULL,
  severity  TEXT NOT NULL,
  title     TEXT NOT NULL,
  body      TEXT NOT NULL DEFAULT '',
  channels  JSONB NOT NULL DEFAULT '[]'::jsonb,
  suppressed BOOLEAN NOT NULL DEFAULT false,
  at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX alerts_key_at_idx ON alerts_log (key, at DESC);

CREATE TABLE dead_letters (
  id             BIGSERIAL PRIMARY KEY,
  queue          TEXT NOT NULL,
  job_id         TEXT,
  content_id     UUID,
  correlation_id UUID,
  error          TEXT NOT NULL,
  attempts       INT NOT NULL DEFAULT 0,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
];
