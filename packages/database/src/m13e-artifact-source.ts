export const M13E_ARTIFACT_SOURCE_SCHEMA_SQL = `
-- M13e links Run artifacts to the immutable project source facts they were
-- generated from. Existing and old-application inserts default to no sources.
ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS source_refs JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE artifacts
  DROP CONSTRAINT IF EXISTS artifacts_source_refs_array_check;
ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_source_refs_array_check
  CHECK (jsonb_typeof(source_refs) = 'array');

CREATE INDEX IF NOT EXISTS artifacts_source_refs_idx
  ON artifacts USING GIN (source_refs);
`;
