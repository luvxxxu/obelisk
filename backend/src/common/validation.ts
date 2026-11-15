import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/** Validate with a shared zod schema from @obelisk/core; 400 with a readable message on failure. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  const first = issues[0];
  throw new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    message: first ? (first.path ? `${first.path}: ${first.message}` : first.message) : 'Invalid input',
    issues,
  });
}
