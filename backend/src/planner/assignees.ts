import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { tasks } from '../db/schema';

/** Tasks (or trash rows) that have this person among their assignees (uses the GIN index on tasks). */
export function hasAssignee(userId: string, column: AnyPgColumn = tasks.assigneeIds): SQL {
  return sql`${column} @> ARRAY[${userId}]::uuid[]`;
}

/** Nobody assigned. */
export function unassigned(column: AnyPgColumn = tasks.assigneeIds): SQL {
  return sql`cardinality(${column}) = 0`;
}

/** Takes one person out of every assignee list in `column` (an UPDATE's set value). */
export function withoutAssignee(userId: string, column: AnyPgColumn = tasks.assigneeIds): SQL<string[]> {
  return sql<string[]>`array_remove(${column}, ${userId}::uuid)`;
}

/** Same people, whatever the order. */
export function sameAssignees(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}
