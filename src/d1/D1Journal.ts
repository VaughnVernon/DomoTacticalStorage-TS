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
import { ulid } from 'ulid'
import { D1Config } from './D1Config.js'
import { D1StreamReader } from './D1StreamReader.js'
import { D1JournalReader } from './D1JournalReader.js'

/**
 * Cloudflare D1 implementation of Journal.
 *
 * Stores journal entries, snapshots, and stream metadata in D1/SQLite tables.
 * Uses batch operations for atomicity since D1 doesn't support true transactions.
 *
 * @template T the type of entry data (typically string for JSON)
 *
 * @example
 * ```typescript
 * // In a Cloudflare Worker
 * const config = D1Config.create(env.DB)
 * const journal = new D1Journal(config)
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
export class D1Journal<T> extends Actor implements Journal<T> {
  private readonly db: D1Database
  private readonly streamReaders: Map<string, D1StreamReader<T>> = new Map()
  private readonly journalReaders: Map<string, D1JournalReader<T>> = new Map()
  private readonly adapterProvider = EntryAdapterProvider.instance()

  constructor(config: D1Config) {
    super()
    this.db = config.getDatabase()
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
    try {
      // Check tombstone status
      const tombstoneCheck = await this.checkTombstone(streamName)
      if (tombstoneCheck) {
        return AppendResult.forSource<S, ST>(
          Outcome.success(Result.StreamDeleted),
          streamName,
          streamVersion,
          source,
          snapshot
        )
      }

      // Get or create stream and validate version
      const currentVersion = await this.getOrCreateStream(streamName)

      // Validate expected version
      const validationResult = this.validateExpectedVersion(currentVersion, streamVersion)
      if (validationResult !== null) {
        return AppendResult.forSource<S, ST>(validationResult, streamName, streamVersion, source, snapshot)
      }

      // Calculate actual version
      const actualVersion = this.resolveActualVersion(currentVersion, streamVersion)

      // Prepare entry
      const entryId = ulid()
      const entry = this.adapterProvider.asEntry(source, actualVersion, metadata)

      // Build batch operations
      const statements: D1PreparedStatement[] = []

      // Clear soft-delete if reopening
      statements.push(
        this.db.prepare(
          `UPDATE streams SET is_soft_deleted = 0, deleted_at_version = NULL WHERE stream_name = ? AND is_soft_deleted = 1`
        ).bind(streamName)
      )

      // Insert entry
      statements.push(
        this.db.prepare(
          `INSERT INTO journal_entries
           (entry_id, stream_name, stream_version, entry_type, entry_type_version, entry_data, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          entryId,
          streamName,
          actualVersion,
          entry.type,
          entry.typeVersion,
          typeof entry.entryData === 'string' ? entry.entryData : JSON.stringify(entry.entryData),
          entry.metadata
        )
      )

      // Update stream version
      statements.push(
        this.db.prepare(
          `UPDATE streams SET current_version = ?, updated_at = datetime('now') WHERE stream_name = ?`
        ).bind(actualVersion, streamName)
      )

      // Save snapshot if provided
      if (snapshot !== null) {
        const snapshotStmt = this.buildSnapshotStatement(streamName, snapshot, actualVersion)
        statements.push(snapshotStmt)
      }

      // Execute batch
      await this.db.batch(statements)

      return AppendResult.forSource<S, ST>(
        Outcome.success(Result.Success),
        streamName,
        actualVersion,
        source,
        snapshot
      )
    } catch (error) {
      // Check for unique constraint violation (concurrency)
      const errorMsg = (error as Error).message || ''
      if (errorMsg.includes('UNIQUE') || errorMsg.includes('constraint')) {
        return AppendResult.forSource<S, ST>(
          Outcome.success(Result.ConcurrencyViolation),
          streamName,
          streamVersion,
          source,
          snapshot
        )
      }
      throw error
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

    try {
      // Check tombstone status
      const tombstoneCheck = await this.checkTombstone(streamName)
      if (tombstoneCheck) {
        return AppendResult.forSources<S, ST>(
          Outcome.success(Result.StreamDeleted),
          streamName,
          fromStreamVersion,
          sources,
          snapshot
        )
      }

      // Get or create stream
      const currentVersion = await this.getOrCreateStream(streamName)

      // Validate expected version
      const validationResult = this.validateExpectedVersion(currentVersion, fromStreamVersion)
      if (validationResult !== null) {
        return AppendResult.forSources<S, ST>(validationResult, streamName, fromStreamVersion, sources, snapshot)
      }

      // Calculate actual starting version
      const actualFromVersion = this.resolveActualVersion(currentVersion, fromStreamVersion)

      // Build batch operations
      const statements: D1PreparedStatement[] = []

      // Clear soft-delete if reopening
      statements.push(
        this.db.prepare(
          `UPDATE streams SET is_soft_deleted = 0, deleted_at_version = NULL WHERE stream_name = ? AND is_soft_deleted = 1`
        ).bind(streamName)
      )

      // Insert all entries
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i]
        const version = actualFromVersion + i
        const entryId = ulid()
        const entry = this.adapterProvider.asEntry(source, version, metadata)

        statements.push(
          this.db.prepare(
            `INSERT INTO journal_entries
             (entry_id, stream_name, stream_version, entry_type, entry_type_version, entry_data, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            entryId,
            streamName,
            version,
            entry.type,
            entry.typeVersion,
            typeof entry.entryData === 'string' ? entry.entryData : JSON.stringify(entry.entryData),
            entry.metadata
          )
        )
      }

      const finalVersion = actualFromVersion + sources.length - 1

      // Update stream version
      statements.push(
        this.db.prepare(
          `UPDATE streams SET current_version = ?, updated_at = datetime('now') WHERE stream_name = ?`
        ).bind(finalVersion, streamName)
      )

      // Save snapshot if provided
      if (snapshot !== null) {
        const snapshotStmt = this.buildSnapshotStatement(streamName, snapshot, finalVersion)
        statements.push(snapshotStmt)
      }

      // Execute batch
      await this.db.batch(statements)

      return AppendResult.forSources<S, ST>(
        Outcome.success(Result.Success),
        streamName,
        finalVersion,
        sources,
        snapshot
      )
    } catch (error) {
      const errorMsg = (error as Error).message || ''
      if (errorMsg.includes('UNIQUE') || errorMsg.includes('constraint')) {
        return AppendResult.forSources<S, ST>(
          Outcome.success(Result.ConcurrencyViolation),
          streamName,
          fromStreamVersion,
          sources,
          snapshot
        )
      }
      throw error
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
          const [db, readerName] = def.parameters()
          return new D1StreamReader(db, readerName)
        }
      })
    }

    const reader = this.stage().actorFor<D1StreamReader<T>>(
      readerProtocol,
      undefined,
      this.supervisorName(),
      undefined,
      this.db,
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
          const [db, readerName] = def.parameters()
          return new D1JournalReader(db, readerName)
        }
      })
    }

    const reader = this.stage().actorFor<D1JournalReader<T>>(
      readerProtocol,
      undefined,
      this.supervisorName(),
      undefined,
      this.db,
      name
    )
    this.journalReaders.set(name, reader)
    return reader
  }

  async tombstone(streamName: string): Promise<TombstoneResult> {
    // Check current state
    const result = await this.db.prepare(
      `SELECT current_version, is_tombstoned FROM streams WHERE stream_name = ?`
    ).bind(streamName).first<{ current_version: number; is_tombstoned: number }>()

    if (!result) {
      return TombstoneResult.notFound(streamName)
    }

    if (result.is_tombstoned) {
      return TombstoneResult.alreadyTombstoned(streamName)
    }

    // Get journal position
    const posResult = await this.db.prepare(
      `SELECT COALESCE(MAX(global_position), 0) as position FROM journal_entries`
    ).first<{ position: number }>()
    const journalPosition = posResult?.position ?? 0

    // Mark as tombstoned
    await this.db.prepare(
      `UPDATE streams SET is_tombstoned = 1, is_soft_deleted = 0, updated_at = datetime('now') WHERE stream_name = ?`
    ).bind(streamName).run()

    return TombstoneResult.success(streamName, journalPosition)
  }

  async softDelete(streamName: string): Promise<DeleteResult> {
    const result = await this.db.prepare(
      `SELECT current_version, is_tombstoned, is_soft_deleted, deleted_at_version
       FROM streams WHERE stream_name = ?`
    ).bind(streamName).first<{
      current_version: number
      is_tombstoned: number
      is_soft_deleted: number
      deleted_at_version: number | null
    }>()

    if (!result) {
      return DeleteResult.notFound(streamName)
    }

    if (result.is_tombstoned) {
      return DeleteResult.tombstoned(streamName)
    }

    if (result.is_soft_deleted) {
      return DeleteResult.alreadyDeleted(streamName, result.deleted_at_version!)
    }

    const currentVersion = result.current_version

    await this.db.prepare(
      `UPDATE streams SET is_soft_deleted = 1, deleted_at_version = ?, updated_at = datetime('now') WHERE stream_name = ?`
    ).bind(currentVersion, streamName).run()

    return DeleteResult.success(streamName, currentVersion)
  }

  async truncateBefore(streamName: string, beforeVersion: number): Promise<TruncateResult> {
    const result = await this.db.prepare(
      `SELECT is_tombstoned FROM streams WHERE stream_name = ?`
    ).bind(streamName).first<{ is_tombstoned: number }>()

    if (!result) {
      return TruncateResult.notFound(streamName)
    }

    if (result.is_tombstoned) {
      return TruncateResult.tombstoned(streamName)
    }

    await this.db.prepare(
      `UPDATE streams SET truncate_before = ?, updated_at = datetime('now') WHERE stream_name = ?`
    ).bind(beforeVersion, streamName).run()

    return TruncateResult.success(streamName, beforeVersion)
  }

  async streamInfo(streamName: string): Promise<StreamInfo> {
    const result = await this.db.prepare(
      `SELECT current_version, is_tombstoned, is_soft_deleted, truncate_before
       FROM streams WHERE stream_name = ?`
    ).bind(streamName).first<{
      current_version: number
      is_tombstoned: number
      is_soft_deleted: number
      truncate_before: number
    }>()

    if (!result) {
      return DefaultStreamInfo.notFound(streamName)
    }

    const currentVersion = result.current_version
    const truncateBefore = result.truncate_before

    if (result.is_tombstoned) {
      return DefaultStreamInfo.tombstoned(streamName, currentVersion)
    }

    if (result.is_soft_deleted) {
      return DefaultStreamInfo.softDeleted(streamName, currentVersion)
    }

    // Count visible entries
    const countResult = await this.db.prepare(
      `SELECT COUNT(*) as count FROM journal_entries WHERE stream_name = ? AND stream_version >= ?`
    ).bind(streamName, truncateBefore).first<{ count: number }>()
    const entryCount = countResult?.count ?? 0

    return DefaultStreamInfo.active(streamName, currentVersion, truncateBefore, entryCount)
  }

  // Private helpers

  private supervisorName(): string {
    return this.lifeCycle().environment().supervisorName()
  }

  private async checkTombstone(streamName: string): Promise<boolean> {
    const result = await this.db.prepare(
      `SELECT is_tombstoned FROM streams WHERE stream_name = ?`
    ).bind(streamName).first<{ is_tombstoned: number }>()
    return result !== null && result.is_tombstoned === 1
  }

  private async getOrCreateStream(streamName: string): Promise<number> {
    // Try to get existing stream
    const result = await this.db.prepare(
      `SELECT current_version FROM streams WHERE stream_name = ?`
    ).bind(streamName).first<{ current_version: number }>()

    if (result) {
      return result.current_version
    }

    // Create new stream
    await this.db.prepare(
      `INSERT INTO streams (stream_name, current_version) VALUES (?, 0)`
    ).bind(streamName).run()
    return 0
  }

  private buildSnapshotStatement<ST>(streamName: string, snapshot: ST, version: number): D1PreparedStatement {
    let snapshotType: string
    let snapshotTypeVersion: number
    let snapshotData: string

    // Check if snapshot is a State instance by checking for the required properties
    const maybeState = snapshot as { type?: string; typeVersion?: number; data?: unknown }
    if (maybeState.type !== undefined && maybeState.typeVersion !== undefined && maybeState.data !== undefined) {
      snapshotType = maybeState.type
      snapshotTypeVersion = maybeState.typeVersion
      snapshotData = JSON.stringify(maybeState.data)
    } else {
      snapshotType = 'Object'
      snapshotTypeVersion = 1
      snapshotData = JSON.stringify(snapshot)
    }

    return this.db.prepare(
      `INSERT INTO snapshots (stream_name, snapshot_type, snapshot_type_version, snapshot_data, snapshot_version)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (stream_name)
       DO UPDATE SET snapshot_type = ?, snapshot_type_version = ?, snapshot_data = ?, snapshot_version = ?, created_at = datetime('now')`
    ).bind(
      streamName,
      snapshotType,
      snapshotTypeVersion,
      snapshotData,
      version,
      snapshotType,
      snapshotTypeVersion,
      snapshotData,
      version
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
