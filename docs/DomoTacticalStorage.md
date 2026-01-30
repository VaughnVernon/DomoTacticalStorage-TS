# DomoTacticalStorage-TS Documentation

This guide covers the persistent storage backends for DomoTactical-TS. For core concepts like event sourcing, CQRS, projections, and domain modeling, see the [DomoTactical Documentation](https://github.com/VaughnVernon/DomoTactical-TS/blob/main/docs/DomoTactical.md).

## Table of Contents

- [Installation](#installation)
- [Backend Overview](#backend-overview)
- [PostgreSQL Backend](#postgresql-backend)
- [KurrentDB Backend](#kurrentdb-backend)
- [Cloudflare D1 Backend](#cloudflare-d1-backend)
- [Configuration Patterns](#configuration-patterns)
- [Testing](#testing)
- [Migration from InMemory](#migration-from-inmemory)

## Installation

```bash
npm install domo-tactical-storage domo-tactical domo-actors
```

### Peer Dependencies

This package requires:
- `domo-tactical` >= 0.3.0
- `domo-actors` >= 1.2.0

### Backend-Specific Dependencies

The package includes all backend dependencies. No additional installs required:
- PostgreSQL: Uses `pg` driver
- KurrentDB: Uses `@kurrent/kurrentdb-client`
- D1: Uses Cloudflare Workers types (included in devDependencies)

## Backend Overview

### Import Paths

Each backend has its own subpath export:

```typescript
// PostgreSQL
import { PostgresConfig, PostgresJournal, PostgresDocumentStore } from 'domo-tactical-storage/postgres'

// KurrentDB
import { KurrentDBConfig, KurrentDBJournal } from 'domo-tactical-storage/kurrentdb'

// Cloudflare D1
import { D1Config, D1Journal, D1DocumentStore } from 'domo-tactical-storage/d1'

// All exports (not recommended - use specific imports)
import { PostgresJournal, KurrentDBJournal, D1Journal } from 'domo-tactical-storage'
```

### Feature Matrix

| Feature | PostgreSQL | KurrentDB | D1 |
|---------|------------|-----------|-----|
| Journal | Yes | Yes | Yes |
| DocumentStore | Yes | - | Yes |
| StreamReader | Yes | Yes | Yes |
| JournalReader | Yes | Yes | Yes |
| Snapshots | Yes | Yes | Yes |
| Tombstone | Yes | Yes | Yes |
| Soft Delete | Yes | Yes | Yes |
| Truncate Before | Yes | - | Yes |
| Event ID Format | ULID | UUID v7 | ULID |

## PostgreSQL Backend

### Setup

1. **Create the database schema:**

```sql
-- Journal tables
CREATE TABLE streams (
    stream_name VARCHAR(500) PRIMARY KEY,
    current_version BIGINT NOT NULL DEFAULT 0,
    is_tombstoned BOOLEAN NOT NULL DEFAULT FALSE,
    is_soft_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at_version BIGINT,
    truncate_before BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE journal_entries (
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

CREATE TABLE snapshots (
    stream_name VARCHAR(500) PRIMARY KEY,
    snapshot_type VARCHAR(500) NOT NULL,
    snapshot_type_version INT NOT NULL DEFAULT 1,
    snapshot_data JSONB NOT NULL,
    snapshot_version BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE journal_reader_positions (
    reader_name VARCHAR(500) PRIMARY KEY,
    current_position BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_journal_entries_stream ON journal_entries(stream_name);
CREATE INDEX idx_journal_entries_stream_version ON journal_entries(stream_name, stream_version);
CREATE INDEX idx_journal_entries_type ON journal_entries(entry_type);

-- Document store tables
CREATE TABLE documents (
    id VARCHAR(500) NOT NULL,
    type VARCHAR(500) NOT NULL,
    state JSONB NOT NULL,
    state_version BIGINT NOT NULL,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (type, id)
);

CREATE TABLE document_sources (
    id BIGSERIAL PRIMARY KEY,
    document_id VARCHAR(500) NOT NULL,
    document_type VARCHAR(500) NOT NULL,
    source_type VARCHAR(500) NOT NULL,
    source_type_version INT NOT NULL DEFAULT 1,
    source_data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_documents_type ON documents(type);
CREATE INDEX idx_document_sources_document ON document_sources(document_type, document_id);
```

2. **Configure and create actors:**

```typescript
import { stage } from 'domo-actors'
import { Pool } from 'pg'
import { PostgresConfig, PostgresJournal, PostgresDocumentStore } from 'domo-tactical-storage/postgres'

// Option 1: From connection string
const config = PostgresConfig.fromConnectionString(process.env.DATABASE_URL!)

// Option 2: From existing pool
const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'myapp',
  user: 'postgres',
  password: 'secret'
})
const config = PostgresConfig.fromPool(pool)

// Create journal actor
const journal = stage().actorFor({
  type: () => 'Journal',
  instantiator: () => ({ instantiate: () => new PostgresJournal(config) })
})

// Create document store actor
const documentStore = stage().actorFor({
  type: () => 'DocumentStore',
  instantiator: () => ({ instantiate: () => new PostgresDocumentStore(config) })
})

// Register for context
stage().registerValue('domo-tactical:myapp.journal', journal)
stage().registerValue('domo-tactical:myapp.documentStore', documentStore)
```

### Connection Pooling

PostgresConfig manages connection pooling automatically when created from a connection string. For production deployments, consider tuning pool settings:

```typescript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                    // Maximum pool size
  idleTimeoutMillis: 30000,   // Close idle connections after 30s
  connectionTimeoutMillis: 2000 // Timeout for new connections
})
const config = PostgresConfig.fromPool(pool)
```

## KurrentDB Backend

KurrentDB (formerly EventStoreDB) is purpose-built for event sourcing with native stream support.

### Setup

1. **Start KurrentDB:**

```bash
# Docker
docker run -d --name kurrentdb \
  -p 2113:2113 -p 1113:1113 \
  kurrentplatform/kurrentdb:latest \
  --insecure --run-projections=All

# Or using docker-compose (see docker-compose.yml in this repo)
docker compose up -d kurrentdb
```

2. **Configure and create actors:**

```typescript
import { stage } from 'domo-actors'
import { KurrentDBConfig, KurrentDBJournal } from 'domo-tactical-storage/kurrentdb'

// Create configuration
const config = KurrentDBConfig.fromConnectionString('kurrentdb://localhost:2113?tls=false')

// For secure connections
const secureConfig = KurrentDBConfig.fromConnectionString(
  'kurrentdb://admin:changeit@localhost:2113'
)

// Create journal actor
const journal = stage().actorFor({
  type: () => 'Journal',
  instantiator: () => ({ instantiate: () => new KurrentDBJournal(config) })
})

// Register for context
stage().registerValue('domo-tactical:myapp.journal', journal)
```

### Event ID Format

KurrentDBJournal uses UUID v7 for event IDs, providing:
- Time-ordered IDs (events sort chronologically by ID)
- Global uniqueness
- Compatibility with KurrentDB's UUID requirement

### Stream Lifecycle

KurrentDB has native support for stream lifecycle operations:

```typescript
// Tombstone - permanent deletion, stream cannot be reopened
await journal.tombstone('order-123')

// Soft delete - stream can be reopened by appending
await journal.softDelete('order-456')

// Check stream state
const info = await journal.streamInfo('order-123')
if (info.isTombstoned) {
  console.log('Stream permanently deleted')
}
```

### Projections and Subscriptions

For reading from KurrentDB streams:

```typescript
// Create stream reader for a specific stream
const streamReader = await journal.streamReader('my-reader')
const stream = await streamReader.streamFor('account-123')

// Create journal reader for all streams (projections)
const journalReader = await journal.journalReader('projection-consumer')
const entries = await journalReader.readNext(100)
```

## Cloudflare D1 Backend

D1 provides edge-native SQLite storage for Cloudflare Workers.

### Setup

1. **Create D1 database (in wrangler.toml):**

```toml
[[d1_databases]]
binding = "DB"
database_name = "myapp-db"
database_id = "your-database-id"
```

2. **Create schema (via Wrangler):**

```bash
wrangler d1 execute myapp-db --file=./schema.sql
```

Schema SQL:
```sql
-- Journal tables
CREATE TABLE IF NOT EXISTS streams (
    stream_name TEXT PRIMARY KEY,
    current_version INTEGER NOT NULL DEFAULT 0,
    is_tombstoned INTEGER NOT NULL DEFAULT 0,
    is_soft_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at_version INTEGER,
    truncate_before INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journal_entries (
    global_position INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT NOT NULL,
    stream_name TEXT NOT NULL,
    stream_version INTEGER NOT NULL,
    entry_type TEXT NOT NULL,
    entry_type_version INTEGER NOT NULL DEFAULT 1,
    entry_data TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(stream_name, stream_version)
);

CREATE TABLE IF NOT EXISTS snapshots (
    stream_name TEXT PRIMARY KEY,
    snapshot_type TEXT NOT NULL,
    snapshot_type_version INTEGER NOT NULL DEFAULT 1,
    snapshot_data TEXT NOT NULL,
    snapshot_version INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journal_reader_positions (
    reader_name TEXT PRIMARY KEY,
    current_position INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_journal_entries_stream ON journal_entries(stream_name);
CREATE INDEX IF NOT EXISTS idx_journal_entries_stream_version ON journal_entries(stream_name, stream_version);
CREATE INDEX IF NOT EXISTS idx_journal_entries_type ON journal_entries(entry_type);

-- Document store tables
CREATE TABLE IF NOT EXISTS documents (
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    state TEXT NOT NULL,
    state_version INTEGER NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (type, id)
);

CREATE TABLE IF NOT EXISTS document_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL,
    document_type TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_type_version INTEGER NOT NULL DEFAULT 1,
    source_data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type);
CREATE INDEX IF NOT EXISTS idx_document_sources_document ON document_sources(document_type, document_id);
```

3. **Use in Workers:**

```typescript
import { stage } from 'domo-actors'
import { D1Config, D1Journal, D1DocumentStore } from 'domo-tactical-storage/d1'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Create configuration from D1 binding
    const config = D1Config.create(env.DB)

    // Create actors
    const journal = stage().actorFor({
      type: () => 'Journal',
      instantiator: () => ({ instantiate: () => new D1Journal(config) })
    })

    const documentStore = stage().actorFor({
      type: () => 'DocumentStore',
      instantiator: () => ({ instantiate: () => new D1DocumentStore(config) })
    })

    // Use in your Worker...
    return new Response('OK')
  }
}

interface Env {
  DB: D1Database
}
```

### Local Development with Miniflare

For local development and testing, use Miniflare:

```typescript
import { Miniflare } from 'miniflare'
import { D1Config, D1Journal } from 'domo-tactical-storage/d1'

const miniflare = new Miniflare({
  modules: true,
  script: `export default { async fetch() { return new Response('OK') } }`,
  d1Databases: ['DB']
})

const db = await miniflare.getD1Database('DB')
const config = D1Config.create(db)

// Run schema migrations
await db.prepare(`CREATE TABLE IF NOT EXISTS streams (...)`).run()

// Create journal
const journal = stage().actorFor({
  type: () => 'Journal',
  instantiator: () => ({ instantiate: () => new D1Journal(config) })
})
```

## Configuration Patterns

### Multi-Context Setup

When using multiple bounded contexts, each can have its own storage:

```typescript
import { eventSourcedContextFor } from 'domo-tactical/model/sourcing'
import { PostgresConfig, PostgresJournal } from 'domo-tactical-storage/postgres'

// Bank context uses PostgreSQL
const bankConfig = PostgresConfig.fromConnectionString(process.env.BANK_DB_URL!)
const bankJournal = stage().actorFor({
  type: () => 'BankJournal',
  instantiator: () => ({ instantiate: () => new PostgresJournal(bankConfig) })
})
stage().registerValue('domo-tactical:bank.journal', bankJournal)

// Orders context uses KurrentDB
const ordersConfig = KurrentDBConfig.fromConnectionString(process.env.KURRENTDB_URL!)
const ordersJournal = stage().actorFor({
  type: () => 'OrdersJournal',
  instantiator: () => ({ instantiate: () => new KurrentDBJournal(ordersConfig) })
})
stage().registerValue('domo-tactical:orders.journal', ordersJournal)

// Define context-specific entities
const BankEntity = eventSourcedContextFor('bank')
const OrdersEntity = eventSourcedContextFor('orders')

class Account extends BankEntity { /* uses PostgreSQL */ }
class Order extends OrdersEntity { /* uses KurrentDB */ }
```

### Custom Supervisors

Use custom supervisors for specialized error handling:

```typescript
import { stage, Supervisor, Action } from 'domo-actors'
import { PostgresJournal } from 'domo-tactical-storage/postgres'

class StorageSupervisor implements Supervisor {
  async supervise(error: Error, actorType: string): Promise<Action> {
    console.error(`Storage error in ${actorType}:`, error)

    // Retry transient errors
    if (error.message.includes('connection')) {
      return 'restart'
    }

    // Escalate permanent failures
    return 'escalate'
  }
}

// Create supervisor
const supervisor = stage().actorFor({
  type: () => 'storage-supervisor',
  instantiator: () => ({ instantiate: () => new StorageSupervisor() })
})

// Create journal under supervisor
const journal = stage().actorFor(
  {
    type: () => 'Journal',
    instantiator: () => ({ instantiate: () => new PostgresJournal(config) })
  },
  undefined,
  'storage-supervisor'  // Supervisor name
)
```

## Testing

### Using InMemory for Tests

Continue using InMemory implementations for unit tests:

```typescript
import { TestJournal, TestDocumentStore } from 'domo-tactical/testkit'

describe('Account', () => {
  it('should track balance', async () => {
    const journal = new TestJournal<string>()
    const account = new Account('acc-1')
    account.setJournal(journal)

    await account.open(1000)
    expect(account.getBalance()).toBe(1000)
  })
})
```

### Integration Tests with Real Backends

For integration tests, use Docker:

```typescript
import { PostgresConfig, PostgresJournal } from 'domo-tactical-storage/postgres'
import { Pool } from 'pg'

describe('PostgresJournal Integration', () => {
  let pool: Pool
  let config: PostgresConfig

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.TEST_POSTGRES_URL
    })
    config = PostgresConfig.fromPool(pool)

    // Run migrations
    await pool.query(`CREATE TABLE IF NOT EXISTS streams ...`)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE streams, journal_entries, snapshots RESTART IDENTITY CASCADE')
  })

  it('should persist events', async () => {
    const journal = stage().actorFor({
      type: () => 'Journal',
      instantiator: () => ({ instantiate: () => new PostgresJournal(config) })
    })

    // Test...
  })
})
```

### Running Tests

This package includes comprehensive tests:

```bash
# Run all tests
npm test

# Run specific backend tests
npm run test:postgres    # Requires PostgreSQL
npm run test:kurrentdb   # Requires KurrentDB
npm run test:d1          # Uses Miniflare (no external deps)

# Run all with infrastructure
npm run test:all         # Starts Docker, runs all, stops Docker
npm run test:all:keep    # Same but keeps containers running
```

## Migration from InMemory

When moving from InMemory to persistent storage:

1. **No code changes required for entities** - They use the journal registered for their context

2. **Update infrastructure setup:**

```typescript
// Before (InMemory)
import { InMemoryJournal } from 'domo-tactical'
const journal = stage().actorFor({
  type: () => 'Journal',
  instantiator: () => ({ instantiate: () => new InMemoryJournal() })
})

// After (PostgreSQL)
import { PostgresConfig, PostgresJournal } from 'domo-tactical-storage/postgres'
const config = PostgresConfig.fromConnectionString(process.env.DATABASE_URL!)
const journal = stage().actorFor({
  type: () => 'Journal',
  instantiator: () => ({ instantiate: () => new PostgresJournal(config) })
})
```

3. **Deploy schema** - Run the appropriate SQL migrations

4. **Data migration** (if needed) - Export from InMemory and import to new backend

## License

Licensed under the Reciprocal Public License 1.5 (RPL-1.5)
