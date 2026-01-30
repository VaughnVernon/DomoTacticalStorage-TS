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
import { D1Config } from './D1Config.js'

/**
 * Cloudflare D1 implementation of DocumentStore.
 *
 * Stores documents as JSON text in D1/SQLite with optimistic concurrency control.
 *
 * @example
 * ```typescript
 * // In a Cloudflare Worker
 * const config = D1Config.create(env.DB)
 * const store = new D1DocumentStore(config)
 *
 * // Write a document
 * await store.write('user-123', 'User', { name: 'Alice' }, 1)
 *
 * // Read it back
 * const result = await store.read('user-123', 'User')
 * ```
 */
export class D1DocumentStore extends Actor implements DocumentStore {
  private readonly db: D1Database

  constructor(config: D1Config) {
    super()
    this.db = config.getDatabase()
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

    const result = await this.db.prepare(
      `SELECT state, state_version, metadata FROM documents WHERE type = ? AND id = ?`
    ).bind(type, id).first<{
      state: string
      state_version: number
      metadata: string | null
    }>()

    if (!result) {
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

    const state = JSON.parse(result.state) as S
    const metadata = result.metadata ? this.parseMetadata(result.metadata) : null

    return {
      outcome: {
        success: true,
        result: Result.Success,
        value: state
      },
      id,
      state,
      stateVersion: result.state_version,
      metadata
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

    try {
      // Check for existing document and version
      const existing = await this.db.prepare(
        `SELECT state_version FROM documents WHERE type = ? AND id = ?`
      ).bind(type, id).first<{ state_version: number }>()

      if (existing && existing.state_version >= stateVersion) {
        return {
          outcome: {
            success: false,
            error: new StorageException(
              Result.ConcurrencyViolation,
              `Version conflict: existing version ${existing.state_version} >= new version ${stateVersion}`
            )
          },
          id,
          state,
          stateVersion,
          sources
        }
      }

      // Build batch operations
      const statements: D1PreparedStatement[] = []

      // Serialize metadata
      const metadataJson = this.serializeMetadata(metadata)

      // Upsert document
      statements.push(
        this.db.prepare(
          `INSERT INTO documents (id, type, state, state_version, metadata)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (type, id)
           DO UPDATE SET state = ?, state_version = ?, metadata = ?, updated_at = datetime('now')`
        ).bind(id, type, JSON.stringify(state), stateVersion, metadataJson, JSON.stringify(state), stateVersion, metadataJson)
      )

      // Store sources if provided
      for (const source of sources) {
        statements.push(
          this.db.prepare(
            `INSERT INTO document_sources
             (document_id, document_type, source_type, source_type_version, source_data)
             VALUES (?, ?, ?, ?, ?)`
          ).bind(
            id,
            type,
            source.typeName(),
            source.sourceTypeVersion,
            JSON.stringify(source)
          )
        )
      }

      // Execute batch
      await this.db.batch(statements)

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
