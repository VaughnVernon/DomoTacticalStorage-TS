# Changelog

All notable changes to DomoTacticalStorage-TS will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-01-29

### Added

#### PostgreSQL Backend
- `PostgresConfig` - Configuration from connection string or pg Pool
- `PostgresJournal` - Full Journal implementation with optimistic concurrency
- `PostgresDocumentStore` - DocumentStore for query models and state persistence
- `PostgresStreamReader` - Stream reading with snapshot support
- `PostgresJournalReader` - Sequential journal reading with position persistence
- JSONB storage for efficient event data querying
- Connection pooling support via pg Pool

#### KurrentDB Backend
- `KurrentDBConfig` - Configuration from KurrentDB connection string
- `KurrentDBJournal` - Native KurrentDB/EventStoreDB integration
- `KurrentDBStreamReader` - Stream reading with backward iteration support
- `KurrentDBJournalReader` - All-stream subscription for projections
- UUID v7 for time-ordered event IDs (KurrentDB requirement)
- Native stream lifecycle (tombstone, soft-delete)

#### Cloudflare D1 Backend
- `D1Config` - Configuration from D1Database binding
- `D1Journal` - SQLite-based journal for edge computing
- `D1DocumentStore` - Document storage for Workers
- `D1StreamReader` - Stream reading optimized for D1
- `D1JournalReader` - Journal reading with position tracking
- ULID for k-sortable event IDs
- Miniflare support for local development and testing

#### Infrastructure
- ESM module resolution with NodeNext
- Subpath exports (`/postgres`, `/kurrentdb`, `/d1`)
- TypeScript declarations with source maps
- docker-compose.yml for PostgreSQL and KurrentDB
- Test runner script with selective backend testing
- Comprehensive test suite (34 tests across all backends)

### Dependencies

- Peer dependencies: `domo-tactical@^0.3.0`, `domo-actors@^1.2.0`
- Runtime: `pg@^8.11.0`, `@kurrent/kurrentdb-client@^1.1.0`, `ulid@^3.0.2`, `uuid@^13.0.0`
- Development: `miniflare@^3.20241018.0`, `vitest@^4.0.13`

[0.1.0]: https://github.com/VaughnVernon/DomoTacticalStorage-TS/releases/tag/v0.1.0
