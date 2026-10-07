-- Tokens other systems read the reports API with (hub/apiTokens.js), made by
-- an admin on the dashboard. Only a SHA-256 of each token is kept: the token
-- itself is shown once, when it is made. token_prefix is the part a token is
-- found by; it is also what the dashboard shows to tell tokens apart.
CREATE TABLE api_tokens (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  token_prefix  text NOT NULL UNIQUE,
  token_hash    bytea NOT NULL CHECK (length(token_hash) = 32),
  scopes        text[] NOT NULL DEFAULT '{reports:read}' CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['reports:read']),
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL,
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    text
);
