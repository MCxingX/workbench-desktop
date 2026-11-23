declare module 'sql.js' {
  export interface QueryExecResult {
    columns: string[]
    values: unknown[][]
  }

  export interface Statement {
    bind(params?: unknown[] | Record<string, unknown>): boolean
    step(): boolean
    getAsObject(params?: unknown[] | Record<string, unknown>): Record<string, unknown>
    get(params?: unknown[] | Record<string, unknown>): unknown[]
    run(params?: unknown[] | Record<string, unknown>): void
    free(): boolean
    reset(): void
  }

  export interface Database {
    run(sql: string, params?: unknown[] | Record<string, unknown>): Database
    exec(sql: string): QueryExecResult[]
    prepare(sql: string, params?: unknown[] | Record<string, unknown>): Statement
    export(): Uint8Array
    close(): void
    getRowsModified(): number
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array | null) => Database
  }

  export interface SqlJsConfig {
    locateFile?: (file: string) => string
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>
}
