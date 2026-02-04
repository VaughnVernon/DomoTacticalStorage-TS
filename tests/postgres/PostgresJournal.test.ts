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
import { Source, Metadata, Result } from 'domo-tactical/store'
import { Pool } from 'pg'
import { PostgresConfig, PostgresJournal } from '../../src/postgres/index.js'

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

describe('PostgresJournal', () => {
  let pool: Pool
  let config: PostgresConfig
  let journal: PostgresJournal<string>
  let testStage: Stage

  beforeAll(async () => {
    // Skip if no PostgreSQL connection available
    const connectionString = process.env.TEST_POSTGRES_URL || 'postgresql://postgres:postgres@localhost:5432/domo_test'

    pool = new Pool({ connectionString })

    // Test connection
    try {
      await pool.query('SELECT 1')
    } catch (error) {
      console.log('Skipping PostgreSQL tests - no database connection')
      return
    }

    // Create schema
    await pool.query(`
      CREATE TABLE IF NOT EXISTS streams (
          stream_name VARCHAR(500) PRIMARY KEY,
          current_version BIGINT NOT NULL DEFAULT 0,
          is_tombstoned BOOLEAN NOT NULL DEFAULT FALSE,
          is_soft_deleted BOOLEAN NOT NULL DEFAULT FALSE,
          deleted_at_version BIGINT,
          truncate_before BIGINT NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS journal_entries (
          global_position BIGSERIAL PRIMARY KEY,
          entry_id CHAR(26) NOT NULL,
          stream_name VARCHAR(500) NOT NULL,
          stream_version BIGINT NOT NULL,
          entry_type VARCHAR(500) NOT NULL,
          entry_type_version INT NOT NULL DEFAULT 1,
          entry_data JSONB NOT NULL,
          metadata JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(stream_name, stream_version)
      );

      CREATE TABLE IF NOT EXISTS snapshots (
          stream_name VARCHAR(500) PRIMARY KEY,
          snapshot_type VARCHAR(500) NOT NULL,
          snapshot_type_version INT NOT NULL DEFAULT 1,
          snapshot_data JSONB NOT NULL,
          snapshot_version BIGINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS journal_reader_positions (
          reader_name VARCHAR(500) PRIMARY KEY,
          current_position BIGINT NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    config = PostgresConfig.fromPool(pool)

    // Get actor stage
    testStage = stage()
  })

  afterAll(async () => {
    if (pool) {
      // Clean up tables
      await pool.query('DROP TABLE IF EXISTS journal_entries CASCADE')
      await pool.query('DROP TABLE IF EXISTS snapshots CASCADE')
      await pool.query('DROP TABLE IF EXISTS streams CASCADE')
      await pool.query('DROP TABLE IF EXISTS journal_reader_positions CASCADE')
      await pool.end()
    }
  })

  beforeEach(async () => {
    // Clean data between tests
    if (pool) {
      await pool.query('TRUNCATE journal_entries, snapshots, streams, journal_reader_positions RESTART IDENTITY CASCADE')
    }
  })

  it('should append a single event to a new stream', async () => {
    // Create journal actor
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    const event = new AccountOpened('acc-123', 'Alice', 1000)
    const result = await journal.append(
      'account-acc-123',
      StreamState.NoStream,
      event,
      Metadata.nullMetadata()
    )

    expect(result.isSuccess()).toBe(true)
    expect(result.streamVersion).toBe(1)
    expect(result.source).toBe(event)
  })

  it('should detect concurrency violation on wrong version', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    const event1 = new AccountOpened('acc-456', 'Bob', 500)
    await journal.append('account-acc-456', StreamState.NoStream, event1, Metadata.nullMetadata())

    // Try to append with wrong version
    const event2 = new FundsDeposited('acc-456', 100)
    const result = await journal.append('account-acc-456', StreamState.NoStream, event2, Metadata.nullMetadata())

    expect(result.isConcurrencyViolation()).toBe(true)
  })

  it('should append multiple events', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

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
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

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

  it('should read journal entries in order', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    // Append to multiple streams
    await journal.append('stream-a', StreamState.NoStream, new AccountOpened('a', 'A', 100), Metadata.nullMetadata())
    await journal.append('stream-b', StreamState.NoStream, new AccountOpened('b', 'B', 200), Metadata.nullMetadata())
    await journal.append('stream-a', 2, new FundsDeposited('a', 50), Metadata.nullMetadata())

    // Read journal
    const reader = await journal.journalReader('projection-reader')
    const entries = await reader.readNext(10)

    expect(entries.length).toBe(3)
    expect(entries[0].type).toBe('AccountOpened')
    expect(entries[1].type).toBe('AccountOpened')
    expect(entries[2].type).toBe('FundsDeposited')

    // Check position tracking
    const position = await reader.position()
    expect(position).toBe(3)
  })

  it('should tombstone a stream', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    // Create stream
    await journal.append('tombstone-test', StreamState.NoStream, new AccountOpened('t', 'T', 100), Metadata.nullMetadata())

    // Tombstone it
    const result = await journal.tombstone('tombstone-test')
    expect(result.isSuccess()).toBe(true)

    // Try to append - should fail
    const appendResult = await journal.append('tombstone-test', 2, new FundsDeposited('t', 50), Metadata.nullMetadata())
    expect(appendResult.isStreamDeleted()).toBe(true)
  })

  it('should soft-delete and reopen a stream', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    // Create stream
    await journal.append('soft-delete-test', StreamState.NoStream, new AccountOpened('s', 'S', 100), Metadata.nullMetadata())

    // Soft delete
    const deleteResult = await journal.softDelete('soft-delete-test')
    expect(deleteResult.isSuccess()).toBe(true)

    // Reopen by appending
    const appendResult = await journal.append('soft-delete-test', 2, new FundsDeposited('s', 50), Metadata.nullMetadata())
    expect(appendResult.isSuccess()).toBe(true)
    expect(appendResult.streamVersion).toBe(2)
  })

  it('should append with StreamState.Any', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    // Append with Any to new stream
    const event1 = new AccountOpened('any-1', 'Any', 100)
    const result1 = await journal.append('any-test', StreamState.Any, event1, Metadata.nullMetadata())
    expect(result1.isSuccess()).toBe(true)
    expect(result1.streamVersion).toBe(1)

    // Append with Any to existing stream
    const event2 = new FundsDeposited('any-1', 50)
    const result2 = await journal.append('any-test', StreamState.Any, event2, Metadata.nullMetadata())
    expect(result2.isSuccess()).toBe(true)
    expect(result2.streamVersion).toBe(2)
  })

  it('should append with StreamState.StreamExists', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

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

  it('should get stream info', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    // Non-existent stream
    const info1 = await journal.streamInfo('info-nonexistent')
    expect(info1.exists).toBe(false)

    // Create stream with events
    await journal.append('info-test', StreamState.NoStream, new AccountOpened('info', 'Info', 100), Metadata.nullMetadata())
    await journal.append('info-test', 2, new FundsDeposited('info', 50), Metadata.nullMetadata())

    const info2 = await journal.streamInfo('info-test')
    expect(info2.exists).toBe(true)
    expect(info2.streamName).toBe('info-test')
    expect(info2.currentVersion).toBe(2)
  })

  it('should truncate before a version', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

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

    // Reading stream should only return events from version 2 onwards
    const reader = await journal.streamReader('truncate-reader')
    const stream = await reader.streamFor('truncate-test')
    expect(stream.entries.length).toBe(2) // Only version 2 and 3
  })

  it('should return not found when truncating non-existent stream', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    const result = await journal.truncateBefore('nonexistent-truncate', 1)
    expect(result.wasNotFound()).toBe(true)
  })

  it('should return not found when tombstoning non-existent stream', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    const result = await journal.tombstone('nonexistent-tombstone')
    expect(result.wasNotFound()).toBe(true)
  })

  it('should return not found when soft-deleting non-existent stream', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    const result = await journal.softDelete('nonexistent-soft-delete')
    expect(result.wasNotFound()).toBe(true)
  })

  it('should fail append with wrong specific version', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    // Create stream at version 1
    await journal.append('wrong-version-test', StreamState.NoStream, new AccountOpened('wv', 'WrongVersion', 100), Metadata.nullMetadata())

    // Try to append expecting version 5 (wrong)
    const result = await journal.append('wrong-version-test', 5, new FundsDeposited('wv', 50), Metadata.nullMetadata())
    expect(result.isConcurrencyViolation()).toBe(true)
  })

  it('should handle empty appendAll', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    // Append empty array
    const result = await journal.appendAll('empty-test', StreamState.NoStream, [], Metadata.nullMetadata())
    expect(result.isSuccess()).toBe(true)
  })

  it('should seek and rewind journal reader', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    // Append events
    await journal.append('seek-a', StreamState.NoStream, new AccountOpened('a', 'A', 100), Metadata.nullMetadata())
    await journal.append('seek-b', StreamState.NoStream, new AccountOpened('b', 'B', 200), Metadata.nullMetadata())
    await journal.append('seek-c', StreamState.NoStream, new AccountOpened('c', 'C', 300), Metadata.nullMetadata())

    const reader = await journal.journalReader('seek-reader')

    // Read all
    await reader.readNext(10)
    const pos = await reader.position()
    expect(pos).toBe(3)

    // Seek to position 1
    await reader.seek(1)
    const seekPos = await reader.position()
    expect(seekPos).toBe(1)

    // Read from position 1
    const entries = await reader.readNext(10)
    expect(entries.length).toBe(2) // Events 2 and 3

    // Rewind
    await reader.rewind()
    const rewindPos = await reader.position()
    expect(rewindPos).toBe(0)
  })

  it('should append with snapshot', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

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
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

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
    // Snapshot may be wrapped in ObjectState, check the data property
    const snapshotData = stream.snapshot?.data ?? stream.snapshot
    expect(snapshotData).toEqual(snapshot)
  })

  it('should get stream info for tombstoned stream', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    // Create and tombstone stream
    await journal.append('tombstone-info', StreamState.NoStream, new AccountOpened('ti', 'TI', 100), Metadata.nullMetadata())
    await journal.tombstone('tombstone-info')

    const info = await journal.streamInfo('tombstone-info')
    expect(info.isTombstoned).toBe(true)
  })

  it('should get stream info for soft-deleted stream', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    // Create and soft-delete stream
    await journal.append('soft-delete-info', StreamState.NoStream, new AccountOpened('sdi', 'SDI', 100), Metadata.nullMetadata())
    await journal.softDelete('soft-delete-info')

    const info = await journal.streamInfo('soft-delete-info')
    expect(info.isSoftDeleted).toBe(true)
  })

  it('should verify Entry properties including globalPosition', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    // Append events
    await journal.append('entry-props-1', StreamState.NoStream, new AccountOpened('ep1', 'EntryProps1', 100), Metadata.nullMetadata())
    await journal.append('entry-props-2', StreamState.NoStream, new AccountOpened('ep2', 'EntryProps2', 200), Metadata.nullMetadata())

    // Read via stream reader
    const reader = await journal.streamReader('entry-props-reader')
    const stream = await reader.streamFor('entry-props-1')

    expect(stream.entries.length).toBe(1)
    const entry = stream.entries[0]

    // Verify all Entry properties
    expect(entry.id).toBeDefined()
    expect(entry.id.length).toBe(26) // ULID length
    expect(entry.globalPosition).toBeGreaterThan(0)
    expect(entry.type).toBe('AccountOpened')
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
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    // Append to multiple streams
    await journal.append('gp-stream-a', StreamState.NoStream, new AccountOpened('gpa', 'A', 100), Metadata.nullMetadata())
    await journal.append('gp-stream-b', StreamState.NoStream, new AccountOpened('gpb', 'B', 200), Metadata.nullMetadata())
    await journal.append('gp-stream-a', 2, new FundsDeposited('gpa', 50), Metadata.nullMetadata())

    // Read via journal reader
    const reader = await journal.journalReader('gp-reader')
    const entries = await reader.readNext(10)

    expect(entries.length).toBe(3)

    // Verify globalPosition is monotonically increasing
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].globalPosition).toBeGreaterThan(entries[i - 1].globalPosition)
    }
  })

  it('should verify streamVersion on entries within a stream', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    // Append multiple events to same stream
    await journal.appendAll('sv-test', StreamState.NoStream, [
      new AccountOpened('sv', 'StreamVersion', 100),
      new FundsDeposited('sv', 50),
      new FundsDeposited('sv', 25)
    ] as Source<unknown>[], Metadata.nullMetadata())

    // Read stream
    const reader = await journal.streamReader('sv-reader')
    const stream = await reader.streamFor('sv-test')

    expect(stream.entries.length).toBe(3)
    expect(stream.entries[0].streamVersion).toBe(1)
    expect(stream.entries[1].streamVersion).toBe(2)
    expect(stream.entries[2].streamVersion).toBe(3)
  })

  it('should preserve metadata in entries', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    const metadata = Metadata.with(
      new Map([['correlationId', 'corr-123'], ['causationId', 'cause-456']]),
      'test-value',
      'create'
    )

    await journal.append('meta-test', StreamState.NoStream, new AccountOpened('mt', 'MetaTest', 100), metadata)

    // Read stream
    const reader = await journal.streamReader('meta-reader')
    const stream = await reader.streamFor('meta-test')

    expect(stream.entries.length).toBe(1)
    const entry = stream.entries[0]

    // Verify metadata is preserved
    const entryMetadata = JSON.parse(entry.metadata)
    expect(entryMetadata.operation).toBe('create')
    expect(entryMetadata.value).toBe('test-value')
  })

  it('should appendAllWith snapshot', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    const events = [
      new AccountOpened('aaw', 'AppendAllWith', 1000),
      new FundsDeposited('aaw', 500),
      new FundsDeposited('aaw', 250)
    ] as Source<unknown>[]

    const snapshot = { balance: 1750, name: 'AppendAllWith' }

    const result = await journal.appendAllWith(
      'append-all-with-test',
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
    const stream = await reader.streamFor('append-all-with-test')

    expect(stream.entries.length).toBe(3)
    expect(stream.snapshot).toBeDefined()
    const snapshotData = stream.snapshot?.data ?? stream.snapshot
    expect(snapshotData).toEqual(snapshot)
  })

  it('should return reader name', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    const reader = await journal.journalReader('named-reader')
    const name = await reader.name()
    expect(name).toBe('named-reader')
  })

  it('should handle EntryStream tombstoned state', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    // Create and tombstone stream
    await journal.append('tombstone-stream', StreamState.NoStream, new AccountOpened('ts', 'TS', 100), Metadata.nullMetadata())
    await journal.tombstone('tombstone-stream')

    // Read stream
    const reader = await journal.streamReader('tombstone-stream-reader')
    const stream = await reader.streamFor('tombstone-stream')

    expect(stream.isTombstoned).toBe(true)
    expect(stream.isSoftDeleted).toBe(false)
  })

  it('should handle EntryStream soft-deleted state', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    // Create and soft-delete stream
    await journal.append('soft-delete-stream', StreamState.NoStream, new AccountOpened('sds', 'SDS', 100), Metadata.nullMetadata())
    await journal.softDelete('soft-delete-stream')

    // Read stream
    const reader = await journal.streamReader('soft-delete-stream-reader')
    const stream = await reader.streamFor('soft-delete-stream')

    expect(stream.isSoftDeleted).toBe(true)
    expect(stream.isTombstoned).toBe(false)
  })

  it('should handle EntryStream empty state', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    // Read non-existent stream
    const reader = await journal.streamReader('empty-stream-reader')
    const stream = await reader.streamFor('nonexistent-stream-xyz')

    // Empty stream has no entries and version 0
    expect(stream.entries.length).toBe(0)
    expect(stream.streamVersion).toBe(0)
    expect(stream.isTombstoned).toBe(false)
    expect(stream.isSoftDeleted).toBe(false)
  })

  it('should return already tombstoned result', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    // Create and tombstone stream
    await journal.append('double-tombstone', StreamState.NoStream, new AccountOpened('dt', 'DT', 100), Metadata.nullMetadata())
    await journal.tombstone('double-tombstone')

    // Try to tombstone again
    const result = await journal.tombstone('double-tombstone')
    expect(result.wasAlreadyTombstoned()).toBe(true)
  })

  it('should return already deleted result for soft delete', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    // Create and soft-delete stream
    await journal.append('double-soft-delete', StreamState.NoStream, new AccountOpened('dsd', 'DSD', 100), Metadata.nullMetadata())
    await journal.softDelete('double-soft-delete')

    // Try to soft-delete again
    const result = await journal.softDelete('double-soft-delete')
    expect(result.wasAlreadyDeleted()).toBe(true)
  })

  it('should return tombstoned result when soft-deleting tombstoned stream', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    // Create and tombstone stream
    await journal.append('tombstone-then-soft', StreamState.NoStream, new AccountOpened('tts', 'TTS', 100), Metadata.nullMetadata())
    await journal.tombstone('tombstone-then-soft')

    // Try to soft-delete tombstoned stream - wasAlreadyDeleted() returns true and deletedAtVersion is -1 for tombstoned
    const result = await journal.softDelete('tombstone-then-soft')
    expect(result.wasAlreadyDeleted()).toBe(true)
    expect(result.deletedAtVersion).toBe(-1)
  })

  it('should return tombstoned result when truncating tombstoned stream', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    // Create and tombstone stream
    await journal.append('tombstone-then-truncate', StreamState.NoStream, new AccountOpened('ttt', 'TTT', 100), Metadata.nullMetadata())
    await journal.tombstone('tombstone-then-truncate')

    // Try to truncate tombstoned stream
    const result = await journal.truncateBefore('tombstone-then-truncate', 1)
    expect(result.wasTombstoned()).toBe(true)
  })

  it('should handle JournalReader max validation', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    const reader = await journal.journalReader('max-validation-reader')

    // Should throw for invalid max values
    await expect(reader.readNext(0)).rejects.toThrow('max must be greater than 0')
    await expect(reader.readNext(-1)).rejects.toThrow('max must be greater than 0')
  })

  it('should handle seek with negative position', async () => {
    journal = testStage.actorFor<PostgresJournal<string>>(
      {
        type: () => 'Journal',
        instantiator: () => ({
          instantiate: () => new PostgresJournal(config)
        })
      }
    )

    const reader = await journal.journalReader('seek-negative-reader')

    // Should throw for negative position
    await expect(reader.seek(-1)).rejects.toThrow('position cannot be negative')
  })
})
