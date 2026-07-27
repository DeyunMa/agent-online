export type TestStatement = {
  bindings: unknown[];
  query: string;
};

type TestStatementHandle = D1PreparedStatement & {
  testStatement: TestStatement;
};

export function result<T>(rows: T[] = [], changes = 1): D1Result<T> {
  return {
    meta: { changes },
    results: rows,
    success: true,
  } as D1Result<T>;
}

export class TestD1Database {
  readonly allRows: unknown[][] = [];
  readonly batches: TestStatement[][] = [];
  readonly firstRows: unknown[] = [];
  readonly prepared: TestStatement[] = [];
  batchError: unknown = null;
  batchResults: D1Result<unknown>[][] = [];

  asBinding(): D1Database {
    return this as unknown as D1Database;
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.batches.push(
      statements.map((statement) => (statement as TestStatementHandle).testStatement),
    );

    if (this.batchError !== null) {
      throw this.batchError;
    }

    return (this.batchResults.shift() ?? []) as D1Result<T>[];
  }

  prepare(query: string): D1PreparedStatement {
    const statement: TestStatement = { bindings: [], query };
    this.prepared.push(statement);

    const statementHandle = {
      all: async <T>() => result((this.allRows.shift() ?? []) as T[]),
      bind: (...values: unknown[]) => {
        statement.bindings = values;
        return statementHandle;
      },
      first: async <T>() => (this.firstRows.shift() ?? null) as T | null,
      raw: async () => [],
      run: async <T>() => result<T>(),
      testStatement: statement,
    } as unknown as TestStatementHandle;

    return statementHandle;
  }
}
