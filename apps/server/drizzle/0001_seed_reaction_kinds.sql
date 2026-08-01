-- Reaction kinds are reference data, not user data: every row in `reactions`
-- and `reaction_baselines` has a foreign key into this table, so a freshly
-- migrated database is unusable without it. That makes it a migration rather
-- than a seed script.
--
-- `legacy_index` maps to Waline's positional reaction0..reaction8 columns and
-- is what the LeanCloud migrator joins on. Of these five, only heart (32),
-- thumbs_up (19) and fire (4) carry any migrated counts; thumbs_down was never
-- used and black_cat was present but zero everywhere. Both are kept so the
-- widget offers the same set it always has.

INSERT INTO "reaction_kinds" ("key", "emoji", "sort_order", "legacy_index") VALUES
  ('heart',       '❤️',   0, 0),
  ('thumbs_up',   '👍️',   1, 1),
  ('thumbs_down', '👎️',   2, 2),
  ('fire',        '🔥',   3, 3),
  ('black_cat',   '🐈‍⬛',   4, 4)
ON CONFLICT ("key") DO NOTHING;
