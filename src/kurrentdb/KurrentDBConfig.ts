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

import { KurrentDBClient } from '@kurrent/kurrentdb-client'

/**
 * Connection options for KurrentDB/EventStoreDB.
 */
export interface KurrentDBConnectionOptions {
  /** EventStoreDB endpoint (e.g., 'localhost:2113') */
  endpoint: string
  /** Use TLS connection */
  tls?: boolean
  /** TLS verification options */
  tlsVerifyCert?: boolean
  /** Keepalive interval in milliseconds */
  keepAliveInterval?: number
  /** Keepalive timeout in milliseconds */
  keepAliveTimeout?: number
}

/**
 * Configuration for KurrentDB/EventStoreDB storage backends.
 *
 * Wraps an KurrentDBClient instance for use with journal.
 *
 * @example
 * ```typescript
 * // Connect to local EventStoreDB
 * const config = KurrentDBConfig.create({
 *   endpoint: 'localhost:2113',
 *   tls: false
 * })
 *
 * // Connect with TLS
 * const config = KurrentDBConfig.create({
 *   endpoint: 'esdb.example.com:2113',
 *   tls: true,
 *   tlsVerifyCert: true
 * })
 *
 * // Use with journal
 * const journal = new KurrentDBJournal(config)
 * ```
 */
export class KurrentDBConfig {
  private readonly client: KurrentDBClient

  private constructor(client: KurrentDBClient) {
    this.client = client
  }

  /**
   * Create a KurrentDBConfig from connection options.
   */
  static create(options: KurrentDBConnectionOptions): KurrentDBConfig {
    const connectionString = KurrentDBConfig.buildConnectionString(options)
    const client = KurrentDBClient.connectionString(connectionString)
    return new KurrentDBConfig(client)
  }

  /**
   * Create a KurrentDBConfig from a connection string.
   */
  static fromConnectionString(connectionString: string): KurrentDBConfig {
    const client = KurrentDBClient.connectionString(connectionString)
    return new KurrentDBConfig(client)
  }

  /**
   * Create a KurrentDBConfig from an existing KurrentDBClient instance.
   */
  static fromClient(client: KurrentDBClient): KurrentDBConfig {
    return new KurrentDBConfig(client)
  }

  /**
   * Get the underlying KurrentDBClient instance.
   */
  getClient(): KurrentDBClient {
    return this.client
  }

  /**
   * Close the client connection.
   */
  async close(): Promise<void> {
    await this.client.dispose()
  }

  private static buildConnectionString(options: KurrentDBConnectionOptions): string {
    const protocol = options.tls === false ? 'esdb' : 'esdb+discover'
    const tlsOption = options.tls === false ? 'tls=false' : 'tls=true'
    const tlsVerify = options.tlsVerifyCert === false ? 'tlsVerifyCert=false' : ''

    const queryParams = [tlsOption, tlsVerify].filter(Boolean).join('&')

    return `${protocol}://${options.endpoint}?${queryParams}`
  }
}
