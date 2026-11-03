-- Sign in with Google, Facebook, X and LinkedIn.
-- Accounts created through a provider may have no password, and X accounts may have no email.

ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- One row per provider account linked to a Litview user.
CREATE TABLE IF NOT EXISTS user_identities (
  provider         text NOT NULL CHECK (provider IN ('google', 'facebook', 'x', 'linkedin')),
  provider_user_id text NOT NULL,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS user_identities_user_idx ON user_identities (user_id);

-- Short-lived, single-use codes the browser swaps for a session token after a provider sign-in,
-- so the token itself never appears in a URL.
CREATE TABLE IF NOT EXISTS login_codes (
  code_hash  text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
