-- Journal Schema for Cloudflare D1 (SQLite)
-- DomoTactical Storage Backend

-- Streams table to track stream metadata and lifecycle
CREATE TABLE IF NOT EXISTS streams (
    stream_name TEXT PRIMARY KEY,
    current_version INTEGER NOT NULL DEFAULT 0,
    is_tombstoned INTEGER NOT NULL DEFAULT 0,
    is_soft_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at_version INTEGER,
    truncate_before INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Journal entries table for all events/commands
CREATE TABLE IF NOT EXISTS journal_entries (
    global_position INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT NOT NULL,
    stream_name TEXT NOT NULL,
    stream_version INTEGER NOT NULL,
    entry_type TEXT NOT NULL,
    entry_type_version INTEGER NOT NULL DEFAULT 1,
    entry_data TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(stream_name, stream_version)
);

-- Snapshots table for aggregate state snapshots
CREATE TABLE IF NOT EXISTS snapshots (
    stream_name TEXT PRIMARY KEY REFERENCES streams(stream_name) ON DELETE CASCADE,
    snapshot_type TEXT NOT NULL,
    snapshot_type_version INTEGER NOT NULL DEFAULT 1,
    snapshot_data TEXT NOT NULL,
    snapshot_version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Journal reader positions for persistent reader tracking
CREATE TABLE IF NOT EXISTS journal_reader_positions (
    reader_name TEXT PRIMARY KEY,
    current_position INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_journal_entries_stream ON journal_entries(stream_name);
CREATE INDEX IF NOT EXISTS idx_journal_entries_stream_version ON journal_entries(stream_name, stream_version);
CREATE INDEX IF NOT EXISTS idx_journal_entries_type ON journal_entries(entry_type);
CREATE INDEX IF NOT EXISTS idx_streams_tombstoned ON streams(is_tombstoned) WHERE is_tombstoned = 1;
CREATE INDEX IF NOT EXISTS idx_streams_soft_deleted ON streams(is_soft_deleted) WHERE is_soft_deleted = 1;
