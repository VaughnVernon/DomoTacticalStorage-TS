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

      const entries: TextEntry[] = []
      let maxVersion = 0

      for await (const resolvedEvent of eventsIterator) {
        const event = resolvedEvent.event
        if (!event) continue

        const streamVersion = Number(event.revision) + 1 // Convert to 1-based version
        maxVersion = Math.max(maxVersion, streamVersion)

        const eventMetadata = event.metadata as { typeVersion?: number; metadata?: string } | undefined
        // Use commitPosition as globalPosition (convert bigint to number)
        const globalPosition = resolvedEvent.commitPosition !== undefined
          ? Number(resolvedEvent.commitPosition)
          : 0

        entries.push(new TextEntry(
          event.id,
          globalPosition,
          event.type,
          eventMetadata?.typeVersion ?? 1,
          JSON.stringify(event.data),
          streamVersion,
          eventMetadata?.metadata ?? '{}'
        ))
      }

      if (entries.length === 0) {
        return EntryStream.empty<T>(streamName)
      }

      // Try to load snapshot
      const snapshot = await this.loadSnapshot(streamName)

      // Cast entries to Entry<T>[] - TextEntry extends Entry<string> and T is typically string
      return new EntryStream<T>(streamName, maxVersion, entries as unknown as Entry<T>[], snapshot, false, false)
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
          snapData.snapshotType, // Use stored type name (string)
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
