-- Litview schema: users, reviews, team membership, retrieved records and screening decisions.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email));

CREATE TABLE IF NOT EXISTS reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  topic       text NOT NULL,
  opts        jsonb NOT NULL DEFAULT '{}'::jsonb,
  invite_code text UNIQUE,
  synthesis   jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS review_members (
  review_id uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      text NOT NULL CHECK (role IN ('owner', 'reviewer')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, user_id)
);
CREATE INDEX IF NOT EXISTS review_members_user_idx ON review_members (user_id);

-- One row per database searched or imported. items holds the records exactly as retrieved,
-- so deduplication can be re-run whenever a new source is added.
CREATE TABLE IF NOT EXISTS review_sources (
  review_id  uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  source     text NOT NULL,
  items      jsonb NOT NULL DEFAULT '[]'::jsonb,
  total      integer,
  query_url  text,
  imported   boolean NOT NULL DEFAULT false,
  added_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, source)
);

-- Each reviewer's own decision on each record (record_key = DOI or normalised title).
CREATE TABLE IF NOT EXISTS decisions (
  review_id  uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  record_key text NOT NULL,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     text NOT NULL CHECK (status IN ('included', 'excluded')),
  reason     text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, record_key, user_id)
);

-- The owner's final call when reviewers disagree.
CREATE TABLE IF NOT EXISTS resolutions (
  review_id   uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  record_key  text NOT NULL,
  status      text NOT NULL CHECK (status IN ('included', 'excluded')),
  reason      text,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, record_key)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
