-- Document Store Schema for PostgreSQL
-- DomoTactical Storage Backend

-- Documents table for key-value document storage
CREATE TABLE IF NOT EXISTS documents (
    id VARCHAR(500) NOT NULL,
    type VARCHAR(500) NOT NULL,
    state_type VARCHAR(500) NOT NULL,
    state_type_version INT NOT NULL DEFAULT 1,
    state JSONB NOT NULL,
    state_version BIGINT NOT NULL,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (type, id)
);

-- Document sources table for event sourcing support
CREATE TABLE IF NOT EXISTS document_sources (
    id BIGSERIAL PRIMARY KEY,
    document_id VARCHAR(500) NOT NULL,
    document_type VARCHAR(500) NOT NULL,
    source_type VARCHAR(500) NOT NULL,
    source_type_version INT NOT NULL DEFAULT 1,
    source_data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);
CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents(updated_at);
CREATE INDEX IF NOT EXISTS idx_document_sources_document ON document_sources(document_type, document_id);
CREATE INDEX IF NOT EXISTS idx_document_sources_type ON document_sources(source_type);
