// Copyright © 2012-2025 Vaughn Vernon. All rights reserved.
// Copyright © 2012-2025 Kalele, Inc. All rights reserved.
//
// Licensed under the Reciprocal Public License 1.5
//
// See: LICENSE.md in repository root directory
// See: https://opensource.org/license/rpl-1-5

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Stage, stage } from 'domo-actors'
import { Metadata, Result } from 'domo-tactical/store'
import { DomainEvent } from 'domo-tactical/model'
import { D1Config, D1DocumentStore } from '../../src/d1/index.js'
import { createD1TestContext, disposeD1TestContext, clearD1Data, D1TestContext } from './D1TestHelper.js'

interface UserState {
  name: string
  email: string
  age: number
}

interface ProductState {
  sku: string
  name: string
  price: number
}

describe('D1DocumentStore', () => {
  let context: D1TestContext
  let config: D1Config
  let store: D1DocumentStore
  let testStage: Stage

  beforeAll(async () => {
    // Create Miniflare D1 context
    context = await createD1TestContext(false, true)
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

    // Create fresh store actor for each test
    store = testStage.actorFor<D1DocumentStore>(
      {
        type: () => 'DocumentStore',
        instantiator: () => ({
          instantiate: () => new D1DocumentStore(config)
        })
      }
    )
  })

  it('should write and read a document', async () => {
    const user: UserState = { name: 'Alice', email: 'alice@example.com', age: 30 }

    // Write
    const writeResult = await store.write('user-123', 'User', user, 1)
    expect(writeResult.outcome.success).toBe(true)

    // Read
    const readResult = await store.read<UserState>('user-123', 'User')
    expect(readResult.outcome.success).toBe(true)
    expect(readResult.state).toEqual(user)
    expect(readResult.stateVersion).toBe(1)
  })

  it('should detect version conflict', async () => {
    const user: UserState = { name: 'Bob', email: 'bob@example.com', age: 25 }

    // Write version 1
    await store.write('user-456', 'User', user, 1)

    // Try to write version 1 again - should fail
    const result = await store.write('user-456', 'User', { ...user, age: 26 }, 1)
    expect(result.outcome.success).toBe(false)
    expect(result.outcome.error?.result).toBe(Result.ConcurrencyViolation)
  })

  it('should update a document with higher version', async () => {
    const user: UserState = { name: 'Charlie', email: 'charlie@example.com', age: 35 }

    // Write version 1
    await store.write('user-789', 'User', user, 1)

    // Write version 2
    const updated = { ...user, age: 36 }
    const result = await store.write('user-789', 'User', updated, 2)
    expect(result.outcome.success).toBe(true)

    // Read back
    const readResult = await store.read<UserState>('user-789', 'User')
    expect(readResult.state?.age).toBe(36)
    expect(readResult.stateVersion).toBe(2)
  })

  it('should read multiple documents', async () => {
    // Write multiple documents
    await store.write('user-a', 'User', { name: 'A', email: 'a@test.com', age: 20 }, 1)
    await store.write('user-b', 'User', { name: 'B', email: 'b@test.com', age: 21 }, 1)

    // Read all
    const result = await store.readAll([
      { id: 'user-a', type: 'User' },
      { id: 'user-b', type: 'User' }
    ])

    expect(result.outcome.success).toBe(true)
    expect(result.bundles.length).toBe(2)
  })

  it('should return not found for missing document', async () => {
    const result = await store.read('nonexistent', 'User')
    expect(result.outcome.success).toBe(false)
    expect(result.outcome.error?.result).toBe(Result.NotFound)
  })

  it('should handle different document types', async () => {
    const user: UserState = { name: 'Eve', email: 'eve@example.com', age: 28 }
    const product: ProductState = { sku: 'SKU-001', name: 'Widget', price: 29.99 }

    // Write different types
    await store.write('item-1', 'User', user, 1)
    await store.write('item-1', 'Product', product, 1)

    // Read back - same id, different types
    const userResult = await store.read<UserState>('item-1', 'User')
    const productResult = await store.read<ProductState>('item-1', 'Product')

    expect(userResult.outcome.success).toBe(true)
    expect(userResult.state?.name).toBe('Eve')

    expect(productResult.outcome.success).toBe(true)
    expect(productResult.state?.sku).toBe('SKU-001')
  })

  it('should write document with metadata', async () => {
    const user: UserState = { name: 'Frank', email: 'frank@example.com', age: 40 }
    const metadata = Metadata.with(
      new Map([['correlationId', 'corr-123'], ['causationId', 'cause-456']]),
      'test-value',
      'create'
    )

    // Write with metadata
    const writeResult = await store.write('user-meta', 'User', user, 1, [], metadata)
    expect(writeResult.outcome.success).toBe(true)

    // Read back and verify metadata
    const readResult = await store.read<UserState>('user-meta', 'User')
    expect(readResult.outcome.success).toBe(true)
    expect(readResult.metadata?.operation).toBe('create')
    expect(readResult.metadata?.value).toBe('test-value')
  })

  it('should handle readAll with partial results', async () => {
    // Write only one document
    await store.write('user-exists', 'User', { name: 'Grace', email: 'grace@test.com', age: 22 }, 1)

    // Read both existing and non-existing
    const result = await store.readAll([
      { id: 'user-exists', type: 'User' },
      { id: 'user-missing', type: 'User' }
    ])

    // Should return partial results
    expect(result.outcome.success).toBe(false)
    expect(result.outcome.error?.result).toBe(Result.NotAllFound)
    expect(result.bundles.length).toBe(1)
    expect(result.bundles[0].id).toBe('user-exists')
  })

  it('should reject write with lower version', async () => {
    const user: UserState = { name: 'Henry', email: 'henry@example.com', age: 45 }

    // Write version 2
    await store.write('user-lower', 'User', user, 2)

    // Try to write version 1 - should fail
    const result = await store.write('user-lower', 'User', { ...user, age: 46 }, 1)
    expect(result.outcome.success).toBe(false)
    expect(result.outcome.error?.result).toBe(Result.ConcurrencyViolation)
  })

  it('should handle readAll with empty bundles', async () => {
    // Read with empty array
    const result = await store.readAll([])
    expect(result.outcome.success).toBe(true)
    expect(result.bundles.length).toBe(0)
  })

  it('should write document with sources for causation tracking', async () => {
    // Define a domain event for testing - must extend DomainEvent
    class UserCreated extends DomainEvent {
      constructor(public readonly userId: string, public readonly name: string) {
        super()
      }

      override id(): string {
        return this.userId
      }
    }

    const user: UserState = { name: 'Ivan', email: 'ivan@example.com', age: 30 }
    const sources = [new UserCreated('ivan-1', 'Ivan')]

    // Write with sources
    const writeResult = await store.write('user-sources', 'User', user, 1, sources)
    expect(writeResult.outcome.success).toBe(true)

    // Verify document was written
    const readResult = await store.read<UserState>('user-sources', 'User')
    expect(readResult.outcome.success).toBe(true)
    expect(readResult.state?.name).toBe('Ivan')
  })

  it('should handle multiple rapid writes to different documents', async () => {
    // Write multiple documents concurrently
    const writes = await Promise.all([
      store.write('rapid-1', 'User', { name: 'User1', email: 'u1@test.com', age: 21 }, 1),
      store.write('rapid-2', 'User', { name: 'User2', email: 'u2@test.com', age: 22 }, 1),
      store.write('rapid-3', 'User', { name: 'User3', email: 'u3@test.com', age: 23 }, 1)
    ])

    // All should succeed
    expect(writes[0].outcome.success).toBe(true)
    expect(writes[1].outcome.success).toBe(true)
    expect(writes[2].outcome.success).toBe(true)

    // Read all back
    const result = await store.readAll([
      { id: 'rapid-1', type: 'User' },
      { id: 'rapid-2', type: 'User' },
      { id: 'rapid-3', type: 'User' }
    ])

    expect(result.outcome.success).toBe(true)
    expect(result.bundles.length).toBe(3)
  })

  it('should preserve state data types correctly', async () => {
    interface ComplexState {
      string: string
      number: number
      float: number
      boolean: boolean
      array: number[]
      nested: { a: string; b: number }
      nullable: string | null
    }

    const complex: ComplexState = {
      string: 'hello',
      number: 42,
      float: 3.14159,
      boolean: true,
      array: [1, 2, 3],
      nested: { a: 'nested', b: 99 },
      nullable: null
    }

    await store.write('complex-1', 'Complex', complex, 1)

    const result = await store.read<ComplexState>('complex-1', 'Complex')
    expect(result.outcome.success).toBe(true)
    expect(result.state).toEqual(complex)
    expect(result.state?.float).toBeCloseTo(3.14159)
    expect(result.state?.array).toEqual([1, 2, 3])
    expect(result.state?.nested.a).toBe('nested')
    expect(result.state?.nullable).toBeNull()
  })

  it('should return error when reading with empty id', async () => {
    const result = await store.read('', 'User')
    expect(result.outcome.success).toBe(false)
    expect(result.outcome.error?.result).toBe(Result.Error)
    expect(result.stateVersion).toBe(-1)
  })

  it('should return error when reading with empty type', async () => {
    const result = await store.read('user-123', '')
    expect(result.outcome.success).toBe(false)
    expect(result.outcome.error?.result).toBe(Result.Error)
    expect(result.stateVersion).toBe(-1)
  })

  it('should return error when writing null state', async () => {
    const result = await store.write('user-null', 'User', null as unknown as UserState, 1)
    expect(result.outcome.success).toBe(false)
    expect(result.outcome.error?.result).toBe(Result.Error)
  })

  it('should return all not found when reading all missing documents', async () => {
    const result = await store.readAll([
      { id: 'missing-1', type: 'User' },
      { id: 'missing-2', type: 'User' }
    ])

    expect(result.outcome.success).toBe(false)
    expect(result.outcome.error?.result).toBe(Result.NotAllFound)
    expect(result.bundles.length).toBe(0)
  })

  it('should return success value in outcome', async () => {
    const user: UserState = { name: 'OutcomeTest', email: 'outcome@test.com', age: 33 }

    await store.write('outcome-test', 'User', user, 1)

    const result = await store.read<UserState>('outcome-test', 'User')
    expect(result.outcome.success).toBe(true)
    expect(result.outcome.value).toEqual(user)
  })

  it('should return write result with sources', async () => {
    class TestEvent extends DomainEvent {
      constructor(public readonly data: string) {
        super()
      }

      override id(): string {
        return this.data
      }
    }

    const user: UserState = { name: 'SourcesTest', email: 'sources@test.com', age: 25 }
    const sources = [new TestEvent('test-data')]

    const result = await store.write('sources-test', 'User', user, 1, sources)
    expect(result.outcome.success).toBe(true)
    expect(result.sources).toEqual(sources)
    expect(result.state).toEqual(user)
    expect(result.id).toBe('sources-test')
  })

  it('should handle readAll returning found bundles', async () => {
    // Write documents
    await store.write('bundle-1', 'User', { name: 'Bundle1', email: 'b1@test.com', age: 1 }, 1)
    await store.write('bundle-2', 'User', { name: 'Bundle2', email: 'b2@test.com', age: 2 }, 1)
    await store.write('bundle-3', 'User', { name: 'Bundle3', email: 'b3@test.com', age: 3 }, 1)

    const result = await store.readAll([
      { id: 'bundle-1', type: 'User' },
      { id: 'bundle-2', type: 'User' },
      { id: 'bundle-3', type: 'User' }
    ])

    expect(result.outcome.success).toBe(true)
    expect(result.bundles.length).toBe(3)
    expect(result.bundles[0].state).toEqual({ name: 'Bundle1', email: 'b1@test.com', age: 1 })
    expect(result.bundles[1].state).toEqual({ name: 'Bundle2', email: 'b2@test.com', age: 2 })
    expect(result.bundles[2].state).toEqual({ name: 'Bundle3', email: 'b3@test.com', age: 3 })
  })

  it('should verify D1Config create and getDatabase', async () => {
    // The config is already created in beforeAll
    expect(config).toBeDefined()
    const db = config.getDatabase()
    expect(db).toBeDefined()

    // Verify we can use the database
    const result = await db.prepare('SELECT 1 as test').first<{ test: number }>()
    expect(result?.test).toBe(1)
  })
})
