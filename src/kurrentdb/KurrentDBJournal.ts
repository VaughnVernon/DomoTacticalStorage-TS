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
import {
  KurrentDBClient,
  jsonEvent,
  END,
  BACKWARDS,
  StreamNotFoundError,
  WrongExpectedVersionError,
  StreamDeletedError,
  NO_STREAM,
  ANY,
  STREAM_EXISTS
} from '@kurrent/kurrentdb-client'
import type { AppendStreamState } from '@kurrent/kurrentdb-client'
import { v7 as uuidv7 } from 'uuid'
import { KurrentDBConfig } from './KurrentDBConfig.js'
import { KurrentDBStreamReader } from './KurrentDBStreamReader.js'
import { KurrentDBJournalReader } from './KurrentDBJournalReader.js'

/**
 * Snapshot metadata stored in EventStoreDB metadata stream.
 */
interface SnapshotMetadata {
  snapshotType: string
  snapshotTypeVersion: number
  snapshotVersion: number
  snapshotData: unknown
}

/**
 * KurrentDB/EventStoreDB implementation of Journal.
 *
 * Maps DomoTactical journal operations to EventStoreDB streams and events.
 * Uses EventStoreDB's built-in optimistic concurrency and stream lifecycle features.
 *
 * Key mappings:
 * - DomoTactical 1-based versions → EventStoreDB 0-based revisions
 * - StreamState.Any → ANY
 * - StreamState.NoStream → NO_STREAM
 * - StreamState.StreamExists → STREAM_EXISTS
 *
 * @template T the type of entry data (typically string for JSON)
 *
 * @example
 * ```typescript
 * const config = KurrentDBConfig.create({
 *   endpoint: 'localhost:2113',
 *   tls: false
 * })
 *
 * const journal = new KurrentDBJournal(config)
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
export class KurrentDBJournal<T> extends Actor implements Journal<T> {
  private readonly client: KurrentDBClient
  private readonly streamReaders: Map<string, KurrentDBStreamReader<T>> = new Map()
  private readonly journalReaders: Map<string, KurrentDBJournalReader<T>> = new Map()
  private readonly adapterProvider = EntryAdapterProvider.instance()

  /** Prefix for snapshot streams */
  private static readonly SNAPSHOT_STREAM_PREFIX = '$snapshot-'

  constructor(config: KurrentDBConfig) {
    super()
    this.client = config.getClient()
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
      // Convert source to entry format
      const entry = this.adapterProvider.asEntry(source, streamVersion, metadata)

      // Create EventStoreDB event
      const event = jsonEvent({
        id: uuidv7(),
        type: entry.type,
        data: typeof entry.entryData === 'string' ? JSON.parse(entry.entryData) : entry.entryData,
        metadata: {
          typeVersion: entry.typeVersion,
          metadata: entry.metadata
        }
      })

      // Convert DomoTactical version to EventStoreDB expected revision
      const streamState = this.toStreamState(streamVersion)

      // Append to stream
      const result = await this.client.appendToStream(streamName, event, {
        streamState
      })

      // Calculate actual version (KurrentDB returns 0-based revision, DomoTactical uses 1-based)
      const actualVersion = Number(result.nextExpectedRevision) + 1

      // Save snapshot if provided
      if (snapshot !== null) {
        await this.saveSnapshot(streamName, snapshot, actualVersion)
      }

      return AppendResult.forSource<S, ST>(
        Outcome.success(Result.Success),
        streamName,
        actualVersion,
        source,
        snapshot
      )
    } catch (error) {
      return this.handleAppendError(error, streamName, streamVersion, source, null, snapshot)
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
      // Create EventStoreDB events
      const events = sources.map((source, index) => {
        const entry = this.adapterProvider.asEntry(source, fromStreamVersion + index, metadata)
        return jsonEvent({
          id: uuidv7(),
          type: entry.type,
          data: typeof entry.entryData === 'string' ? JSON.parse(entry.entryData) : entry.entryData,
          metadata: {
            typeVersion: entry.typeVersion,
            metadata: entry.metadata
          }
        })
      })

      // Convert DomoTactical version to EventStoreDB expected revision
      const streamState = this.toStreamState(fromStreamVersion)

      // Append to stream
      const result = await this.client.appendToStream(streamName, events, {
        streamState
      })

      // Calculate actual final version (KurrentDB returns 0-based revision, DomoTactical uses 1-based)
      const finalVersion = Number(result.nextExpectedRevision) + 1

      // Save snapshot if provided
      if (snapshot !== null) {
        await this.saveSnapshot(streamName, snapshot, finalVersion)
      }

      return AppendResult.forSources<S, ST>(
        Outcome.success(Result.Success),
        streamName,
        finalVersion,
        sources,
        snapshot
      )
    } catch (error) {
      return this.handleAppendError(error, streamName, fromStreamVersion, null, sources, snapshot)
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
          const [client, readerName] = def.parameters()
          return new KurrentDBStreamReader(client, readerName)
        }
      })
    }

    const reader = this.stage().actorFor<KurrentDBStreamReader<T>>(
      readerProtocol,
      undefined,
      this.supervisorName(),
      undefined,
      this.client,
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
          const [client, readerName] = def.parameters()
          return new KurrentDBJournalReader(client, readerName)
        }
      })
    }

    const reader = this.stage().actorFor<KurrentDBJournalReader<T>>(
      readerProtocol,
      undefined,
      this.supervisorName(),
      undefined,
      this.client,
      name
    )
    this.journalReaders.set(name, reader)
    return reader
  }

  async tombstone(streamName: string): Promise<TombstoneResult> {
    try {
      // Get current stream state first
      const events = this.client.readStream(streamName, {
        direction: BACKWARDS,
        fromRevision: END,
        maxCount: 1
      })

      let hasEvents = false
      for await (const _ of events) {
        hasEvents = true
        break
      }

      if (!hasEvents) {
        return TombstoneResult.notFound(streamName)
      }

      // Tombstone the stream (hard delete in EventStoreDB)
      await this.client.tombstoneStream(streamName)

      return TombstoneResult.success(streamName, 0) // EventStoreDB doesn't give us position
    } catch (error) {
      if (error instanceof StreamNotFoundError) {
        return TombstoneResult.notFound(streamName)
      }
      if (error instanceof StreamDeletedError) {
        return TombstoneResult.alreadyTombstoned(streamName)
      }
      throw error
    }
  }

  async softDelete(streamName: string): Promise<DeleteResult> {
    try {
      // Get current version
      const events = this.client.readStream(streamName, {
        direction: BACKWARDS,
        fromRevision: END,
        maxCount: 1
      })

      let currentVersion = 0
      for await (const event of events) {
        currentVersion = Number(event.event?.revision ?? 0) + 1
        break
      }

      if (currentVersion === 0) {
        return DeleteResult.notFound(streamName)
      }

      // Soft delete the stream
      await this.client.deleteStream(streamName)

      return DeleteResult.success(streamName, currentVersion)
    } catch (error) {
      if (error instanceof StreamNotFoundError) {
        return DeleteResult.notFound(streamName)
      }
      if (error instanceof StreamDeletedError) {
        return DeleteResult.tombstoned(streamName)
      }
      throw error
    }
  }

  async truncateBefore(streamName: string, beforeVersion: number): Promise<TruncateResult> {
    try {
      // Check stream exists and isn't deleted
      const events = this.client.readStream(streamName, {
        direction: BACKWARDS,
        fromRevision: END,
        maxCount: 1
      })

      let exists = false
      for await (const _ of events) {
        exists = true
        break
      }

      if (!exists) {
        return TruncateResult.notFound(streamName)
      }

      // Set $tb (truncate before) metadata
      // Convert 1-based version to 0-based revision
      const truncateBeforeRevision = beforeVersion - 1

      await this.client.setStreamMetadata(streamName, {
        truncateBefore: truncateBeforeRevision
      })

      return TruncateResult.success(streamName, beforeVersion)
    } catch (error) {
      if (error instanceof StreamNotFoundError) {
        return TruncateResult.notFound(streamName)
      }
      if (error instanceof StreamDeletedError) {
        return TruncateResult.tombstoned(streamName)
      }
      throw error
    }
  }

  async streamInfo(streamName: string): Promise<StreamInfo> {
    try {
      // Try to read the last event
      const events = this.client.readStream(streamName, {
        direction: BACKWARDS,
        fromRevision: END,
        maxCount: 1
      })

      let currentVersion = 0
      let exists = false
      for await (const event of events) {
        exists = true
        currentVersion = Number(event.event?.revision ?? 0) + 1
        break
      }

      if (!exists) {
        return DefaultStreamInfo.notFound(streamName)
      }

      // Get stream metadata for truncate-before
      let truncateBefore = 0
      try {
        const metadata = await this.client.getStreamMetadata(streamName)
        if (metadata.metadata?.truncateBefore !== undefined) {
          truncateBefore = Number(metadata.metadata.truncateBefore) + 1 // Convert to 1-based
        }
      } catch {
        // Metadata stream may not exist
      }

      // Count visible entries (estimate based on version - truncate)
      const entryCount = Math.max(0, currentVersion - truncateBefore)

      return DefaultStreamInfo.active(streamName, currentVersion, truncateBefore, entryCount)
    } catch (error) {
      if (error instanceof StreamNotFoundError) {
        return DefaultStreamInfo.notFound(streamName)
      }
      if (error instanceof StreamDeletedError) {
        // Check if tombstoned or soft-deleted
        // Tombstoned streams throw StreamDeletedError
        return DefaultStreamInfo.tombstoned(streamName, 0)
      }
      throw error
    }
  }

  // Private helpers

  private supervisorName(): string {
    return this.lifeCycle().environment().supervisorName()
  }

  /**
   * Convert DomoTactical expected version to KurrentDB stream state.
   *
   * DomoTactical uses 1-based versions, KurrentDB uses 0-based revisions.
   * Special states are mapped to KurrentDB constants.
   */
  private toStreamState(version: number): AppendStreamState {
    if (StreamState.isAny(version)) {
      return ANY
    }
    if (StreamState.isNoStream(version)) {
      return NO_STREAM
    }
    if (StreamState.isStreamExists(version)) {
      return STREAM_EXISTS
    }
    // Convert 1-based to 0-based: version 2 means we expect revision 0 (first event exists)
    return BigInt(version - 2)
  }

  private async saveSnapshot<ST>(streamName: string, snapshot: ST, version: number): Promise<void> {
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

    const snapshotStreamName = `${KurrentDBJournal.SNAPSHOT_STREAM_PREFIX}${streamName}`
    const snapshotEvent = jsonEvent({
      id: uuidv7(),
      type: 'Snapshot',
      data: {
        snapshotType,
        snapshotTypeVersion,
        snapshotVersion: version,
        snapshotData
      }
    })

    await this.client.appendToStream(snapshotStreamName, snapshotEvent, {
      streamState: ANY
    })
  }

  private handleAppendError<S, ST>(
    error: unknown,
    streamName: string,
    streamVersion: number,
    source: Source<S> | null,
    sources: Source<S>[] | null,
    snapshot: ST | null
  ): AppendResult<S, ST> {
    if (error instanceof WrongExpectedVersionError) {
      const outcome = Outcome.success<never, Result>(Result.ConcurrencyViolation)
      if (source !== null) {
        return AppendResult.forSource<S, ST>(outcome, streamName, streamVersion, source, snapshot)
      }
      return AppendResult.forSources<S, ST>(outcome, streamName, streamVersion, sources!, snapshot)
    }

    if (error instanceof StreamDeletedError) {
      const outcome = Outcome.success<never, Result>(Result.StreamDeleted)
      if (source !== null) {
        return AppendResult.forSource<S, ST>(outcome, streamName, streamVersion, source, snapshot)
      }
      return AppendResult.forSources<S, ST>(outcome, streamName, streamVersion, sources!, snapshot)
    }

    throw error
  }
}
