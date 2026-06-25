CREATE TABLE IF NOT EXISTS relay_pairings (
  pair_id TEXT PRIMARY KEY,
  pairing_code TEXT UNIQUE,
  desktop_token_hash TEXT NOT NULL,
  mobile_token_hash TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  next_server_seq BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS relay_pairings_pairing_code_active_idx
  ON relay_pairings (pairing_code)
  WHERE pairing_code IS NOT NULL AND mobile_token_hash IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS relay_pairings_expires_at_idx
  ON relay_pairings (expires_at)
  WHERE mobile_token_hash IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS relay_envelopes (
  pair_id TEXT NOT NULL REFERENCES relay_pairings(pair_id) ON DELETE CASCADE,
  envelope_id TEXT NOT NULL,
  server_seq BIGINT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('desktop', 'mobile', 'server')),
  created_at TIMESTAMPTZ NOT NULL,
  stored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL,
  PRIMARY KEY (pair_id, envelope_id),
  UNIQUE (pair_id, server_seq)
);

CREATE INDEX IF NOT EXISTS relay_envelopes_pair_seq_idx
  ON relay_envelopes (pair_id, server_seq);

CREATE TABLE IF NOT EXISTS relay_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO relay_schema_migrations (version)
VALUES ('001_initial_relay')
ON CONFLICT (version) DO NOTHING;
