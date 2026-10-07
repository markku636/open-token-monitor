-- A second scope for API tokens (hub/apiTokens.js): analytics:read opens the
-- org tree, the employee list, the AI accounts' quota windows and the usage
-- analysis under /api/reports/v1/ (hub/analytics.js). Tokens made before keep
-- reports:read alone.
ALTER TABLE api_tokens DROP CONSTRAINT api_tokens_scopes_check;
ALTER TABLE api_tokens ADD CONSTRAINT api_tokens_scopes_check
  CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['reports:read', 'analytics:read']);
