// Copyright © 2012-2025 Vaughn Vernon. All rights reserved.
// Copyright © 2012-2025 Kalele, Inc. All rights reserved.
//
// Licensed under the Reciprocal Public License 1.5
//
// See: LICENSE.md in repository root directory
// See: https://opensource.org/license/rpl-1-5

import { Actor, Protocol, Definition } from 'domo-actors'
import {
  Journal,
  AppendResult,
  StreamReader,
  JournalReader,
  Outcome,
  StreamState,
  StreamInfo,
  DefaultStreamInfo,
  TombstoneResult,
  DeleteResult,
  TruncateResult
} from 'domo-tactical/store/journal'
import {
  Result,
  Source,
  Metadata,
  EntryAdapterProvider
} from 'domo-tactical/store'
import { Pool, PoolClient } from 'pg'
import { ulid } from 'ulid'
import { PostgresConfig } from './PostgresConfig.js'
import { PostgresStreamReader } from './PostgresStreamReader.js'
import { PostgresJournalReader } from './PostgresJournalReader.js'

/**
 * PostgreSQL implementation of Journal.
 *
 * Stores journal entries, snapshots, and stream metadata in PostgreSQL tables.
 * Implements optimistic concurrency control using stream versions.
 *
 * @template T the type of entry data (typically string for JSON)
 *
 * @example
 * ```typescript
 * const config = PostgresConfig.create({
 *   host: 'localhost',
 *   database: 'mydb',
 *   user: 'user',
 *   password: 'pass'
 * })
 *
 * const journal = new PostgresJournal(config)
 *
 * // Append an event
 * const result = await journal.append(
 *   'account-123',
 *   StreamState.NoStream,
 *   new AccountOpened('123', 'Alice', 1000),
 *   Metadata.nullMetadata()
 * )
 * ```
 */
export class PostgresJournal<T> extends Actor implements Journal<T> {
  private readonly pool: Pool
  private readonly streamReaders: Map<string, PostgresStreamReader<T>> = new Map()
  private readonly journalReaders: Map<string, PostgresJournalReader<T>> = new Map()
  private readonly adapterProvider = EntryAdapterProvider.instance()

  constructor(config: PostgresConfig) {
    super()
    this.pool = config.getPool()
  }

  async append<S, ST>(
    streamName: string,
    streamVersion: number,
    source: Source<S>,
    metadata: Metadata
  ): Promise<AppendResult<S, ST>> {
    return this.appendWith(streamName, streamVersion, source, metadata, null as ST)
  }

  async appendWith<S, ST>(
    streamName: string,
    streamVersion: number,
    source: Source<S>,
    metadata: Metadata,
    snapshot: ST | null
  ): Promise<AppendResult<S, ST>> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      // Check tombstone status
      const tombstoneCheck = await this.checkTombstone(client, streamName)
      if (tombstoneCheck) {
        await client.query('ROLLBACK')
        return AppendResult.forSource<S, ST>(
          Outcome.success(Result.StreamDeleted),
          streamName,
          streamVersion,
          source,
          snapshot
        )
      }

      // Get or create stream
      const currentVersion = await this.getOrCreateStream(client, streamName)

      // Validate expected version
      const validationResult = this.validateExpectedVersion(currentVersion, streamVersion)
      if (validationResult !== null) {
        await client.query('ROLLBACK')
        return AppendResult.forSource<S, ST>(validationResult, streamName, streamVersion, source, snapshot)
      }

      // Clear soft-delete if reopening
      await this.clearSoftDelete(client, streamName)

      // Calculate actual version
      const actualVersion = this.resolveActualVersion(currentVersion, streamVersion)

      // Insert entry
      const entryId = ulid()
      const entry = this.adapterProvider.asEntry(source, actualVersion, metadata)

