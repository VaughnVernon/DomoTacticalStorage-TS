// Copyright © 2012-2025 Vaughn Vernon. All rights reserved.
// Copyright © 2012-2025 Kalele, Inc. All rights reserved.
//
// Licensed under the Reciprocal Public License 1.5
//
// See: LICENSE.md in repository root directory
// See: https://opensource.org/license/rpl-1-5

/**
 * Configuration for Cloudflare D1 storage backends.
 *
 * Wraps a D1Database instance for use with journal and document store.
 *
 * @example
 * ```typescript
 * // In a Cloudflare Worker
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const config = D1Config.create(env.DB)
 *     const journal = new D1Journal(config)
 *     // ...
 *   }
 * }
 * ```
 */
export class D1Config {
  private readonly database: D1Database

  private constructor(database: D1Database) {
    this.database = database
  }

  /**
   * Create a D1Config from a D1Database instance.
   */
  static create(database: D1Database): D1Config {
    return new D1Config(database)
  }

  /**
   * Get the underlying D1Database instance.
   */
  getDatabase(): D1Database {
    return this.database
  }
}
