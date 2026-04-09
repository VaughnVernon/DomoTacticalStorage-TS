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
