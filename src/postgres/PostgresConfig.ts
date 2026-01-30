// Copyright © 2012-2025 Vaughn Vernon. All rights reserved.
// Copyright © 2012-2025 Kalele, Inc. All rights reserved.
//
// Licensed under the Reciprocal Public License 1.5
//
// See: LICENSE.md in repository root directory
// See: https://opensource.org/license/rpl-1-5

import { Pool, PoolConfig } from 'pg'

/**
 * Configuration for PostgreSQL storage backends.
 *
 * Wraps a pg Pool instance and provides connection management.
 *
 * @example
 * ```typescript
 * const config = PostgresConfig.create({
 *   host: 'localhost',
 *   port: 5432,
 *   database: 'mydb',
 *   user: 'myuser',
 *   password: 'mypassword'
 * })
 *
 * // Or from connection string
 * const config = PostgresConfig.fromConnectionString('postgresql://user:pass@localhost:5432/mydb')
 *
 * // Use with journal
 * const journal = new PostgresJournal(config)
 * ```
 */
export class PostgresConfig {
  private readonly pool: Pool

  private constructor(pool: Pool) {
    this.pool = pool
  }

  /**
   * Create a PostgresConfig from pool configuration options.
   */
  static create(config: PoolConfig): PostgresConfig {
    const pool = new Pool(config)
    return new PostgresConfig(pool)
  }

  /**
   * Create a PostgresConfig from a connection string.
   */
  static fromConnectionString(connectionString: string): PostgresConfig {
    const pool = new Pool({ connectionString })
    return new PostgresConfig(pool)
  }

  /**
   * Create a PostgresConfig from an existing Pool instance.
   */
  static fromPool(pool: Pool): PostgresConfig {
    return new PostgresConfig(pool)
  }

  /**
   * Get the underlying Pool instance.
   */
  getPool(): Pool {
    return this.pool
  }

  /**
   * Close the connection pool.
   */
  async close(): Promise<void> {
    await this.pool.end()
  }
}
