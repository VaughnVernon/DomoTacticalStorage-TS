// Copyright © 2012-2025 Vaughn Vernon. All rights reserved.
// Copyright © 2012-2025 Kalele, Inc. All rights reserved.
//
// Licensed under the Reciprocal Public License 1.5
//
// See: LICENSE.md in repository root directory
// See: https://opensource.org/license/rpl-1-5

import { Actor } from 'domo-actors'
import { StreamReader, EntryStream, Entry } from 'domo-tactical/store/journal'
import { State, ObjectState } from 'domo-tactical/store'
import {
  KurrentDBClient,
  START,
  END,
  FORWARDS,
  BACKWARDS,
  StreamNotFoundError,
  StreamDeletedError
} from '@kurrent/kurrentdb-client'

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
 * KurrentDB/EventStoreDB implementation of StreamReader.
 *
 * Reads entries from an EventStoreDB stream.
 *
 * @template T the type of entry data (typically string for JSON)
 */
export class KurrentDBStreamReader<T> extends Actor implements StreamReader<T> {
  private readonly client: KurrentDBClient
  // Reader name stored for debugging/logging purposes
  private readonly _readerName: string

  /** Prefix for snapshot streams */
  private static readonly SNAPSHOT_STREAM_PREFIX = '$snapshot-'

  constructor(client: KurrentDBClient, name: string) {
    super()
    this.client = client
    this._readerName = name
  }

  async streamFor(streamName: string): Promise<EntryStream<T>> {
    try {
      // Read all events from stream
      const eventsIterator = this.client.readStream(streamName, {
        direction: FORWARDS,
        fromRevision: START
      })

      const entries: Entry<T>[] = []
      let maxVersion = 0

      for await (const resolvedEvent of eventsIterator) {
        const event = resolvedEvent.event
        if (!event) continue

        const revision = Number(event.revision) + 1 // Convert to 1-based version
        maxVersion = Math.max(maxVersion, revision)

        const eventMetadata = event.metadata as { typeVersion?: number; metadata?: string } | undefined

        entries.push({
          id: event.id,
          type: event.type,
          typeVersion: eventMetadata?.typeVersion ?? 1,
          entryData: JSON.stringify(event.data) as T,
          metadata: eventMetadata?.metadata ?? '{}'
        })
      }

      if (entries.length === 0) {
        return EntryStream.empty<T>(streamName)
      }

      // Try to load snapshot
      const snapshot = await this.loadSnapshot(streamName)

      return new EntryStream(streamName, maxVersion, entries, snapshot, false, false)
    } catch (error) {
      if (error instanceof StreamNotFoundError) {
        return EntryStream.empty<T>(streamName)
      }
      if (error instanceof StreamDeletedError) {
        // Determine if tombstoned or soft-deleted
        // In EventStoreDB, a tombstoned stream throws StreamDeletedError
        // and cannot be reopened
        return EntryStream.tombstoned<T>(streamName, 0)
      }
      throw error
    }
  }

  private async loadSnapshot(streamName: string): Promise<State<unknown> | null> {
    try {
      const snapshotStreamName = `${KurrentDBStreamReader.SNAPSHOT_STREAM_PREFIX}${streamName}`

      // Read the latest snapshot event
      const eventsIterator = this.client.readStream(snapshotStreamName, {
        direction: BACKWARDS,
        fromRevision: END,
        maxCount: 1
      })

      for await (const resolvedEvent of eventsIterator) {
        const event = resolvedEvent.event
        if (!event) continue

        const snapData = event.data as unknown as SnapshotMetadata
        return new ObjectState(
          streamName,
          Object,
          snapData.snapshotTypeVersion,
          snapData.snapshotData,
          snapData.snapshotVersion
        )
      }

      return null
    } catch {
      // Snapshot stream may not exist
      return null
    }
  }
}
