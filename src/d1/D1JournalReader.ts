// Copyright © 2012-2025 Vaughn Vernon. All rights reserved.
// Copyright © 2012-2025 Kalele, Inc. All rights reserved.
//
// Licensed under the Reciprocal Public License 1.5
//
// See: LICENSE.md in repository root directory
// See: https://opensource.org/license/rpl-1-5

import { Actor } from 'domo-actors'
import { JournalReader, Entry } from 'domo-tactical/store/journal'

/**
 * Cloudflare D1 implementation of JournalReader.
 *
 * Reads all entries across all streams in chronological order.
 * Position is persisted to D1 for durability across restarts.
 *
 * @template T the type of entry data (typically string for JSON)
 *
 * @example
 * ```typescript
 * const reader = await journal.journalReader('my-projection')
 *
 * // Read entries in batches
 * let entries = await reader.readNext(100)
 * while (entries.length > 0) {
 *   for (const entry of entries) {
 *     // Process entry
 *   }
 *   entries = await reader.readNext(100)
 * }
 * ```
 */
export class D1JournalReader<T> extends Actor implements JournalReader<T> {
  private readonly db: D1Database
  private readonly readerName: string
  private currentPosition: number = 0
  private initialized: boolean = false

  constructor(db: D1Database, name: string) {
    super()
    this.db = db
    this.readerName = name
  }

  async readNext(max: number): Promise<Entry<T>[]> {
    if (max <= 0) {
      throw new Error('max must be greater than 0')
    }

    await this.ensureInitialized()

    // Read entries from current position
    const result = await this.db.prepare(
      `SELECT global_position, entry_id, entry_type, entry_type_version, entry_data, metadata
       FROM journal_entries
       WHERE global_position > ?
       ORDER BY global_position ASC
       LIMIT ?`
    ).bind(this.currentPosition, max).all<{
      global_position: number
      entry_id: string
      entry_type: string
      entry_type_version: number
      entry_data: string
      metadata: string | null
    }>()

    const rows = result.results || []

    if (rows.length === 0) {
      return []
    }

    const entries: Entry<T>[] = rows.map((row) => ({
      id: row.entry_id,
      type: row.entry_type,
      typeVersion: row.entry_type_version,
      entryData: row.entry_data as T,
      metadata: row.metadata || '{}'
    }))

    // Update position to the last read entry's global_position
    const lastPosition = rows[rows.length - 1].global_position
    this.currentPosition = lastPosition

    // Persist position
    await this.persistPosition()

    return entries
  }

  async name(): Promise<string> {
    return this.readerName
  }

  async seek(position: number): Promise<void> {
    if (position < 0) {
      throw new Error('position cannot be negative')
    }

    this.currentPosition = position
    await this.persistPosition()
  }

  async position(): Promise<number> {
    await this.ensureInitialized()
    return this.currentPosition
  }

  async rewind(): Promise<void> {
    this.currentPosition = 0
    await this.persistPosition()
  }

  // Private helpers

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return
    }

    // Try to load existing position
    const result = await this.db.prepare(
      `SELECT current_position FROM journal_reader_positions WHERE reader_name = ?`
    ).bind(this.readerName).first<{ current_position: number }>()

    if (result) {
      this.currentPosition = result.current_position
    } else {
      // Create new reader position record
      await this.db.prepare(
        `INSERT INTO journal_reader_positions (reader_name, current_position) VALUES (?, 0)`
      ).bind(this.readerName).run()
      this.currentPosition = 0
    }

    this.initialized = true
  }

  private async persistPosition(): Promise<void> {
    await this.db.prepare(
      `UPDATE journal_reader_positions SET current_position = ?, updated_at = datetime('now') WHERE reader_name = ?`
    ).bind(this.currentPosition, this.readerName).run()
  }
}
