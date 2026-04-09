// Copyright © 2012-2026 Vaughn Vernon. All rights reserved.
// Copyright © 2012-2026 Kalele, Inc. All rights reserved.
//
// See: LICENSE.md in repository root directory
//
// This file is part of DomoTacticalStorage-TS.
//
// DomoTacticalStorage-TS is free software: you can redistribute it and/or
// modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version.
//
// DomoTacticalStorage-TS is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with DomoTacticalStorage-TS. If not, see <https://www.gnu.org/licenses/>.

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
