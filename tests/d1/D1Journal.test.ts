// Copyright © 2012-2025 Vaughn Vernon. All rights reserved.
// Copyright © 2012-2025 Kalele, Inc. All rights reserved.
//
// Licensed under the Reciprocal Public License 1.5
//
// See: LICENSE.md in repository root directory
// See: https://opensource.org/license/rpl-1-5

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Stage, stage } from 'domo-actors'
import { StreamState } from 'domo-tactical/store/journal'
import { Source, Metadata } from 'domo-tactical/store'
import { D1Config, D1Journal } from '../../src/d1/index.js'
import { createD1TestContext, disposeD1TestContext, clearD1Data, D1TestContext } from './D1TestHelper.js'

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

describe('D1Journal', () => {
  let context: D1TestContext
  let config: D1Config
  let journal: D1Journal<string>
  let testStage: Stage

  beforeAll(async () => {
    // Create Miniflare D1 context
    context = await createD1TestContext(true, false)
    config = D1Config.create(context.db)

    // Get actor stage
    testStage = stage()
  })

  afterAll(async () => {
    if (context) {
      await disposeD1TestContext(context)
    }
  })

  beforeEach(async () => {
    // Clean data between tests
    if (context) {
      await clearD1Data(context.db)
    }

    // Create fresh journal actor for each test
    journal = testStage.actorFor<D1Journal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new D1Journal(config)
        })
      }
    )
  })

  it('should append a single event to a new stream', async () => {
    const event = new AccountOpened('acc-123', 'Alice', 1000)
    const result = await journal.append(
      'account-acc-123',
      StreamState.NoStream,
      event,
      Metadata.nullMetadata()
    )

    expect(result.isSuccess()).toBe(true)
    expect(result.streamVersion).toBe(1)
  })

  it('should detect concurrency violation on wrong version', async () => {
    const event1 = new AccountOpened('acc-456', 'Bob', 500)
    await journal.append('account-acc-456', StreamState.NoStream, event1, Metadata.nullMetadata())

    // Try to append with wrong version (NoStream when stream exists)
    const event2 = new FundsDeposited('acc-456', 100)
    const result = await journal.append('account-acc-456', StreamState.NoStream, event2, Metadata.nullMetadata())

    expect(result.isConcurrencyViolation()).toBe(true)
  })

  it('should append multiple events', async () => {
    const events = [
      new AccountOpened('acc-789', 'Charlie', 0),
      new FundsDeposited('acc-789', 500),
      new FundsDeposited('acc-789', 300)
    ] as Source<unknown>[]

    const result = await journal.appendAll(
      'account-acc-789',
      StreamState.NoStream,
      events,
      Metadata.nullMetadata()
    )

    expect(result.isSuccess()).toBe(true)
    expect(result.streamVersion).toBe(3)
  })

  it('should read stream entries', async () => {
    // Append events
    const events = [
      new AccountOpened('acc-read', 'David', 1000),
      new FundsDeposited('acc-read', 200)
    ] as Source<unknown>[]

    await journal.appendAll('account-acc-read', StreamState.NoStream, events, Metadata.nullMetadata())

    // Read stream
    const reader = await journal.streamReader('test-reader')
    const stream = await reader.streamFor('account-acc-read')

    expect(stream.streamVersion).toBe(2)
    expect(stream.entries.length).toBe(2)
    expect(stream.entries[0].type).toBe('AccountOpened')
    expect(stream.entries[1].type).toBe('FundsDeposited')
  })

  it('should append with StreamState.Any', async () => {
    const event1 = new AccountOpened('acc-any', 'Eve', 100)
    await journal.append('account-acc-any', StreamState.NoStream, event1, Metadata.nullMetadata())

    // Append with Any - should work regardless of current version
    const event2 = new FundsDeposited('acc-any', 50)
    const result = await journal.append('account-acc-any', StreamState.Any, event2, Metadata.nullMetadata())

    expect(result.isSuccess()).toBe(true)
    expect(result.streamVersion).toBe(2)
  })

  it('should get stream info', async () => {
    const event = new AccountOpened('acc-info', 'Frank', 500)
    await journal.append('account-acc-info', StreamState.NoStream, event, Metadata.nullMetadata())

    const info = await journal.streamInfo('account-acc-info')

    expect(info.exists).toBe(true)
    expect(info.streamName).toBe('account-acc-info')
    expect(info.currentVersion).toBe(1)
  })

  it('should tombstone a stream', async () => {
    const event = new AccountOpened('acc-tomb', 'George', 100)
    await journal.append('account-acc-tomb', StreamState.NoStream, event, Metadata.nullMetadata())

    const result = await journal.tombstone('account-acc-tomb')

    expect(result.isSuccess()).toBe(true)

    // Verify stream is tombstoned
    const info = await journal.streamInfo('account-acc-tomb')
    expect(info.isTombstoned).toBe(true)
  })

  it('should soft delete a stream', async () => {
    const event = new AccountOpened('acc-soft', 'Helen', 200)
    await journal.append('account-acc-soft', StreamState.NoStream, event, Metadata.nullMetadata())

    const result = await journal.softDelete('account-acc-soft')

    expect(result.isSuccess()).toBe(true)

    // Verify stream is soft deleted
    const info = await journal.streamInfo('account-acc-soft')
    expect(info.isSoftDeleted).toBe(true)
  })

  it('should append with StreamState.StreamExists', async () => {
    // StreamExists on non-existent stream should fail
    const event1 = new AccountOpened('exists-1', 'Exists', 100)
    const result1 = await journal.append('exists-test', StreamState.StreamExists, event1, Metadata.nullMetadata())
    expect(result1.isConcurrencyViolation()).toBe(true)

    // Create the stream first
    await journal.append('exists-test-2', StreamState.NoStream, event1, Metadata.nullMetadata())

    // Now StreamExists should work
    const event2 = new FundsDeposited('exists-1', 50)
    const result2 = await journal.append('exists-test-2', StreamState.StreamExists, event2, Metadata.nullMetadata())
    expect(result2.isSuccess()).toBe(true)
  })

  it('should truncate before a version', async () => {
    // Create stream with multiple events
    await journal.appendAll('truncate-test', StreamState.NoStream, [
      new AccountOpened('trunc', 'Truncate', 100),
      new FundsDeposited('trunc', 50),
      new FundsDeposited('trunc', 25)
    ] as Source<unknown>[], Metadata.nullMetadata())

    // Truncate before version 2
    const result = await journal.truncateBefore('truncate-test', 2)
    expect(result.isSuccess()).toBe(true)

    // Stream info should reflect truncation
    const info = await journal.streamInfo('truncate-test')
    expect(info.truncateBefore).toBe(2)
  })

  it('should return not found when truncating non-existent stream', async () => {
    const result = await journal.truncateBefore('nonexistent-truncate', 1)
    expect(result.wasNotFound()).toBe(true)
  })

  it('should return not found when tombstoning non-existent stream', async () => {
    const result = await journal.tombstone('nonexistent-tombstone')
    expect(result.wasNotFound()).toBe(true)
  })

  it('should return not found when soft-deleting non-existent stream', async () => {
    const result = await journal.softDelete('nonexistent-soft-delete')
    expect(result.wasNotFound()).toBe(true)
  })

  it('should fail append with wrong specific version', async () => {
    // Create stream at version 1
    await journal.append('wrong-version-test', StreamState.NoStream, new AccountOpened('wv', 'WrongVersion', 100), Metadata.nullMetadata())

    // Try to append expecting version 5 (wrong)
    const result = await journal.append('wrong-version-test', 5, new FundsDeposited('wv', 50), Metadata.nullMetadata())
    expect(result.isConcurrencyViolation()).toBe(true)
  })

  it('should handle empty appendAll', async () => {
    // Append empty array
    const result = await journal.appendAll('empty-test', StreamState.NoStream, [], Metadata.nullMetadata())
    expect(result.isSuccess()).toBe(true)
  })

  it('should fail append to tombstoned stream', async () => {
    // Create and tombstone stream
    await journal.append('tombstone-append', StreamState.NoStream, new AccountOpened('ta', 'TA', 100), Metadata.nullMetadata())
    await journal.tombstone('tombstone-append')

    // Try to append - should fail
    const result = await journal.append('tombstone-append', 2, new FundsDeposited('ta', 50), Metadata.nullMetadata())
    expect(result.isStreamDeleted()).toBe(true)
  })

  it('should read journal entries in order', async () => {
    // Get initial position
    const reader = await journal.journalReader('projection-reader')
    const initialPos = await reader.position()

    // Append to multiple streams
    await journal.append('stream-a', StreamState.NoStream, new AccountOpened('a', 'A', 100), Metadata.nullMetadata())
    await journal.append('stream-b', StreamState.NoStream, new AccountOpened('b', 'B', 200), Metadata.nullMetadata())
    await journal.append('stream-a', 2, new FundsDeposited('a', 50), Metadata.nullMetadata())

    // Read journal - get exactly the new entries
    const entries = await reader.readNext(3)

    expect(entries.length).toBe(3)
    expect(entries[0].type).toBe('AccountOpened')
    expect(entries[1].type).toBe('AccountOpened')
    expect(entries[2].type).toBe('FundsDeposited')

    // Check position tracking - should have advanced (position is global_position, not count)
    const position = await reader.position()
    expect(position).toBeGreaterThan(initialPos)
  })

  it('should seek and rewind journal reader', async () => {
    // Get a fresh reader and note initial position
    const reader = await journal.journalReader('seek-reader')
    const initialPos = await reader.position()

    // Append events
    await journal.append('seek-a', StreamState.NoStream, new AccountOpened('a', 'A', 100), Metadata.nullMetadata())
    await journal.append('seek-b', StreamState.NoStream, new AccountOpened('b', 'B', 200), Metadata.nullMetadata())
    await journal.append('seek-c', StreamState.NoStream, new AccountOpened('c', 'C', 300), Metadata.nullMetadata())

    // Read the 3 new entries
    const entries1 = await reader.readNext(3)
    expect(entries1.length).toBe(3)

    // Position should have advanced (position is global_position of last read entry)
    const pos = await reader.position()
    expect(pos).toBeGreaterThan(initialPos)

    // Seek back to position 1 (1-based positions)
    await reader.seek(1)
    const seekPos = await reader.position()
    expect(seekPos).toBe(1)

    // Read from position 1 - should get entries
    const entries2 = await reader.readNext(2)
    expect(entries2.length).toBe(2)

    // Rewind to beginning (position 0 means before first entry)
    await reader.rewind()
    const rewindPos = await reader.position()
    expect(rewindPos).toBe(0)
  })

  it('should append with snapshot', async () => {
    const event = new AccountOpened('snap', 'Snapshot', 1000)
    const snapshot = { balance: 1000, name: 'Snapshot' }

    const result = await journal.appendWith(
      'snapshot-test',
      StreamState.NoStream,
      event,
      Metadata.nullMetadata(),
      snapshot
    )

    expect(result.isSuccess()).toBe(true)
    expect(result.snapshot).toEqual(snapshot)
  })

  it('should read stream with snapshot', async () => {
    const snapshot = { balance: 1000, name: 'SnapshotRead' }

    // Append with snapshot
    await journal.appendWith(
      'snapshot-read-test',
      StreamState.NoStream,
      new AccountOpened('snapr', 'SnapshotRead', 1000),
      Metadata.nullMetadata(),
      snapshot
    )

    // Add more events
    await journal.append('snapshot-read-test', 2, new FundsDeposited('snapr', 500), Metadata.nullMetadata())

    // Read stream with snapshot
    const reader = await journal.streamReader('snapshot-reader')
    const stream = await reader.streamFor('snapshot-read-test')

    expect(stream.streamVersion).toBe(2)
    expect(stream.snapshot).toBeDefined()
    // Snapshot is wrapped in ObjectState, check the data property
    const snapshotData = stream.snapshot?.data ?? stream.snapshot
    expect(snapshotData).toEqual(snapshot)
  })

  it('should get stream info for non-existent stream', async () => {
    const info = await journal.streamInfo('nonexistent-stream')
    expect(info.exists).toBe(false)
  })

  it('should reopen soft-deleted stream', async () => {
    // Create stream
    await journal.append('soft-reopen', StreamState.NoStream, new AccountOpened('sr', 'SR', 100), Metadata.nullMetadata())

    // Soft delete
    await journal.softDelete('soft-reopen')

    // Reopen by appending
    const result = await journal.append('soft-reopen', 2, new FundsDeposited('sr', 50), Metadata.nullMetadata())
    expect(result.isSuccess()).toBe(true)
    expect(result.streamVersion).toBe(2)

    // Verify stream is no longer soft deleted
    const info = await journal.streamInfo('soft-reopen')
    expect(info.isSoftDeleted).toBe(false)
  })
})
