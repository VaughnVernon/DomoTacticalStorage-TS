// Copyright © 2012-2026 Vaughn Vernon. All rights reserved.
// Copyright © 2012-2026 Kalele, Inc. All rights reserved.
//
// See: LICENSE.md in repository root directory
//
// This file is part of DomoTacticalStorage-TS.
//
// DomoTacticalStorage-TS is free software: you can redistribute it and/or
// modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version.
//
// DomoTacticalStorage-TS is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with DomoTacticalStorage-TS. If not, see <https://www.gnu.org/licenses/>.

import { Actor } from 'domo-actors'
import { JournalReader } from 'domo-tactical/store/journal'
import { Entry, TextEntry } from 'domo-tactical/store'

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
      `SELECT global_position, entry_id, entry_type, entry_type_version, entry_data, stream_version, metadata
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
      stream_version: number
      metadata: string | null
    }>()

    const rows = result.results || []

    if (rows.length === 0) {
      return []
    }

    const entries: TextEntry[] = rows.map((row) =>
      new TextEntry(
        row.entry_id,
        row.global_position,
        row.entry_type,
        row.entry_type_version,
        row.entry_data,
        row.stream_version,
        row.metadata || '{}'
      )
    )

    // Update position to the last read entry's global_position
    const lastPosition = rows[rows.length - 1].global_position
    this.currentPosition = lastPosition

    // Persist position
    await this.persistPosition()

    // Cast to Entry<T>[] for return type compatibility
    return entries as unknown as Entry<T>[]
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
