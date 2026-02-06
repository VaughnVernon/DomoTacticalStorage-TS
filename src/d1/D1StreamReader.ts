// Copyright © 2012-2025 Vaughn Vernon. All rights reserved.
// Copyright © 2012-2025 Kalele, Inc. All rights reserved.
//
// Licensed under the Reciprocal Public License 1.5
//
// See: LICENSE.md in repository root directory
// See: https://opensource.org/license/rpl-1-5

import { Actor } from 'domo-actors'
import { StreamReader, EntryStream } from 'domo-tactical/store/journal'
import { State, ObjectState, Entry, TextEntry } from 'domo-tactical/store'

/**
 * Cloudflare D1 implementation of StreamReader.
 *
 * Reads entries and snapshots for a specific stream from D1/SQLite.
 *
 * @template T the type of entry data (typically string for JSON)
 */
export class D1StreamReader<T> extends Actor implements StreamReader<T> {
  private readonly db: D1Database
  // Reader name stored for debugging/logging purposes
  private readonly _readerName: string

  constructor(db: D1Database, name: string) {
    super()
    this.db = db
    this._readerName = name
  }

  async streamFor(streamName: string): Promise<EntryStream<T>> {
    // Get stream metadata
    const streamResult = await this.db.prepare(
      `SELECT current_version, is_tombstoned, is_soft_deleted, deleted_at_version, truncate_before
       FROM streams WHERE stream_name = ?`
    ).bind(streamName).first<{
      current_version: number
      is_tombstoned: number
      is_soft_deleted: number
      deleted_at_version: number | null
      truncate_before: number
    }>()

    if (!streamResult) {
      return EntryStream.empty<T>(streamName)
    }

    const currentVersion = streamResult.current_version
    const truncateBefore = streamResult.truncate_before

    // Check tombstone
    if (streamResult.is_tombstoned) {
      return EntryStream.tombstoned<T>(streamName, currentVersion)
    }

    // Check soft-delete
    if (streamResult.is_soft_deleted) {
      return EntryStream.softDeleted<T>(streamName, streamResult.deleted_at_version!)
    }

    // Get entries respecting truncate-before
    const entriesResult = await this.db.prepare(
      `SELECT global_position, entry_id, entry_type, entry_type_version, entry_data, stream_version, metadata
       FROM journal_entries
       WHERE stream_name = ? AND stream_version >= ?
       ORDER BY stream_version ASC`
    ).bind(streamName, truncateBefore).all<{
      global_position: number
      entry_id: string
      entry_type: string
      entry_type_version: number
      entry_data: string
      stream_version: number
      metadata: string | null
    }>()

    const entries: TextEntry[] = (entriesResult.results || []).map((row) =>
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

    // Get snapshot if exists
    const snapshotResult = await this.db.prepare(
      `SELECT snapshot_type, snapshot_type_version, snapshot_data, snapshot_version
       FROM snapshots WHERE stream_name = ?`
    ).bind(streamName).first<{
      snapshot_type: string
      snapshot_type_version: number
      snapshot_data: string
      snapshot_version: number
    }>()

    let snapshot: State<unknown> | null = null
    if (snapshotResult) {
      const snapData = JSON.parse(snapshotResult.snapshot_data)
      snapshot = new ObjectState(
        streamName,
        snapshotResult.snapshot_type, // Use stored type name (string)
        snapshotResult.snapshot_type_version,
        snapData,
        snapshotResult.snapshot_version
      )
    }

    // Cast entries to Entry<T>[] - TextEntry extends Entry<string> and T is typically string
    return new EntryStream<T>(streamName, currentVersion, entries as unknown as Entry<T>[], snapshot, false, false)
  }
}
