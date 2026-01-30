// Copyright © 2012-2025 Vaughn Vernon. All rights reserved.
// Copyright © 2012-2025 Kalele, Inc. All rights reserved.
//
// Licensed under the Reciprocal Public License 1.5
//
// See: LICENSE.md in repository root directory
// See: https://opensource.org/license/rpl-1-5

import { Actor } from 'domo-actors'
import { JournalReader, Entry } from 'domo-tactical/store/journal'
import { Pool, PoolClient } from 'pg'

/**
 * PostgreSQL implementation of JournalReader.
 *
 * Reads all entries across all streams in chronological order.
 * Position is persisted to the database for durability across restarts.
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
export class PostgresJournalReader<T> extends Actor implements JournalReader<T> {
  private readonly pool: Pool
  private readonly readerName: string
  private currentPosition: number = 0
  private initialized: boolean = false

  constructor(pool: Pool, name: string) {
    super()
    this.pool = pool
    this.readerName = name
  }

  async readNext(max: number): Promise<Entry<T>[]> {
    if (max <= 0) {
      throw new Error('max must be greater than 0')
    }

    await this.ensureInitialized()

    const client = await this.pool.connect()
    try {
      // Read entries from current position
      const result = await client.query(
        `SELECT global_position, entry_id, entry_type, entry_type_version, entry_data, metadata
         FROM journal_entries
         WHERE global_position > $1
         ORDER BY global_position ASC
         LIMIT $2`,
        [this.currentPosition, max]
      )

      if (result.rows.length === 0) {
        return []
      }

      const entries: Entry<T>[] = result.rows.map((row) => ({
        id: row.entry_id,
        type: row.entry_type,
        typeVersion: row.entry_type_version,
        entryData: (typeof row.entry_data === 'string' ? row.entry_data : JSON.stringify(row.entry_data)) as T,
        metadata: typeof row.metadata === 'string' ? row.metadata : JSON.stringify(row.metadata || {})
      }))

      // Update position to the last read entry's global_position
      const lastPosition = Number(result.rows[result.rows.length - 1].global_position)
      this.currentPosition = lastPosition

      // Persist position
      await this.persistPosition(client)

      return entries
    } finally {
      client.release()
    }
  }

  async name(): Promise<string> {
    return this.readerName
  }

  async seek(position: number): Promise<void> {
    if (position < 0) {
      throw new Error('position cannot be negative')
    }

    this.currentPosition = position

    const client = await this.pool.connect()
    try {
      await this.persistPosition(client)
    } finally {
      client.release()
    }
  }

  async position(): Promise<number> {
    await this.ensureInitialized()
    return this.currentPosition
  }

  async rewind(): Promise<void> {
    this.currentPosition = 0

    const client = await this.pool.connect()
    try {
      await this.persistPosition(client)
    } finally {
      client.release()
    }
  }

  // Private helpers

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return
    }

    const client = await this.pool.connect()
    try {
      // Try to load existing position
      const result = await client.query(
        `SELECT current_position FROM journal_reader_positions WHERE reader_name = $1`,
        [this.readerName]
      )

      if (result.rows.length > 0) {
        this.currentPosition = Number(result.rows[0].current_position)
      } else {
        // Create new reader position record
        await client.query(
          `INSERT INTO journal_reader_positions (reader_name, current_position)
           VALUES ($1, 0)`,
          [this.readerName]
        )
        this.currentPosition = 0
      }

      this.initialized = true
    } finally {
      client.release()
    }
  }

  private async persistPosition(client: PoolClient): Promise<void> {
    await client.query(
      `UPDATE journal_reader_positions
       SET current_position = $1, updated_at = NOW()
       WHERE reader_name = $2`,
      [this.currentPosition, this.readerName]
    )
  }
}
