-- Journal Schema for PostgreSQL
-- DomoTactical Storage Backend

-- Streams table to track stream metadata and lifecycle
CREATE TABLE IF NOT EXISTS streams (
    stream_name VARCHAR(500) PRIMARY KEY,
    current_version BIGINT NOT NULL DEFAULT 0,
    is_tombstoned BOOLEAN NOT NULL DEFAULT FALSE,
    is_soft_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at_version BIGINT,
    truncate_before BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Journal entries table for all events/commands
CREATE TABLE IF NOT EXISTS journal_entries (
    global_position BIGSERIAL PRIMARY KEY,
    entry_id CHAR(26) NOT NULL,
    stream_name VARCHAR(500) NOT NULL,
    stream_version BIGINT NOT NULL,
    entry_type VARCHAR(500) NOT NULL,
    entry_type_version INT NOT NULL DEFAULT 1,
    entry_data JSONB NOT NULL,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(stream_name, stream_version)
);

-- Snapshots table for aggregate state snapshots
CREATE TABLE IF NOT EXISTS snapshots (
    stream_name VARCHAR(500) PRIMARY KEY REFERENCES streams(stream_name) ON DELETE CASCADE,
    snapshot_type VARCHAR(500) NOT NULL,
    snapshot_type_version INT NOT NULL DEFAULT 1,
    snapshot_data JSONB NOT NULL,
    snapshot_version BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Journal reader positions for persistent reader tracking
CREATE TABLE IF NOT EXISTS journal_reader_positions (
    reader_name VARCHAR(500) PRIMARY KEY,
    current_position BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_journal_entries_stream ON journal_entries(stream_name);
CREATE INDEX IF NOT EXISTS idx_journal_entries_stream_version ON journal_entries(stream_name, stream_version);
CREATE INDEX IF NOT EXISTS idx_journal_entries_type ON journal_entries(entry_type);
CREATE INDEX IF NOT EXISTS idx_journal_entries_created_at ON journal_entries(created_at);
CREATE INDEX IF NOT EXISTS idx_streams_tombstoned ON streams(is_tombstoned) WHERE is_tombstoned = TRUE;
CREATE INDEX IF NOT EXISTS idx_streams_soft_deleted ON streams(is_soft_deleted) WHERE is_soft_deleted = TRUE;
