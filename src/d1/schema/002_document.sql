-- Document Store Schema for Cloudflare D1 (SQLite)
-- DomoTactical Storage Backend

-- Documents table for key-value document storage
CREATE TABLE IF NOT EXISTS documents (
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    state_type TEXT NOT NULL,
    state_type_version INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL,
    state_version INTEGER NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (type, id)
);

-- Document sources table for event sourcing support
CREATE TABLE IF NOT EXISTS document_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL,
    document_type TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_type_version INTEGER NOT NULL DEFAULT 1,
    source_data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);
CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents(updated_at);
CREATE INDEX IF NOT EXISTS idx_document_sources_document ON document_sources(document_type, document_id);
CREATE INDEX IF NOT EXISTS idx_document_sources_type ON document_sources(source_type);
