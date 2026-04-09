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
import { StreamReader, EntryStream } from 'domo-tactical/store/journal'
import { State, ObjectState, Entry, TextEntry } from 'domo-tactical/store'
import { Pool } from 'pg'

/**
 * PostgreSQL implementation of StreamReader.
 *
 * Reads entries and snapshots for a specific stream from PostgreSQL.
 *
 * @template T the type of entry data (typically string for JSON)
 */
export class PostgresStreamReader<T> extends Actor implements StreamReader<T> {
  private readonly pool: Pool
  // Reader name stored for debugging/logging purposes
  private readonly _readerName: string

  constructor(pool: Pool, name: string) {
    super()
    this.pool = pool
    this._readerName = name
  }

  async streamFor(streamName: string): Promise<EntryStream<T>> {
    const client = await this.pool.connect()
    try {
      // Get stream metadata
      const streamResult = await client.query(
        `SELECT current_version, is_tombstoned, is_soft_deleted, deleted_at_version, truncate_before
         FROM streams WHERE stream_name = $1`,
        [streamName]
      )

      if (streamResult.rows.length === 0) {
        return EntryStream.empty<T>(streamName)
      }

      const streamRow = streamResult.rows[0]
      const currentVersion = Number(streamRow.current_version)
      const truncateBefore = Number(streamRow.truncate_before)

      // Check tombstone
      if (streamRow.is_tombstoned) {
        return EntryStream.tombstoned<T>(streamName, currentVersion)
      }

      // Check soft-delete
      if (streamRow.is_soft_deleted) {
        return EntryStream.softDeleted<T>(streamName, Number(streamRow.deleted_at_version))
      }

      // Get entries respecting truncate-before
      const entriesResult = await client.query(
        `SELECT global_position, entry_id, entry_type, entry_type_version, entry_data, stream_version, metadata
         FROM journal_entries
         WHERE stream_name = $1 AND stream_version >= $2
         ORDER BY stream_version ASC`,
        [streamName, truncateBefore]
      )

      const entries: TextEntry[] = entriesResult.rows.map((row) =>
        new TextEntry(
          row.entry_id,
          Number(row.global_position),
          row.entry_type,
          row.entry_type_version,
          typeof row.entry_data === 'string' ? row.entry_data : JSON.stringify(row.entry_data),
          Number(row.stream_version),
          typeof row.metadata === 'string' ? row.metadata : JSON.stringify(row.metadata || {})
        )
      )

      // Get snapshot if exists
      const snapshotResult = await client.query(
        `SELECT snapshot_type, snapshot_type_version, snapshot_data, snapshot_version
         FROM snapshots WHERE stream_name = $1`,
        [streamName]
      )

      let snapshot: State<unknown> | null = null
      if (snapshotResult.rows.length > 0) {
        const snapRow = snapshotResult.rows[0]
        const snapData = typeof snapRow.snapshot_data === 'string'
          ? JSON.parse(snapRow.snapshot_data)
          : snapRow.snapshot_data
        snapshot = new ObjectState(
          streamName,
          snapRow.snapshot_type, // Use stored type name (string)
          snapRow.snapshot_type_version,
          snapData,
          Number(snapRow.snapshot_version)
        )
      }

      // Cast entries to Entry<T>[] - TextEntry extends Entry<string> and T is typically string
      return new EntryStream<T>(streamName, currentVersion, entries as unknown as Entry<T>[], snapshot, false, false)
    } finally {
      client.release()
    }
  }
}
