# DomoTacticalStorage-TS

[![License: RPL-1.5](https://img.shields.io/badge/License-RPL--1.5-blue.svg)](https://opensource.org/license/rpl-1-5)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![npm version](https://img.shields.io/npm/v/domo-tactical-storage.svg)](https://www.npmjs.com/package/domo-tactical-storage)
[![V8](https://img.shields.io/badge/V8-Compatible-orange.svg)](https://v8.dev/)
[![Runtimes](https://img.shields.io/badge/Runtimes-Node.js%20%7C%20Cloudflare%20Workers-blue.svg)](https://github.com/VaughnVernon/DomoTacticalStorage-TS#requirements)
[![npm downloads](https://img.shields.io/npm/dt/domo-tactical-storage.svg)](https://www.npmjs.com/package/domo-tactical-storage)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-12+-336791.svg?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![KurrentDB](https://img.shields.io/badge/KurrentDB-26.0+-purple.svg)](https://www.kurrent.io/)
[![Cloudflare D1](https://img.shields.io/badge/Cloudflare-D1-F38020.svg?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/d1/)
[![GitHub stars](https://img.shields.io/github/stars/VaughnVernon/DomoTacticalStorage-TS.svg)](https://github.com/VaughnVernon/DomoTacticalStorage-TS/stargazers)

Persistent storage backends for [DomoTactical-TS](https://github.com/VaughnVernon/DomoTactical-TS) - providing production-ready Journal and DocumentStore implementations for PostgreSQL, KurrentDB/EventStoreDB, and Cloudflare D1.

## Overview

DomoTacticalStorage-TS extends DomoTactical with pluggable persistence backends:

| Backend | Journal | DocumentStore | Best For |
|---------|---------|---------------|----------|
| **PostgreSQL** | Yes | Yes | Traditional deployments, ACID compliance |
| **KurrentDB** | Yes | - | Event-first architectures, native event streaming |
| **Cloudflare D1** | Yes | Yes | Edge computing, serverless, global distribution |

All implementations are actor-based, async-first, and fully compatible with DomoTactical's event sourcing and CQRS patterns.

## Installation

```bash
npm install domo-tactical-storage domo-tactical domo-actors
```

## Quick Start

```typescript
import { stage } from 'domo-actors'
import { PostgresConfig, PostgresJournal } from 'domo-tactical-storage/postgres'
// Or: import { KurrentDBConfig, KurrentDBJournal } from 'domo-tactical-storage/kurrentdb'
// Or: import { D1Config, D1Journal } from 'domo-tactical-storage/d1'

// Create configuration
const config = PostgresConfig.fromConnectionString(process.env.DATABASE_URL!)

// Create journal as an actor
const journal = stage().actorFor({
  type: () => 'Journal',
  instantiator: () => ({ instantiate: () => new PostgresJournal(config) })
})

// Register for your context
stage().registerValue('domo-tactical:myapp.journal', journal)

// Now your EventSourcedEntity classes will automatically use this journal
```

## Documentation

- **[DomoTacticalStorage Guide](docs/DomoTacticalStorage.md)** - Complete setup and usage documentation
- **[DomoTactical Documentation](https://github.com/VaughnVernon/DomoTactical-TS/blob/main/docs/DomoTactical.md)** - Core framework documentation
- **[DomoActors Documentation](https://github.com/VaughnVernon/DomoActors-TS)** - Actor model foundation

## Features

- **PostgreSQL Backend**
  - Full Journal implementation with optimistic concurrency
  - DocumentStore for query models
  - JSONB storage for efficient querying
  - Connection pooling support

- **KurrentDB Backend**
  - Native event store integration
  - UUID v7 for time-ordered event IDs
  - Stream lifecycle management (tombstone, soft-delete)
  - Subscription support for projections

- **Cloudflare D1 Backend**
  - Edge-native SQLite storage
  - Journal and DocumentStore implementations
  - Optimized for Workers runtime
  - ULID for k-sortable event IDs

## Requirements

- Node.js >= 18.0.0
- domo-tactical >= 0.3.0
- domo-actors >= 1.2.0

### Backend-Specific Requirements

- **PostgreSQL**: PostgreSQL 12+ with JSONB support
- **KurrentDB**: KurrentDB 26.0+
- **D1**: Cloudflare Workers with D1 binding

## License

Licensed under the Reciprocal Public License 1.5 (RPL-1.5)

See [LICENSE.md](LICENSE.md) for details.

## Credits

- **VLINGO/XOOM Platform** - Original Java implementation
- **DomoTactical-TS** - Core tactical patterns
- **DomoActors-TS** - Actor model foundation
- Authored by Vaughn Vernon
