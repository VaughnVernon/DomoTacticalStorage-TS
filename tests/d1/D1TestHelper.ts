// Copyright © 2012-2025 Vaughn Vernon. All rights reserved.
// Copyright © 2012-2025 Kalele, Inc. All rights reserved.
//
// Licensed under the Reciprocal Public License 1.5
//
// See: LICENSE.md in repository root directory
// See: https://opensource.org/license/rpl-1-5

import { Miniflare } from 'miniflare'

// Journal schema statements for D1 (single line for compatibility)
const JOURNAL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS streams (stream_name TEXT PRIMARY KEY, current_version INTEGER NOT NULL DEFAULT 0, is_tombstoned INTEGER NOT NULL DEFAULT 0, is_soft_deleted INTEGER NOT NULL DEFAULT 0, deleted_at_version INTEGER, truncate_before INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,

  `CREATE TABLE IF NOT EXISTS journal_entries (global_position INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL, stream_name TEXT NOT NULL, stream_version INTEGER NOT NULL, entry_type TEXT NOT NULL, entry_type_version INTEGER NOT NULL DEFAULT 1, entry_data TEXT NOT NULL, metadata TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(stream_name, stream_version))`,

  `CREATE TABLE IF NOT EXISTS snapshots (stream_name TEXT PRIMARY KEY, snapshot_type TEXT NOT NULL, snapshot_type_version INTEGER NOT NULL DEFAULT 1, snapshot_data TEXT NOT NULL, snapshot_version INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,

  `CREATE TABLE IF NOT EXISTS journal_reader_positions (reader_name TEXT PRIMARY KEY, current_position INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,

  `CREATE INDEX IF NOT EXISTS idx_journal_entries_stream ON journal_entries(stream_name)`,
  `CREATE INDEX IF NOT EXISTS idx_journal_entries_stream_version ON journal_entries(stream_name, stream_version)`,
  `CREATE INDEX IF NOT EXISTS idx_journal_entries_type ON journal_entries(entry_type)`
]

// Document schema statements for D1 (single line for compatibility)
const DOCUMENT_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS documents (id TEXT NOT NULL, type TEXT NOT NULL, state TEXT NOT NULL, state_version INTEGER NOT NULL, metadata TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (type, id))`,

  `CREATE TABLE IF NOT EXISTS document_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, document_type TEXT NOT NULL, source_type TEXT NOT NULL, source_type_version INTEGER NOT NULL DEFAULT 1, source_data TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,

  `CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type)`,
  `CREATE INDEX IF NOT EXISTS idx_document_sources_document ON document_sources(document_type, document_id)`
]

/**
 * D1 test context containing Miniflare instance and database.
 */
export interface D1TestContext {
  miniflare: Miniflare
  db: D1Database
}

/**
 * Create a Miniflare instance with D1 database for testing.
 *
 * @param includeJournalSchema - Whether to create journal tables
 * @param includeDocumentSchema - Whether to create document tables
 * @returns D1TestContext with miniflare and db
 */
export async function createD1TestContext(
  includeJournalSchema = true,
  includeDocumentSchema = true
): Promise<D1TestContext> {
  const miniflare = new Miniflare({
    modules: true,
    script: `
      export default {
        async fetch() {
          return new Response('OK');
        }
      }
    `,
    d1Databases: ['DB']
  })

  const db = await miniflare.getD1Database('DB')

  // Execute schema migrations using prepare().run() for better compatibility
  if (includeJournalSchema) {
    for (const statement of JOURNAL_SCHEMA_STATEMENTS) {
      await db.prepare(statement).run()
    }
  }

  if (includeDocumentSchema) {
    for (const statement of DOCUMENT_SCHEMA_STATEMENTS) {
      await db.prepare(statement).run()
    }
  }

  return { miniflare, db }
}

/**
 * Clean up Miniflare instance.
 */
export async function disposeD1TestContext(context: D1TestContext): Promise<void> {
  await context.miniflare.dispose()
}

/**
 * Clear all data from D1 tables (for use between tests).
 */
export async function clearD1Data(db: D1Database): Promise<void> {
  // Delete in order to avoid foreign key issues
  try { await db.prepare('DELETE FROM journal_entries').run() } catch { /* table may not exist */ }
  try { await db.prepare('DELETE FROM snapshots').run() } catch { /* table may not exist */ }
  try { await db.prepare('DELETE FROM streams').run() } catch { /* table may not exist */ }
  try { await db.prepare('DELETE FROM journal_reader_positions').run() } catch { /* table may not exist */ }
  try { await db.prepare('DELETE FROM document_sources').run() } catch { /* table may not exist */ }
  try { await db.prepare('DELETE FROM documents').run() } catch { /* table may not exist */ }
}
