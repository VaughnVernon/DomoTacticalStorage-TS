// Copyright © 2012-2025 Vaughn Vernon. All rights reserved.
// Copyright © 2012-2025 Kalele, Inc. All rights reserved.
//
// Licensed under the Reciprocal Public License 1.5
//
// See: LICENSE.md in repository root directory
// See: https://opensource.org/license/rpl-1-5

import { Actor } from 'domo-actors'
import { JournalReader, Entry } from 'domo-tactical/store/journal'
import {
  KurrentDBClient,
  START,
  FORWARDS
} from '@kurrent/kurrentdb-client'

/**
 * KurrentDB/EventStoreDB implementation of JournalReader.
 *
 * Reads all events from $all stream in chronological order.
 * Uses EventStoreDB's global position for tracking progress.
 *
 * Note: This reader reads from $all and filters out system events.
 * Position is stored in memory and can be persisted using subscription checkpoints.
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
export class KurrentDBJournalReader<T> extends Actor implements JournalReader<T> {
  private readonly client: KurrentDBClient
  private readonly readerName: string
  private currentPosition: bigint = BigInt(0)
  private commitPosition: bigint = BigInt(0)

  constructor(client: KurrentDBClient, name: string) {
    super()
    this.client = client
    this.readerName = name
  }

  async readNext(max: number): Promise<Entry<T>[]> {
    if (max <= 0) {
      throw new Error('max must be greater than 0')
    }

    const entries: Entry<T>[] = []

    // Read from $all stream
    const eventsIterator = this.client.readAll({
      direction: FORWARDS,
      fromPosition: this.currentPosition === BigInt(0)
        ? START
        : { commit: this.commitPosition, prepare: this.commitPosition },
      maxCount: max * 2 // Read extra to account for filtering system events
    })

    let count = 0
    for await (const resolvedEvent of eventsIterator) {
      const event = resolvedEvent.event
      if (!event) continue

      // Skip system events (those starting with $)
      if (event.type.startsWith('$')) continue

      // Skip snapshot streams
      if (event.streamId.startsWith('$snapshot-')) continue

      const eventMetadata = event.metadata as { typeVersion?: number; metadata?: string } | undefined

      entries.push({
        id: event.id,
        type: event.type,
        typeVersion: eventMetadata?.typeVersion ?? 1,
        entryData: JSON.stringify(event.data) as T,
        metadata: eventMetadata?.metadata ?? '{}'
      })

      count++

      // Update position
      if (resolvedEvent.commitPosition !== undefined) {
        this.commitPosition = resolvedEvent.commitPosition
        this.currentPosition = this.commitPosition
      }

      if (count >= max) break
    }

    return entries
  }

  async name(): Promise<string> {
    return this.readerName
  }

  async seek(position: number): Promise<void> {
    if (position < 0) {
      throw new Error('position cannot be negative')
    }

    // In KurrentDB, we need to convert numeric position to commit position
    // For simplicity, we read from the beginning and skip to the desired position
    // A more efficient implementation would store commit positions
    this.currentPosition = BigInt(position)
    this.commitPosition = BigInt(position)
  }

  async position(): Promise<number> {
    return Number(this.currentPosition)
  }

  async rewind(): Promise<void> {
    this.currentPosition = BigInt(0)
    this.commitPosition = BigInt(0)
  }
}
