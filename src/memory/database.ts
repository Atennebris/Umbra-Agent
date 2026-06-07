import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { load as loadSqliteVec } from 'sqlite-vec';

export type MetadataRecord<TValue = unknown> = {
  id: string;
  projectPath: string;
  namespace: string;
  key: string;
  value: TValue;
  createdAt: string;
  updatedAt: string;
};

export type VectorRecord = {
  rowid: number;
  id: string;
  projectKey: string;
  projectPath: string;
  sessionId: string | null;
  sourceType: string;
  sourceRef: string | null;
  content: string;
  embedding: number[];
  dimensions: number;
  model: string;
  createdAt: string;
};

export class UmbraDatabase {
  readonly #database: Database.Database;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.#database = new Database(databasePath);
    loadSqliteVec(this.#database);
    this.#database.pragma('journal_mode = WAL');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_path, namespace, key)
      );
      CREATE INDEX IF NOT EXISTS idx_metadata_project_namespace
        ON metadata(project_path, namespace);
      CREATE TABLE IF NOT EXISTS vectors (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_key TEXT NOT NULL,
        project_path TEXT NOT NULL,
        session_id TEXT,
        source_type TEXT NOT NULL,
        source_ref TEXT,
        content TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vectors_project_path
        ON vectors(project_path, created_at DESC);
    `);
    this.#migrateLegacySchema();
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS idx_vectors_project_key
        ON vectors(project_key, created_at DESC)
    `);
  }

  close(): void {
    this.#database.close();
  }

  upsertMetadata<TValue>(projectPath: string, namespace: string, key: string, value: TValue): void {
    const now = new Date().toISOString();
    const existing = this.getMetadata<TValue>(projectPath, namespace, key);
    const id = existing?.id ?? randomUUID();
    const createdAt = existing?.createdAt ?? now;

    this.#database
      .prepare(
        `
          INSERT INTO metadata (id, project_path, namespace, key, value_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_path, namespace, key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(id, projectPath, namespace, key, JSON.stringify(value), createdAt, now);
  }

  getMetadata<TValue>(
    projectPath: string,
    namespace: string,
    key: string,
  ): MetadataRecord<TValue> | null {
    const row = this.#database
      .prepare(
        `
          SELECT id, project_path, namespace, key, value_json, created_at, updated_at
          FROM metadata
          WHERE project_path = ? AND namespace = ? AND key = ?
        `,
      )
      .get(projectPath, namespace, key) as
      | {
          id: string;
          project_path: string;
          namespace: string;
          key: string;
          value_json: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      projectPath: row.project_path,
      namespace: row.namespace,
      key: row.key,
      value: JSON.parse(row.value_json) as TValue,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listMetadataByNamespace<TValue>(
    namespace: string,
    projectPath?: string,
  ): MetadataRecord<TValue>[] {
    const statement = projectPath
      ? this.#database.prepare(
          `
            SELECT id, project_path, namespace, key, value_json, created_at, updated_at
            FROM metadata
            WHERE namespace = ? AND project_path = ?
            ORDER BY updated_at DESC
          `,
        )
      : this.#database.prepare(
          `
            SELECT id, project_path, namespace, key, value_json, created_at, updated_at
            FROM metadata
            WHERE namespace = ?
            ORDER BY updated_at DESC
          `,
        );

    const rows = (
      projectPath ? statement.all(namespace, projectPath) : statement.all(namespace)
    ) as Array<{
      id: string;
      project_path: string;
      namespace: string;
      key: string;
      value_json: string;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      projectPath: row.project_path,
      namespace: row.namespace,
      key: row.key,
      value: JSON.parse(row.value_json) as TValue,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  deleteMetadata(projectPath: string, namespace: string, key?: string): number {
    const result =
      key === undefined
        ? this.#database
            .prepare(
              `
                DELETE FROM metadata
                WHERE project_path = ? AND namespace = ?
              `,
            )
            .run(projectPath, namespace)
        : this.#database
            .prepare(
              `
                DELETE FROM metadata
                WHERE project_path = ? AND namespace = ? AND key = ?
              `,
            )
            .run(projectPath, namespace, key);

    return result.changes;
  }

  insertVector(
    input: Omit<VectorRecord, 'rowid' | 'id' | 'createdAt' | 'dimensions'>,
  ): VectorRecord {
    this.ensureProjectVectorIndex(input.projectKey, input.embedding.length);

    const vectorId = randomUUID();
    const createdAt = new Date().toISOString();

    const info = this.#database
      .prepare(
        `
          INSERT INTO vectors (
            id, project_key, project_path, session_id, source_type, source_ref, content,
            embedding_json, dimensions, model, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        vectorId,
        input.projectKey,
        input.projectPath,
        input.sessionId,
        input.sourceType,
        input.sourceRef,
        input.content,
        JSON.stringify(input.embedding),
        input.embedding.length,
        input.model,
        createdAt,
      );

    const rowid = Number(info.lastInsertRowid);
    const vectorTableName = this.getProjectVectorTableName(input.projectKey);

    this.#database
      .prepare(`INSERT INTO "${vectorTableName}"(rowid, embedding) VALUES (?, ?)`)
      .run(BigInt(rowid), JSON.stringify(input.embedding));

    return {
      rowid,
      id: vectorId,
      projectKey: input.projectKey,
      projectPath: input.projectPath,
      sessionId: input.sessionId,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      content: input.content,
      embedding: input.embedding,
      dimensions: input.embedding.length,
      model: input.model,
      createdAt,
    };
  }

  listVectors(projectPath: string): VectorRecord[] {
    const rows = this.#database
      .prepare(
        `
          SELECT rowid, id, project_key, project_path, session_id, source_type, source_ref, content,
                 embedding_json, dimensions, model, created_at
          FROM vectors
          WHERE project_path = ?
          ORDER BY created_at DESC
        `,
      )
      .all(projectPath) as Array<{
      rowid: number;
      id: string;
      project_key: string;
      project_path: string;
      session_id: string | null;
      source_type: string;
      source_ref: string | null;
      content: string;
      embedding_json: string;
      dimensions: number;
      model: string;
      created_at: string;
    }>;

    return rows.map((row) => this.mapVectorRow(row));
  }

  listVectorsByRowIds(rowids: number[]): VectorRecord[] {
    if (rowids.length === 0) {
      return [];
    }

    const placeholders = rowids.map(() => '?').join(', ');
    const rows = this.#database
      .prepare(
        `
          SELECT rowid, id, project_key, project_path, session_id, source_type, source_ref, content,
                 embedding_json, dimensions, model, created_at
          FROM vectors
          WHERE rowid IN (${placeholders})
        `,
      )
      .all(...rowids) as Array<{
      rowid: number;
      id: string;
      project_key: string;
      project_path: string;
      session_id: string | null;
      source_type: string;
      source_ref: string | null;
      content: string;
      embedding_json: string;
      dimensions: number;
      model: string;
      created_at: string;
    }>;

    const byRowId = new Map(rows.map((row) => [row.rowid, this.mapVectorRow(row)]));
    return rowids.map((rowid) => byRowId.get(rowid)).filter((value) => value !== undefined);
  }

  deleteVectors(projectPath: string, sessionId?: string | null): number {
    const rows = this.#database
      .prepare(
        sessionId === undefined || sessionId === null
          ? `
              SELECT rowid, project_key
              FROM vectors
              WHERE project_path = ?
            `
          : `
              SELECT rowid, project_key
              FROM vectors
              WHERE project_path = ? AND session_id = ?
            `,
      )
      .all(
        ...(sessionId === undefined || sessionId === null
          ? [projectPath]
          : [projectPath, sessionId]),
      ) as Array<{
      rowid: number;
      project_key: string;
    }>;

    for (const row of rows) {
      const vectorTableName = this.getProjectVectorTableName(row.project_key);
      this.#database
        .prepare(`DELETE FROM "${vectorTableName}" WHERE rowid = ?`)
        .run(BigInt(row.rowid));
    }

    const result =
      sessionId === undefined || sessionId === null
        ? this.#database.prepare('DELETE FROM vectors WHERE project_path = ?').run(projectPath)
        : this.#database
            .prepare('DELETE FROM vectors WHERE project_path = ? AND session_id = ?')
            .run(projectPath, sessionId);

    return result.changes;
  }

  searchVectors(
    projectKey: string,
    queryEmbedding: number[],
    limit: number,
    sessionId?: string | null,
  ): Array<{
    rowid: number;
    distance: number;
  }> {
    this.ensureProjectVectorIndex(projectKey, queryEmbedding.length);

    const vectorTableName = this.getProjectVectorTableName(projectKey);

    if (sessionId) {
      // Return results that are either from the same session OR are not individual tasks (e.g. compactions)
      // We use a subquery for filtering to keep the main query as a clean KNN search for sqlite-vec
      return this.#database
        .prepare(
          `
            SELECT rowid, distance
            FROM "${vectorTableName}"
            WHERE embedding MATCH ?
              AND rowid IN (
                SELECT rowid FROM vectors 
                WHERE session_id = ? OR source_type != 'task'
              )
            ORDER BY distance
            LIMIT ?
          `,
        )
        .all(JSON.stringify(queryEmbedding), sessionId, limit) as Array<{
        rowid: number;
        distance: number;
      }>;
    }

    return this.#database
      .prepare(
        `
          SELECT rowid, distance
          FROM "${vectorTableName}"
          WHERE embedding MATCH ?
          ORDER BY distance
          LIMIT ?
        `,
      )
      .all(JSON.stringify(queryEmbedding), limit) as Array<{
      rowid: number;
      distance: number;
    }>;
  }

  ensureProjectVectorIndex(projectKey: string, dimensions: number): void {
    const vectorTableName = this.getProjectVectorTableName(projectKey);
    this.#database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS "${vectorTableName}"
      USING vec0(embedding float[${dimensions}])
    `);
  }

  getProjectVectorTableName(projectKey: string): string {
    return `vec_project_${projectKey.replace(/[^a-z0-9_]/gi, '_')}`;
  }

  mapVectorRow(row: {
    rowid: number;
    id: string;
    project_key: string;
    project_path: string;
    session_id: string | null;
    source_type: string;
    source_ref: string | null;
    content: string;
    embedding_json: string;
    dimensions: number;
    model: string;
    created_at: string;
  }): VectorRecord {
    return {
      rowid: row.rowid,
      id: row.id,
      projectKey: row.project_key,
      projectPath: row.project_path,
      sessionId: row.session_id,
      sourceType: row.source_type,
      sourceRef: row.source_ref,
      content: row.content,
      embedding: JSON.parse(row.embedding_json) as number[],
      dimensions: row.dimensions,
      model: row.model,
      createdAt: row.created_at,
    };
  }

  #migrateLegacySchema(): void {
    const columns = this.#database.prepare('PRAGMA table_info(vectors)').all() as Array<{
      name: string;
    }>;

    const columnNames = new Set(columns.map((column) => column.name));

    if (!columnNames.has('project_key')) {
      this.#database.exec(`ALTER TABLE vectors ADD COLUMN project_key TEXT NOT NULL DEFAULT ''`);
    }
  }
}
