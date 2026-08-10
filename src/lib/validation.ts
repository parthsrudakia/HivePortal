import { z } from "zod";

/**
 * Runtime input validation for server actions. "use server" exports are
 * network endpoints — TypeScript types on their arguments are erased at
 * runtime, so anything money-adjacent validates its inputs with these
 * before touching the database.
 */

export const zUuid = z.uuid();
export const zUuidArray = z.array(z.uuid());

/** True when every value matches the schema; use as a top-of-action guard. */
export function isValid(schema: z.ZodType, value: unknown): boolean {
  return schema.safeParse(value).success;
}
