CREATE TYPE "public"."comment_status" AS ENUM('pending', 'approved', 'spam', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."password_algo" AS ENUM('argon2id', 'phpass');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'moderator');--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_object_id" text,
	"page_id" uuid NOT NULL,
	"parent_id" uuid,
	"root_id" uuid NOT NULL,
	"status" "comment_status" DEFAULT 'pending' NOT NULL,
	"body_markdown" text NOT NULL,
	"body_html" text NOT NULL,
	"legacy_markdown_derived" boolean DEFAULT false NOT NULL,
	"author_user_id" uuid,
	"author_name" text NOT NULL,
	"author_email" text,
	"author_email_hash" text,
	"author_url" text,
	"author_ip" text,
	"user_agent" text,
	"is_sticky" boolean DEFAULT false NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"locale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comments_legacy_object_id_unique" UNIQUE("legacy_object_id"),
	CONSTRAINT "comments_no_self_parent" CHECK ("comments"."parent_id" is null or "comments"."parent_id" <> "comments"."id")
);
--> statement-breakpoint
CREATE TABLE "moderation_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comment_id" uuid NOT NULL,
	"actor_id" uuid,
	"from_status" "comment_status",
	"to_status" "comment_status" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path" text NOT NULL,
	"title" text,
	"pageviews" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pages_path_unique" UNIQUE("path")
);
--> statement-breakpoint
CREATE TABLE "reaction_baselines" (
	"page_id" uuid NOT NULL,
	"kind_key" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "reaction_baselines_page_id_kind_key_pk" PRIMARY KEY("page_id","kind_key")
);
--> statement-breakpoint
CREATE TABLE "reaction_kinds" (
	"key" text PRIMARY KEY NOT NULL,
	"emoji" text NOT NULL,
	"sort_order" integer NOT NULL,
	"legacy_index" smallint,
	CONSTRAINT "reaction_kinds_legacy_index_unique" UNIQUE("legacy_index")
);
--> statement-breakpoint
CREATE TABLE "reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"kind_key" text NOT NULL,
	"visitor_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"user_agent" text,
	"ip" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_refresh_token_hash_unique" UNIQUE("refresh_token_hash")
);
--> statement-breakpoint
CREATE TABLE "user_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_object_id" text,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "user_role" DEFAULT 'moderator' NOT NULL,
	"password_hash" text NOT NULL,
	"password_algo" "password_algo" NOT NULL,
	"totp_secret" text,
	"totp_enabled_at" timestamp with time zone,
	"avatar_url" text,
	"website_url" text,
	"label" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_legacy_object_id_unique" UNIQUE("legacy_object_id"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_root_id_comments_id_fk" FOREIGN KEY ("root_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_log" ADD CONSTRAINT "moderation_log_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_log" ADD CONSTRAINT "moderation_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reaction_baselines" ADD CONSTRAINT "reaction_baselines_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reaction_baselines" ADD CONSTRAINT "reaction_baselines_kind_key_reaction_kinds_key_fk" FOREIGN KEY ("kind_key") REFERENCES "public"."reaction_kinds"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_kind_key_reaction_kinds_key_fk" FOREIGN KEY ("kind_key") REFERENCES "public"."reaction_kinds"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_verifications" ADD CONSTRAINT "user_verifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_page_status_created_idx" ON "comments" USING btree ("page_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "comments_root_created_idx" ON "comments" USING btree ("root_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_author_email_hash_idx" ON "comments" USING btree ("author_email_hash") WHERE "comments"."author_email_hash" is not null;--> statement-breakpoint
CREATE INDEX "comments_pending_idx" ON "comments" USING btree ("status","created_at" DESC NULLS LAST) WHERE "comments"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "moderation_log_comment_id_idx" ON "moderation_log" USING btree ("comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_dedupe_key" ON "notification_outbox" USING btree ("dedupe_key") WHERE "notification_outbox"."delivered_at" is null;--> statement-breakpoint
CREATE INDEX "notification_outbox_pending_idx" ON "notification_outbox" USING btree ("available_at") WHERE "notification_outbox"."delivered_at" is null;--> statement-breakpoint
CREATE INDEX "pages_path_idx" ON "pages" USING btree ("path");--> statement-breakpoint
CREATE UNIQUE INDEX "reactions_page_kind_visitor_key" ON "reactions" USING btree ("page_id","kind_key","visitor_hash");--> statement-breakpoint
CREATE INDEX "reactions_page_kind_idx" ON "reactions" USING btree ("page_id","kind_key");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_family_id_idx" ON "sessions" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "user_verifications_user_id_idx" ON "user_verifications" USING btree ("user_id");