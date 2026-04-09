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

// PostgreSQL exports
export {
  PostgresConfig,
  PostgresJournal,
  PostgresJournalReader,
  PostgresStreamReader,
  PostgresDocumentStore
} from './postgres/index.js'

// KurrentDB exports
export {
  KurrentDBConfig,
  KurrentDBJournal,
  KurrentDBJournalReader,
  KurrentDBStreamReader
} from './kurrentdb/index.js'

// D1 exports
export {
  D1Config,
  D1Journal,
  D1JournalReader,
  D1StreamReader,
  D1DocumentStore
} from './d1/index.js'
