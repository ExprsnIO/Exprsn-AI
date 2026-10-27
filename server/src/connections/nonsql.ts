

/** 1.9.0: what a non-SQL classifier may need from its connection. */
export interface NonSqlContext {
  database: string | null;
  options: Record<string, unknown>;
  /** 1.9.99-final (B-10304): the introspected schema, when there is one (DynamoDB's key columns). */
  schema?: { name: string; columns: { name: string; type: string }[] }[] | null;
}
