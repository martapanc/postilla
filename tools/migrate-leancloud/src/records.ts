import { z } from 'zod';

/**
 * The shape of LeanCloud's export, as observed in the real data rather than as
 * documented. Every record is parsed through these schemas on the way in, so a
 * field that does not look the way we expect stops the migration instead of
 * silently becoming a null in the new database.
 */

/** LeanCloud emits ISO-8601 with an explicit `Z`. Anything else is suspect. */
const utcInstant = z
  .string()
  .refine((s) => s.endsWith('Z') && !Number.isNaN(Date.parse(s)), {
    message: 'expected an ISO-8601 UTC timestamp ending in Z',
  })
  .transform((s) => new Date(s));

const objectId = z.string().min(1);

/** Waline writes '' rather than omitting empty optional fields. */
const emptyToNull = <T extends z.ZodType<string>>(inner: T) =>
  z
    .union([inner, z.literal('')])
    .nullish()
    .transform((v) => (v === '' || v == null ? null : (v as string)));

export const leanCommentSchema = z.object({
  objectId,
  comment: z.string(),
  url: z.string().min(1),
  nick: z.string().min(1),
  mail: emptyToNull(z.string()),
  link: emptyToNull(z.string()),
  ip: emptyToNull(z.string()),
  ua: emptyToNull(z.string()),
  status: z.enum(['approved', 'waiting', 'spam']),
  /** Present only on replies. */
  pid: objectId.nullish(),
  /** Root of the thread. Recomputed rather than trusted; see transform.ts. */
  rid: objectId.nullish(),
  user_id: objectId.nullish(),
  like: z.number().int().nullish(),
  sticky: z.boolean().nullish(),
  /**
   * The true authoring time, and what the UI displays. `createdAt` is when the
   * row was written, which diverges by months for comments imported into
   * LeanCloud from an earlier system.
   */
  insertedAt: utcInstant,
  createdAt: utcInstant,
  updatedAt: utcInstant,
});

const reactionColumns = z.object({
  reaction0: z.number().int().nullish(),
  reaction1: z.number().int().nullish(),
  reaction2: z.number().int().nullish(),
  reaction3: z.number().int().nullish(),
  reaction4: z.number().int().nullish(),
  reaction5: z.number().int().nullish(),
  reaction6: z.number().int().nullish(),
  reaction7: z.number().int().nullish(),
  reaction8: z.number().int().nullish(),
});

export const leanCounterSchema = z
  .object({
    objectId,
    url: z.string().min(1),
    time: z.number().int().nonnegative(),
    createdAt: utcInstant,
    updatedAt: utcInstant,
  })
  .extend(reactionColumns.shape);

export const leanUserSchema = z.object({
  objectId,
  display_name: z.string().min(1),
  email: z.string().min(3),
  /** phpass hash. Carried across and rehashed to argon2id on first login. */
  password: z.string().min(1),
  /**
   * 'administrator', 'guest', or 'verify:<code>:<expiry>'. One column doing
   * three jobs, split apart on the way in.
   */
  type: z.string().min(1),
  /** Base32 TOTP secret. Load-bearing: a wrong value locks the admin out. */
  '2fa': emptyToNull(z.string()),
  avatar: emptyToNull(z.string()),
  url: emptyToNull(z.string()),
  label: emptyToNull(z.string()),
  github: emptyToNull(z.string()),
  twitter: emptyToNull(z.string()),
  facebook: emptyToNull(z.string()),
  google: emptyToNull(z.string()),
  weibo: emptyToNull(z.string()),
  qq: emptyToNull(z.string()),
  createdAt: utcInstant,
  updatedAt: utcInstant,
});

export type LeanComment = z.infer<typeof leanCommentSchema>;
export type LeanCounter = z.infer<typeof leanCounterSchema>;
export type LeanUser = z.infer<typeof leanUserSchema>;

export const SOCIAL_FIELDS = [
  'github',
  'twitter',
  'facebook',
  'google',
  'weibo',
  'qq',
] as const satisfies readonly (keyof LeanUser)[];
