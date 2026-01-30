// Copyright © 2012-2025 Vaughn Vernon. All rights reserved.
// Copyright © 2012-2025 Kalele, Inc. All rights reserved.
//
// Licensed under the Reciprocal Public License 1.5
//
// See: LICENSE.md in repository root directory
// See: https://opensource.org/license/rpl-1-5

import { Actor } from 'domo-actors'
import {
  DocumentStore,
  DocumentBundle,
  ReadResult,
  ReadAllResult,
  WriteResult,
  Outcome
} from 'domo-tactical/store/document'
import { Source, Metadata, Result, StorageException } from 'domo-tactical/store'
import { Pool } from 'pg'
import { PostgresConfig } from './PostgresConfig.js'

/**
 * PostgreSQL implementation of DocumentStore.
 *
 * Stores documents as JSONB in PostgreSQL with optimistic concurrency control.
 *
 * @example
 * ```typescript
 * const config = PostgresConfig.create({
 *   host: 'localhost',
 *   database: 'mydb',
 *   user: 'user',
 *   password: 'pass'
 * })
 *
 * const store = new PostgresDocumentStore(config)
 *
 * // Write a document
 * await store.write('user-123', 'User', { name: 'Alice' }, 1)
 *
 * // Read it back
 * const result = await store.read('user-123', 'User')
 * ```
 */
export class PostgresDocumentStore extends Actor implements DocumentStore {
  private readonly pool: Pool

  constructor(config: PostgresConfig) {
    super()
    this.pool = config.getPool()
  }

  async read<S = unknown>(id: string, type: string): Promise<ReadResult<S>> {
    if (!id) {
      return {
        outcome: {
          success: false,
          error: new StorageException(Result.Error, 'The id is null or empty.')
        },
        id,
        state: null,
        stateVersion: -1,
        metadata: null
      }
    }

    if (!type) {
      return {
        outcome: {
          success: false,
          error: new StorageException(Result.Error, 'The type is null or empty.')
        },
        id,
        state: null,
        stateVersion: -1,
        metadata: null
      }
    }

    const client = await this.pool.connect()
    try {
      const result = await client.query(
        `SELECT state, state_version, metadata FROM documents WHERE type = $1 AND id = $2`,
        [type, id]
      )

      if (result.rows.length === 0) {
        return {
          outcome: {
            success: false,
            error: new StorageException(Result.NotFound, 'Document not found.')
          },
          id,
          state: null,
          stateVersion: -1,
          metadata: null
        }
      }

      const row = result.rows[0]
      const state = typeof row.state === 'string' ? JSON.parse(row.state) : row.state
      const metadata = row.metadata
        ? (typeof row.metadata === 'string' ? this.parseMetadata(row.metadata) : this.parseMetadata(JSON.stringify(row.metadata)))
        : null

      return {
        outcome: {
          success: true,
          result: Result.Success,
          value: state as S
        },
        id,
        state: state as S,
        stateVersion: Number(row.state_version),
        metadata
      }
    } finally {
      client.release()
    }
  }

  async readAll(bundles: DocumentBundle[]): Promise<ReadAllResult> {
    const results: DocumentBundle[] = []
    let foundAll = true

    for (const bundle of bundles) {
      const readResult = await this.read(bundle.id, bundle.type)

      if (readResult.outcome.success && readResult.state !== null) {
        results.push({
          id: readResult.id,
          type: bundle.type,
          state: readResult.state,
          stateVersion: readResult.stateVersion,
          metadata: readResult.metadata || undefined
        })
      } else {
        foundAll = false
      }
    }

    const outcome: Outcome<DocumentBundle[]> = foundAll
      ? {
          success: true,
          result: Result.Success,
          value: results
        }
      : {
          success: false,
          error: new StorageException(Result.NotAllFound, 'Not all documents were found.')
        }

    return {
      outcome,
      bundles: results
    }
  }

  async write<S = unknown, C = unknown>(
    id: string,
    type: string,
    state: S,
    stateVersion: number,
    sources: Source<C>[] = [],
    metadata: Metadata = Metadata.nullMetadata()
  ): Promise<WriteResult<S, C>> {
    if (!state) {
      return {
        outcome: {
          success: false,
          error: new StorageException(Result.Error, 'The state is null.')
        },
        id,
        state,
        stateVersion,
        sources
      }
    }

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')

      // Check for existing document and version
      const existing = await client.query(
        `SELECT state_version FROM documents WHERE type = $1 AND id = $2 FOR UPDATE`,
        [type, id]
      )

      if (existing.rows.length > 0) {
        const existingVersion = Number(existing.rows[0].state_version)
        if (existingVersion >= stateVersion) {
          await client.query('ROLLBACK')
          return {
            outcome: {
              success: false,
              error: new StorageException(
                Result.ConcurrencyViolation,
                `Version conflict: existing version ${existingVersion} >= new version ${stateVersion}`
              )
            },
            id,
            state,
            stateVersion,
            sources
          }
        }
      }

      // Serialize metadata
      const metadataJson = this.serializeMetadata(metadata)

      // Upsert document
      await client.query(
        `INSERT INTO documents (id, type, state, state_version, metadata)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (type, id)
         DO UPDATE SET state = $3, state_version = $4, metadata = $5, updated_at = NOW()`,
        [id, type, JSON.stringify(state), stateVersion, metadataJson]
      )

      // Store sources if provided
      if (sources.length > 0) {
        for (const source of sources) {
          await client.query(
            `INSERT INTO document_sources
             (document_id, document_type, source_type, source_type_version, source_data)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              id,
              type,
              source.typeName(),
              source.sourceTypeVersion,
              JSON.stringify(source)
            ]
          )
        }
      }

      await client.query('COMMIT')

      return {
        outcome: {
          success: true,
          result: Result.Success,
          value: state
        },
        id,
        state,
        stateVersion,
        sources
      }
    } catch (error) {
      await client.query('ROLLBACK')
      return {
        outcome: {
          success: false,
          error: new StorageException(
            Result.Error,
            `Write failed: ${(error as Error).message}`,
            error as Error
          )
        },
        id,
        state,
        stateVersion,
        sources
      }
    } finally {
      client.release()
    }
  }

  // Private helpers

  private serializeMetadata(metadata: Metadata): string {
    const obj: Record<string, unknown> = {
      value: metadata.value,
      operation: metadata.operation,
      properties: Object.fromEntries(metadata.properties)
    }
    return JSON.stringify(obj)
  }

  private parseMetadata(json: string): Metadata {
    try {
      const obj = JSON.parse(json)
      const properties = new Map<string, string>(Object.entries(obj.properties || {}))
      return Metadata.with(properties, obj.value || '', obj.operation || '')
    } catch {
      return Metadata.nullMetadata()
    }
  }
}