      await client.query(
        `INSERT INTO journal_entries
         (entry_id, stream_name, stream_version, entry_type, entry_type_version, entry_data, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entryId,
          streamName,
          actualVersion,
          entry.type,
          entry.typeVersion,
          entry.entryData,
          entry.metadata
        ]
      )

      // Update stream version
      await client.query(
        `UPDATE streams SET current_version = $1, updated_at = NOW() WHERE stream_name = $2`,
        [actualVersion, streamName]
      )

      // Save snapshot if provided
      if (snapshot !== null) {
        await this.saveSnapshot(client, streamName, snapshot, actualVersion)
      }

      await client.query('COMMIT')
      return AppendResult.forSource<S, ST>(
        Outcome.success(Result.Success),
        streamName,
        actualVersion,
        source,
        snapshot
      )
    } catch (error) {
      await client.query('ROLLBACK')
      // Check if this is a unique constraint violation (concurrency)
      if ((error as Error).message?.includes('unique') || (error as Error).message?.includes('duplicate')) {
        return AppendResult.forSource<S, ST>(
          Outcome.success(Result.ConcurrencyViolation),
          streamName,
          streamVersion,
          source,
          snapshot
        )
      }
      throw error
    } finally {
      client.release()
    }
  }

  async appendAll<S, ST>(
    streamName: string,
    fromStreamVersion: number,
    sources: Source<S>[],
    metadata: Metadata
  ): Promise<AppendResult<S, ST>> {
    return this.appendAllWith(streamName, fromStreamVersion, sources, metadata, null as ST)
  }

  async appendAllWith<S, ST>(
    streamName: string,
    fromStreamVersion: number,
    sources: Source<S>[],
    metadata: Metadata,
    snapshot: ST | null
  ): Promise<AppendResult<S, ST>> {
    if (sources.length === 0) {
      return AppendResult.forSources<S, ST>(
        Outcome.success(Result.Success),
        streamName,
        fromStreamVersion - 1,
        sources,
        snapshot
      )
    }

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      // Check tombstone status
      const tombstoneCheck = await this.checkTombstone(client, streamName)
      if (tombstoneCheck) {
        await client.query('ROLLBACK')
        return AppendResult.forSources<S, ST>(
          Outcome.success(Result.StreamDeleted),
          streamName,
          fromStreamVersion,
          sources,
          snapshot
        )
      }

      // Get or create stream
      const currentVersion = await this.getOrCreateStream(client, streamName)

      // Validate expected version
      const validationResult = this.validateExpectedVersion(currentVersion, fromStreamVersion)
      if (validationResult !== null) {
        await client.query('ROLLBACK')
        return AppendResult.forSources<S, ST>(validationResult, streamName, fromStreamVersion, sources, snapshot)
      }

      // Clear soft-delete if reopening
      await this.clearSoftDelete(client, streamName)

      // Calculate actual starting version
      const actualFromVersion = this.resolveActualVersion(currentVersion, fromStreamVersion)

      // Insert all entries
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i]
        const version = actualFromVersion + i
        const entryId = ulid()
        const entry = this.adapterProvider.asEntry(source, version, metadata)

        await client.query(
          `INSERT INTO journal_entries
           (entry_id, stream_name, stream_version, entry_type, entry_type_version, entry_data, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            entryId,
            streamName,
            version,
            entry.type,
            entry.typeVersion,
            entry.entryData,
            entry.metadata
          ]
        )
      }

      const finalVersion = actualFromVersion + sources.length - 1

      // Update stream version
      await client.query(
        `UPDATE streams SET current_version = $1, updated_at = NOW() WHERE stream_name = $2`,
        [finalVersion, streamName]
      )

      // Save snapshot if provided
      if (snapshot !== null) {
        await this.saveSnapshot(client, streamName, snapshot, finalVersion)
      }

      await client.query('COMMIT')
      return AppendResult.forSources<S, ST>(
        Outcome.success(Result.Success),
        streamName,
        finalVersion,
        sources,
        snapshot
      )
    } catch (error) {
      await client.query('ROLLBACK')
      if ((error as Error).message?.includes('unique') || (error as Error).message?.includes('duplicate')) {
        return AppendResult.forSources<S, ST>(
          Outcome.success(Result.ConcurrencyViolation),
          streamName,
          fromStreamVersion,
          sources,
          snapshot
        )
      }
      throw error
    } finally {
      client.release()
    }
  }

  async streamReader(name: string): Promise<StreamReader<T>> {
    const existingReader = this.streamReaders.get(name)
    if (existingReader) {
      return existingReader
    }

    const readerProtocol: Protocol = {
      type: () => 'StreamReader',
      instantiator: () => ({
        instantiate: (def: Definition) => {
          const [pool, readerName] = def.parameters()
          return new PostgresStreamReader(pool, readerName)
        }
      })
    }

    const reader = this.stage().actorFor<PostgresStreamReader<T>>(
      readerProtocol,
      undefined,
      this.supervisorName(),
      undefined,
      this.pool,
      name
    )
    this.streamReaders.set(name, reader)
    return reader
  }

  async journalReader(name: string): Promise<JournalReader<T>> {
    const existingReader = this.journalReaders.get(name)
    if (existingReader) {
      return existingReader
    }

    const readerProtocol: Protocol = {
      type: () => 'JournalReader',
      instantiator: () => ({
        instantiate: (def: Definition) => {
          const [pool, readerName] = def.parameters()
          return new PostgresJournalReader(pool, readerName)
        }
      })
    }

    const reader = this.stage().actorFor<PostgresJournalReader<T>>(
      readerProtocol,
      undefined,
      this.supervisorName(),
      undefined,
      this.pool,
      name
    )
    this.journalReaders.set(name, reader)
    return reader
  }

  async tombstone(streamName: string): Promise<TombstoneResult> {
    const client = await this.pool.connect()
    try {
      // Check current state
      const result = await client.query(
        `SELECT current_version, is_tombstoned FROM streams WHERE stream_name = $1`,
        [streamName]
      )

      if (result.rows.length === 0) {
        return TombstoneResult.notFound(streamName)
      }

      const row = result.rows[0]
      if (row.is_tombstoned) {
        return TombstoneResult.alreadyTombstoned(streamName)
      }

      // Get journal position
      const posResult = await client.query(
        `SELECT COALESCE(MAX(global_position), 0) as position FROM journal_entries`
      )
      const journalPosition = Number(posResult.rows[0].position)

      // Mark as tombstoned
      await client.query(
        `UPDATE streams
         SET is_tombstoned = TRUE, is_soft_deleted = FALSE, updated_at = NOW()
         WHERE stream_name = $1`,
        [streamName]
      )

      return TombstoneResult.success(streamName, journalPosition)
    } finally {
      client.release()
    }
  }

  async softDelete(streamName: string): Promise<DeleteResult> {
    const client = await this.pool.connect()
    try {
      const result = await client.query(
        `SELECT current_version, is_tombstoned, is_soft_deleted, deleted_at_version
         FROM streams WHERE stream_name = $1`,
        [streamName]
      )

      if (result.rows.length === 0) {
        return DeleteResult.notFound(streamName)
      }

      const row = result.rows[0]
      if (row.is_tombstoned) {
        return DeleteResult.tombstoned(streamName)
      }

      if (row.is_soft_deleted) {
        return DeleteResult.alreadyDeleted(streamName, Number(row.deleted_at_version))
      }

      const currentVersion = Number(row.current_version)

      await client.query(
        `UPDATE streams
         SET is_soft_deleted = TRUE, deleted_at_version = $1, updated_at = NOW()
         WHERE stream_name = $2`,
        [currentVersion, streamName]
      )

      return DeleteResult.success(streamName, currentVersion)
    } finally {
      client.release()
    }
  }

  async truncateBefore(streamName: string, beforeVersion: number): Promise<TruncateResult> {
    const client = await this.pool.connect()
    try {
      const result = await client.query(
        `SELECT is_tombstoned FROM streams WHERE stream_name = $1`,
        [streamName]
      )

      if (result.rows.length === 0) {
        return TruncateResult.notFound(streamName)
      }

      if (result.rows[0].is_tombstoned) {
        return TruncateResult.tombstoned(streamName)
      }

      await client.query(
        `UPDATE streams SET truncate_before = $1, updated_at = NOW() WHERE stream_name = $2`,
        [beforeVersion, streamName]
      )

      return TruncateResult.success(streamName, beforeVersion)
    } finally {
      client.release()
    }
  }

  async streamInfo(streamName: string): Promise<StreamInfo> {
    const client = await this.pool.connect()
    try {
      const result = await client.query(
        `SELECT current_version, is_tombstoned, is_soft_deleted, truncate_before
         FROM streams WHERE stream_name = $1`,
        [streamName]
      )

      if (result.rows.length === 0) {
        return DefaultStreamInfo.notFound(streamName)
      }

      const row = result.rows[0]
      const currentVersion = Number(row.current_version)
      const truncateBefore = Number(row.truncate_before)

      if (row.is_tombstoned) {
        return DefaultStreamInfo.tombstoned(streamName, currentVersion)
      }

      if (row.is_soft_deleted) {
        return DefaultStreamInfo.softDeleted(streamName, currentVersion)
      }

      // Count visible entries
      const countResult = await client.query(
        `SELECT COUNT(*) as count FROM journal_entries
         WHERE stream_name = $1 AND stream_version >= $2`,
        [streamName, truncateBefore]
      )
      const entryCount = Number(countResult.rows[0].count)

      return DefaultStreamInfo.active(streamName, currentVersion, truncateBefore, entryCount)
    } finally {
      client.release()
    }
  }

  // Private helpers

  private supervisorName(): string {
    return this.lifeCycle().environment().supervisorName()
  }

  private async checkTombstone(client: PoolClient, streamName: string): Promise<boolean> {
    const result = await client.query(
      `SELECT is_tombstoned FROM streams WHERE stream_name = $1`,
      [streamName]
    )
    return result.rows.length > 0 && result.rows[0].is_tombstoned
  }

  private async getOrCreateStream(client: PoolClient, streamName: string): Promise<number> {
    // Try to get existing stream
    const result = await client.query(
      `SELECT current_version FROM streams WHERE stream_name = $1 FOR UPDATE`,
      [streamName]
    )

    if (result.rows.length > 0) {
      return Number(result.rows[0].current_version)
    }

    // Create new stream
    await client.query(
      `INSERT INTO streams (stream_name, current_version) VALUES ($1, 0)`,
      [streamName]
    )
    return 0
  }

  private async clearSoftDelete(client: PoolClient, streamName: string): Promise<void> {
    await client.query(
      `UPDATE streams
       SET is_soft_deleted = FALSE, deleted_at_version = NULL
       WHERE stream_name = $1 AND is_soft_deleted = TRUE`,
      [streamName]
    )
  }

  private async saveSnapshot<ST>(
    client: PoolClient,
    streamName: string,
    snapshot: ST,
    version: number
  ): Promise<void> {
    let snapshotType: string
    let snapshotTypeVersion: number
    let snapshotData: unknown

    // Check if snapshot is a State instance by checking for the required properties
    const maybeState = snapshot as { type?: string; typeVersion?: number; data?: unknown }
    if (maybeState.type !== undefined && maybeState.typeVersion !== undefined && maybeState.data !== undefined) {
      snapshotType = maybeState.type
      snapshotTypeVersion = maybeState.typeVersion
      snapshotData = maybeState.data
    } else {
      snapshotType = 'Object'
      snapshotTypeVersion = 1
      snapshotData = snapshot
    }

    await client.query(
      `INSERT INTO snapshots (stream_name, snapshot_type, snapshot_type_version, snapshot_data, snapshot_version)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (stream_name)
       DO UPDATE SET snapshot_type = $2, snapshot_type_version = $3, snapshot_data = $4, snapshot_version = $5, created_at = NOW()`,
      [streamName, snapshotType, snapshotTypeVersion, JSON.stringify(snapshotData), version]
    )
  }

  private validateExpectedVersion(currentVersion: number, expectedVersion: number): Outcome<never, Result> | null {
    if (StreamState.isAny(expectedVersion)) {
      return null
    }

    if (StreamState.isNoStream(expectedVersion)) {
      if (currentVersion > 0) {
        return Outcome.success(Result.ConcurrencyViolation)
      }
      return null
    }

    if (StreamState.isStreamExists(expectedVersion)) {
      if (currentVersion === 0) {
        return Outcome.success(Result.ConcurrencyViolation)
      }
      return null
    }

    if (StreamState.isConcreteVersion(expectedVersion)) {
      const expectedCurrentVersion = expectedVersion - 1
      if (expectedCurrentVersion !== currentVersion) {
        return Outcome.success(Result.ConcurrencyViolation)
      }
    }

    return null
  }

  private resolveActualVersion(currentVersion: number, expectedVersion: number): number {
    if (StreamState.isSpecialState(expectedVersion)) {
      return currentVersion + 1
    }
    return expectedVersion
  }
}
