CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE analyses (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    state JSONB NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1,
    share_token TEXT UNIQUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX analyses_owner_updated ON analyses (owner, updated_at DESC);
