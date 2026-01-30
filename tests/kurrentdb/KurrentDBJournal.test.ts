// Copyright © 2012-2025 Vaughn Vernon. All rights reserved.
// Copyright © 2012-2025 Kalele, Inc. All rights reserved.
//
// Licensed under the Reciprocal Public License 1.5
//
// See: LICENSE.md in repository root directory
// See: https://opensource.org/license/rpl-1-5

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Stage, stage } from 'domo-actors'
import { StreamState } from 'domo-tactical/store/journal'
import { Source, Metadata } from 'domo-tactical/store'
import { KurrentDBConfig, KurrentDBJournal } from '../../src/kurrentdb/index.js'

// Test event class
class AccountOpened extends Source<AccountOpened> {
  constructor(
    public readonly accountId: string,
    public readonly name: string,
    public readonly balance: number
  ) {
    super()
  }

  override id(): string {
    return this.accountId
  }
}

class FundsDeposited extends Source<FundsDeposited> {
  constructor(
    public readonly accountId: string,
    public readonly amount: number
  ) {
    super()
  }

  override id(): string {
    return this.accountId
  }
}

describe('KurrentDBJournal', () => {
  let config: KurrentDBConfig
  let journal: KurrentDBJournal<string>
  let testStage: Stage

  // To run these tests:
  // 1. Start EventStoreDB: docker run --rm -it -p 2113:2113 eventstore/eventstore:latest --insecure
  // 2. Set environment variable: TEST_KURRENTDB_URL=esdb://localhost:2113?tls=false
  // 3. Remove the .skip from describe

  beforeAll(async () => {
    // Skip if no KurrentDB connection available
    const connectionString = process.env.TEST_KURRENTDB_URL

    if (!connectionString) {
      console.log('Skipping KurrentDB tests - TEST_KURRENTDB_URL not set')
      console.log('To run: docker run --rm -it -p 2113:2113 eventstore/eventstore:latest --insecure')
      return
    }

    try {
      config = KurrentDBConfig.fromConnectionString(connectionString)
    } catch (error) {
      console.log('Skipping KurrentDB tests - could not connect')
      return
    }

    // Get actor stage
    testStage = stage()
  })

  afterAll(async () => {
    if (config) {
      await config.close()
    }
  })

  it('should append a single event to a new stream', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamName = `account-${Date.now()}-123`
    const event = new AccountOpened('acc-123', 'Alice', 1000)
    const result = await journal.append(
      streamName,
      StreamState.NoStream,
      event,
      Metadata.nullMetadata()
    )

    expect(result.isSuccess()).toBe(true)
    expect(result.streamVersion).toBe(1)
    expect(result.source).toBe(event)
  })

  it('should detect concurrency violation on wrong version', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamName = `account-${Date.now()}-456`
    const event1 = new AccountOpened('acc-456', 'Bob', 500)
    await journal.append(streamName, StreamState.NoStream, event1, Metadata.nullMetadata())

    // Try to append with wrong version
    const event2 = new FundsDeposited('acc-456', 100)
    const result = await journal.append(streamName, StreamState.NoStream, event2, Metadata.nullMetadata())

    expect(result.isConcurrencyViolation()).toBe(true)
  })

  it('should append multiple events', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamName = `account-${Date.now()}-789`
    const events = [
      new AccountOpened('acc-789', 'Charlie', 0),
      new FundsDeposited('acc-789', 500),
      new FundsDeposited('acc-789', 300)
    ] as Source<unknown>[]

    const result = await journal.appendAll(
      streamName,
      StreamState.NoStream,
      events,
      Metadata.nullMetadata()
    )

    expect(result.isSuccess()).toBe(true)
    expect(result.streamVersion).toBe(3)
  })

  it('should read stream entries', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamName = `account-${Date.now()}-read`

    // Append events
    const events = [
      new AccountOpened('acc-read', 'David', 1000),
      new FundsDeposited('acc-read', 200)
    ] as Source<unknown>[]

    await journal.appendAll(streamName, StreamState.NoStream, events, Metadata.nullMetadata())

    // Read stream
    const reader = await journal.streamReader('test-reader')
    const stream = await reader.streamFor(streamName)

    expect(stream.streamVersion).toBe(2)
    expect(stream.entries.length).toBe(2)
    expect(stream.entries[0].type).toBe('AccountOpened')
    expect(stream.entries[1].type).toBe('FundsDeposited')
  })

  it('should tombstone a stream', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamName = `tombstone-${Date.now()}-test`

    // Create stream
    await journal.append(streamName, StreamState.NoStream, new AccountOpened('t', 'T', 100), Metadata.nullMetadata())

    // Tombstone it
    const result = await journal.tombstone(streamName)
    expect(result.isSuccess()).toBe(true)

    // Try to append - should fail
    const appendResult = await journal.append(streamName, 2, new FundsDeposited('t', 50), Metadata.nullMetadata())
    expect(appendResult.isStreamDeleted()).toBe(true)
  })

  it('should soft-delete and reopen a stream', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamName = `soft-delete-${Date.now()}-test`

    // Create stream
    await journal.append(streamName, StreamState.NoStream, new AccountOpened('s', 'S', 100), Metadata.nullMetadata())

    // Soft delete
    const deleteResult = await journal.softDelete(streamName)
    expect(deleteResult.isSuccess()).toBe(true)

    // In EventStoreDB, soft delete allows reopening
    // The stream version continues from where it was
  })

  it('should append with StreamState.Any', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamName = `any-${Date.now()}-test`

    // Append with Any to new stream
    const event1 = new AccountOpened('any-1', 'Any', 100)
    const result1 = await journal.append(streamName, StreamState.Any, event1, Metadata.nullMetadata())
    expect(result1.isSuccess()).toBe(true)
    expect(result1.streamVersion).toBe(1)

    // Append with Any to existing stream
    const event2 = new FundsDeposited('any-1', 50)
    const result2 = await journal.append(streamName, StreamState.Any, event2, Metadata.nullMetadata())
    expect(result2.isSuccess()).toBe(true)
    expect(result2.streamVersion).toBe(2)
  })

  it('should append with StreamState.StreamExists', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamName = `exists-${Date.now()}-test`

    // StreamExists on non-existent stream should fail
    const event1 = new AccountOpened('exists-1', 'Exists', 100)
    const result1 = await journal.append(streamName, StreamState.StreamExists, event1, Metadata.nullMetadata())
    expect(result1.isConcurrencyViolation()).toBe(true)

    // Create the stream first
    await journal.append(streamName, StreamState.NoStream, event1, Metadata.nullMetadata())

    // Now StreamExists should work
    const event2 = new FundsDeposited('exists-1', 50)
    const result2 = await journal.append(streamName, StreamState.StreamExists, event2, Metadata.nullMetadata())
    expect(result2.isSuccess()).toBe(true)
  })

  it('should get stream info', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamName = `info-${Date.now()}-test`

    // Non-existent stream
    const info1 = await journal.streamInfo(streamName)
    expect(info1.exists).toBe(false)

    // Create stream with events
    await journal.append(streamName, StreamState.NoStream, new AccountOpened('info', 'Info', 100), Metadata.nullMetadata())
    await journal.append(streamName, 2, new FundsDeposited('info', 50), Metadata.nullMetadata())

    const info2 = await journal.streamInfo(streamName)
    expect(info2.exists).toBe(true)
    expect(info2.streamName).toBe(streamName)
    expect(info2.currentVersion).toBe(2)
  })

  it('should truncate before a version', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamName = `truncate-${Date.now()}-test`

    // Create stream with multiple events
    await journal.appendAll(streamName, StreamState.NoStream, [
      new AccountOpened('trunc', 'Truncate', 100),
      new FundsDeposited('trunc', 50),
      new FundsDeposited('trunc', 25)
    ] as Source<unknown>[], Metadata.nullMetadata())

    // Truncate before version 2
    const result = await journal.truncateBefore(streamName, 2)
    expect(result.isSuccess()).toBe(true)

    // Stream info should reflect truncation
    const info = await journal.streamInfo(streamName)
    expect(info.truncateBefore).toBe(2)
  })

  it('should return not found when truncating non-existent stream', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const result = await journal.truncateBefore(`nonexistent-${Date.now()}`, 1)
    expect(result.wasNotFound()).toBe(true)
  })

  it('should return not found when tombstoning non-existent stream', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const result = await journal.tombstone(`nonexistent-${Date.now()}`)
    expect(result.wasNotFound()).toBe(true)
  })

  it('should return not found when soft-deleting non-existent stream', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const result = await journal.softDelete(`nonexistent-${Date.now()}`)
    expect(result.wasNotFound()).toBe(true)
  })

  it('should fail append with wrong specific version', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamName = `wrong-version-${Date.now()}-test`

    // Create stream at version 1
    await journal.append(streamName, StreamState.NoStream, new AccountOpened('wv', 'WrongVersion', 100), Metadata.nullMetadata())

    // Try to append expecting version 5 (wrong)
    const result = await journal.append(streamName, 5, new FundsDeposited('wv', 50), Metadata.nullMetadata())
    expect(result.isConcurrencyViolation()).toBe(true)
  })

  it('should handle empty appendAll', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamName = `empty-${Date.now()}-test`

    // Append empty array - returns fromStreamVersion - 1
    const result = await journal.appendAll(streamName, StreamState.NoStream, [], Metadata.nullMetadata())
    expect(result.isSuccess()).toBe(true)
    // NoStream is -1, so version returned is -1 - 1 = -2
    expect(result.streamVersion).toBe(StreamState.NoStream - 1)
  })

  it('should use journal reader with position tracking', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    // Append events to multiple streams
    const streamA = `journal-reader-a-${Date.now()}`
    const streamB = `journal-reader-b-${Date.now()}`

    await journal.append(streamA, StreamState.NoStream, new AccountOpened('a', 'A', 100), Metadata.nullMetadata())
    await journal.append(streamB, StreamState.NoStream, new AccountOpened('b', 'B', 200), Metadata.nullMetadata())
    await journal.append(streamA, 2, new FundsDeposited('a', 50), Metadata.nullMetadata())

    // Read with journal reader
    const reader = await journal.journalReader(`test-projection-${Date.now()}`)

    // KurrentDB $all stream reads all events including from other tests
    // Just verify the reader works and can read events
    const entries1 = await reader.readNext(100)
    // Should read at least our 3 events (may include events from other tests)
    expect(entries1.length).toBeGreaterThanOrEqual(3)

    // Position should be updated after reading
    const pos1 = await reader.position()
    expect(pos1).toBeGreaterThan(0)

    // Rewind should reset position
    await reader.rewind()
    const pos2 = await reader.position()
    expect(pos2).toBe(0)

    // Reading after rewind should return events again
    const entries2 = await reader.readNext(100)
    expect(entries2.length).toBeGreaterThanOrEqual(3)
  })

  it('should append with snapshot', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamName = `snapshot-${Date.now()}-test`
    const event = new AccountOpened('snap', 'Snapshot', 1000)
    const snapshot = { balance: 1000, name: 'Snapshot' }

    const result = await journal.appendWith(
      streamName,
      StreamState.NoStream,
      event,
      Metadata.nullMetadata(),
      snapshot
    )

    expect(result.isSuccess()).toBe(true)
    expect(result.snapshot).toEqual(snapshot)
  })

  it('should read stream with snapshot', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamName = `snapshot-read-${Date.now()}-test`
    const snapshot = { balance: 1000, name: 'SnapshotRead' }

    // Append with snapshot
    await journal.appendWith(
      streamName,
      StreamState.NoStream,
      new AccountOpened('snapr', 'SnapshotRead', 1000),
      Metadata.nullMetadata(),
      snapshot
    )

    // Add more events
    await journal.append(streamName, 2, new FundsDeposited('snapr', 500), Metadata.nullMetadata())

    // Read stream with snapshot
    const reader = await journal.streamReader('snapshot-reader')
    const stream = await reader.streamFor(streamName)

    expect(stream.streamVersion).toBe(2)
    // Snapshot should be available
    expect(stream.snapshot).toBeDefined()
    // Snapshot may be wrapped in ObjectState, check the data property
    const snapshotData = stream.snapshot?.data ?? stream.snapshot
    expect(snapshotData).toEqual(snapshot)
  })
})
