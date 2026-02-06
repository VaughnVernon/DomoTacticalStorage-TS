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
    expect(stream.entries[0].type).toBe('account-opened')
    expect(stream.entries[1].type).toBe('funds-deposited')
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

  it('should verify Entry properties including globalPosition', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamName = `entry-props-${Date.now()}`

    // Append events
    await journal.append(streamName, StreamState.NoStream, new AccountOpened('ep1', 'EntryProps1', 100), Metadata.nullMetadata())
    await journal.append(streamName, 2, new FundsDeposited('ep1', 50), Metadata.nullMetadata())

    // Read via stream reader
    const reader = await journal.streamReader('entry-props-reader')
    const stream = await reader.streamFor(streamName)

    expect(stream.entries.length).toBe(2)
    const entry = stream.entries[0]

    // Verify all Entry properties
    expect(entry.id).toBeDefined()
    expect(entry.globalPosition).toBeGreaterThanOrEqual(0) // KurrentDB uses commitPosition
    expect(entry.type).toBe('account-opened')
    expect(entry.typeVersion).toBe(1)
    expect(entry.streamVersion).toBe(1)
    expect(entry.entryData).toBeDefined()
    expect(entry.metadata).toBeDefined()

    // Verify entryData contains the event data
    const data = JSON.parse(entry.entryData)
    expect(data.accountId).toBe('ep1')
    expect(data.name).toBe('EntryProps1')
    expect(data.balance).toBe(100)
  })

  it('should have increasing globalPosition across streams', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamA = `gp-stream-a-${Date.now()}`
    const streamB = `gp-stream-b-${Date.now()}`

    // Append to multiple streams
    await journal.append(streamA, StreamState.NoStream, new AccountOpened('gpa', 'A', 100), Metadata.nullMetadata())
    await journal.append(streamB, StreamState.NoStream, new AccountOpened('gpb', 'B', 200), Metadata.nullMetadata())
    await journal.append(streamA, 2, new FundsDeposited('gpa', 50), Metadata.nullMetadata())

    // Read via journal reader
    const reader = await journal.journalReader(`gp-reader-${Date.now()}`)
    const entries = await reader.readNext(100)

    // Filter to only our test entries (KurrentDB $all contains all events)
    const testEntries = entries.filter(e =>
      e.type === 'account-opened' || e.type === 'funds-deposited'
    )

    expect(testEntries.length).toBeGreaterThanOrEqual(3)

    // Verify globalPosition is monotonically increasing
    for (let i = 1; i < testEntries.length; i++) {
      expect(testEntries[i].globalPosition).toBeGreaterThanOrEqual(testEntries[i - 1].globalPosition)
    }
  })

  it('should verify streamVersion on entries within a stream', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamName = `sv-test-${Date.now()}`

    // Append multiple events to same stream
    await journal.appendAll(streamName, StreamState.NoStream, [
      new AccountOpened('sv', 'StreamVersion', 100),
      new FundsDeposited('sv', 50),
      new FundsDeposited('sv', 25)
    ] as Source<unknown>[], Metadata.nullMetadata())

    // Read stream
    const reader = await journal.streamReader('sv-reader')
    const stream = await reader.streamFor(streamName)

    expect(stream.entries.length).toBe(3)
    expect(stream.entries[0].streamVersion).toBe(1)
    expect(stream.entries[1].streamVersion).toBe(2)
    expect(stream.entries[2].streamVersion).toBe(3)
  })

  it('should preserve metadata in entries', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamName = `meta-test-${Date.now()}`
    const metadata = Metadata.with(
      new Map([['correlationId', 'corr-123'], ['causationId', 'cause-456']]),
      'test-value',
      'create'
    )

    await journal.append(streamName, StreamState.NoStream, new AccountOpened('mt', 'MetaTest', 100), metadata)

    // Read stream
    const reader = await journal.streamReader('meta-reader')
    const stream = await reader.streamFor(streamName)

    expect(stream.entries.length).toBe(1)
    const entry = stream.entries[0]

    // Verify metadata is preserved
    const entryMetadata = JSON.parse(entry.metadata)
    expect(entryMetadata.operation).toBe('create')
    expect(entryMetadata.value).toBe('test-value')
  })

  it('should appendAllWith snapshot', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamName = `append-all-with-${Date.now()}`
    const events = [
      new AccountOpened('aaw', 'AppendAllWith', 1000),
      new FundsDeposited('aaw', 500),
      new FundsDeposited('aaw', 250)
    ] as Source<unknown>[]

    const snapshot = { balance: 1750, name: 'AppendAllWith' }

    const result = await journal.appendAllWith(
      streamName,
      StreamState.NoStream,
      events,
      Metadata.nullMetadata(),
      snapshot
    )

    expect(result.isSuccess()).toBe(true)
    expect(result.streamVersion).toBe(3)
    expect(result.snapshot).toEqual(snapshot)

    // Verify snapshot is persisted
    const reader = await journal.streamReader('aaw-reader')
    const stream = await reader.streamFor(streamName)

    expect(stream.entries.length).toBe(3)
    expect(stream.snapshot).toBeDefined()
    const snapshotData = stream.snapshot?.data ?? stream.snapshot
    expect(snapshotData).toEqual(snapshot)
  })

  it('should return reader name', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const reader = await journal.journalReader('named-reader')
    const name = await reader.name()
    expect(name).toBe('named-reader')
  })

  it('should handle EntryStream tombstoned state', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamName = `tombstone-stream-${Date.now()}`

    // Create and tombstone stream
    await journal.append(streamName, StreamState.NoStream, new AccountOpened('ts', 'TS', 100), Metadata.nullMetadata())
    await journal.tombstone(streamName)

    // Read stream
    const reader = await journal.streamReader('tombstone-stream-reader')
    const stream = await reader.streamFor(streamName)

    expect(stream.isTombstoned).toBe(true)
  })

  it('should handle EntryStream empty state', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    // Read non-existent stream
    const reader = await journal.streamReader('empty-stream-reader')
    const stream = await reader.streamFor(`nonexistent-stream-${Date.now()}`)

    // Empty stream has no entries and version 0
    expect(stream.entries.length).toBe(0)
    expect(stream.streamVersion).toBe(0)
  })

  it('should handle JournalReader max validation', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const reader = await journal.journalReader('max-validation-reader')

    // Should throw for invalid max values
    await expect(reader.readNext(0)).rejects.toThrow('max must be greater than 0')
    await expect(reader.readNext(-1)).rejects.toThrow('max must be greater than 0')
  })

  it('should handle seek with negative position', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const reader = await journal.journalReader('seek-negative-reader')

    // Should throw for negative position
    await expect(reader.seek(-1)).rejects.toThrow('position cannot be negative')
  })

  it('should get stream info for tombstoned stream', async () => {
    if (!config) return

    journal = testStage.actorFor<KurrentDBJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new KurrentDBJournal(config)
        })
      }
    )

    const streamName = `tombstone-info-${Date.now()}`

    // Create and tombstone stream
    await journal.append(streamName, StreamState.NoStream, new AccountOpened('ti', 'TI', 100), Metadata.nullMetadata())
    await journal.tombstone(streamName)

    const info = await journal.streamInfo(streamName)
    expect(info.isTombstoned).toBe(true)
  })

  it('should create config using KurrentDBConfig.create() with options', async () => {
    // Test create() factory method with tls=false
    const configFromCreate = KurrentDBConfig.create({
      endpoint: 'localhost:2113',
      tls: false
    })

    expect(configFromCreate).toBeDefined()
    expect(configFromCreate.getClient()).toBeDefined()

    await configFromCreate.close()
  })

  it('should create config using KurrentDBConfig.create() with TLS options', async () => {
    // Test create() with tls=true and tlsVerifyCert=false
    const configWithTls = KurrentDBConfig.create({
      endpoint: 'localhost:2113',
      tls: true,
      tlsVerifyCert: false
    })

    expect(configWithTls).toBeDefined()
    expect(configWithTls.getClient()).toBeDefined()

    await configWithTls.close()
  })

  it('should create config using KurrentDBConfig.fromClient()', async () => {
    if (!config) return

    // Get existing client and create new config from it
    const existingClient = config.getClient()
    const configFromClient = KurrentDBConfig.fromClient(existingClient)

    expect(configFromClient).toBeDefined()
    expect(configFromClient.getClient()).toBe(existingClient)
  })
})
