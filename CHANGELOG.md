# Changelog

All notable changes to DomoTacticalStorage-TS will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-02-06

### Changed

#### domo-tactical 0.5.0 Compatibility
- Updated `PostgresStreamReader`, `KurrentDBStreamReader`, `D1StreamReader` to use stored type name string instead of `Object` constructor for `ObjectState`
- Updated `PostgresDocumentStore`, `D1DocumentStore` to use `StoreTypeMapper` for symbolic and concrete type name conversion (default uses PascalCase ↔ kebab-case)
- Added `state_type` and `state_type_version` columns to documents table schema
- Updated peer dependency to `domo-tactical@^0.5.0`

### Added

#### Testing
- Comprehensive tests for Entry properties (`globalPosition`, `streamVersion`, `typeVersion`, `entryData`, `metadata`)
- Tests for `appendAllWith()`, `JournalReader.name()`, and `EntryStream` states (tombstoned, softDeleted, empty)
- Tests for `KurrentDBConfig` factory methods (`create()`, `fromConnectionString()`, `fromClient()`)
- Tests for `DocumentStore` edge cases (empty id/type, null state, readAll with missing documents)
- Added `npm run test:all-coverage` for combined coverage reporting across all backends
- Added `--coverage` flag to test runner script
- Achieved 91%+ code coverage across all backends (147 tests total)

#### Documentation
- Added comprehensive Testing section to `docs/DomoTacticalStorage.md`
- Added separate Quick Start examples for KurrentDB and PostgreSQL in README
- Updated schema documentation with `state_type` and `state_type_version` columns

#### Build & Publish
- Updated `prepublishOnly` and `preversion` scripts to use `test:all` (runs all tests with infrastructure)

### Fixed
- Fixed KurrentDB connection URL format in test runner (`esdb://` instead of `kurrentdb://`)

## [0.1.0] - 2026-02-04

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

[0.2.0]: https://github.com/VaughnVernon/DomoTacticalStorage-TS/releases/tag/v0.2.0
[0.1.0]: https://github.com/VaughnVernon/DomoTacticalStorage-TS/releases/tag/v0.1.0
