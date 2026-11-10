


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";





SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."conversion_tasks" (
    "id" "text" NOT NULL,
    "user_id" "uuid",
    "status" "text" NOT NULL,
    "progress" integer DEFAULT 0,
    "complete" boolean DEFAULT false,
    "error" "text",
    "audio_url" "text",
    "chapters" "jsonb",
    "title" "text",
    "database_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "queue_status" "text" DEFAULT 'done'::"text" NOT NULL,
    "queued_at" timestamp with time zone,
    "started_at" timestamp with time zone,
    "conversion_type" "text",
    "epub_path" "text",
    "voice_id" "text",
    "text_content" "text",
    "use_emotional_director" boolean DEFAULT false,
    "generate_word_timings" boolean DEFAULT false,
    "cover_url" "text",
    "eta_seconds" integer,
    "is_retry" boolean DEFAULT false,
    "language" "text",
    "image_upload_id" "text",
    "retry_count" integer DEFAULT 0 NOT NULL,
    "device_id" "text",
    CONSTRAINT "chk_conversion_tasks_identity" CHECK (((("user_id" IS NOT NULL) AND ("device_id" IS NULL)) OR (("user_id" IS NULL) AND ("device_id" IS NOT NULL))))
);


ALTER TABLE "public"."conversion_tasks" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_next_queued_task"("p_worker_id" "text" DEFAULT NULL::"text", "p_global_limit" integer DEFAULT 2) RETURNS SETOF "public"."conversion_tasks"
    LANGUAGE "plpgsql"
    AS $$
  DECLARE
    v_task conversion_tasks;
  BEGIN
    SELECT ct.*
      INTO v_task
      FROM conversion_tasks ct
     WHERE ct.queue_status = 'queued'
       -- Per-user: max 1 concurrent conversion per user
       AND (
         SELECT COUNT(*) FROM conversion_tasks
          WHERE user_id = ct.user_id AND queue_status = 'processing'
       ) < 1
       -- Global: total processing < global limit
       AND (
         SELECT COUNT(*) FROM conversion_tasks WHERE queue_status = 'processing'
       ) < p_global_limit
     ORDER BY ct.queued_at ASC NULLS LAST
     LIMIT 1
     FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
      RETURN;
    END IF;

    UPDATE conversion_tasks
       SET queue_status = 'processing',
           started_at   = now()
     WHERE id = v_task.id;

    RETURN QUERY SELECT * FROM conversion_tasks WHERE id = v_task.id;
  END;
  $$;


ALTER FUNCTION "public"."claim_next_queued_task"("p_worker_id" "text", "p_global_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_old_audit_logs"("days_to_keep" integer DEFAULT 90) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM security_audit_log
    WHERE timestamp < NOW() - (days_to_keep || ' days')::INTERVAL;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;


ALTER FUNCTION "public"."cleanup_old_audit_logs"("days_to_keep" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_old_playback_events"("retention_days" integer DEFAULT 90) RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    DELETE FROM playback_events
    WHERE recorded_at < NOW() - (retention_days || ' days')::INTERVAL;
END;
$$;


ALTER FUNCTION "public"."cleanup_old_playback_events"("retention_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_active_conversions_for_user"("p_user_id" "uuid") RETURNS TABLE("id" "text", "user_id" "uuid", "status" "text", "progress" integer, "audio_url" "text", "error" "text", "complete" boolean, "chapters" "jsonb", "title" "text", "created_at" timestamp with time zone, "queue_status" "text", "queued_at" timestamp with time zone, "started_at" timestamp with time zone, "conversion_type" "text", "voice_id" "text", "queue_position" bigint)
    LANGUAGE "sql" STABLE
    AS $$
    SELECT
      ct.id,
      ct.user_id,
      ct.status,
      ct.progress,
      ct.audio_url,
      ct.error,
      ct.complete,
      ct.chapters,
      ct.title,
      ct.created_at,
      ct.queue_status,
      ct.queued_at,
      ct.started_at,
      ct.conversion_type,
      ct.voice_id,
      CASE
        WHEN ct.queue_status = 'queued' THEN
          ROW_NUMBER() OVER (
            PARTITION BY ct.queue_status
            ORDER BY ct.queued_at ASC NULLS LAST
          )
        ELSE NULL
      END AS queue_position
    FROM conversion_tasks ct
    WHERE ct.user_id = p_user_id
      AND ct.queue_status IN ('queued', 'processing')
    ORDER BY ct.queued_at ASC NULLS LAST;
  $$;


ALTER FUNCTION "public"."get_active_conversions_for_user"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    email,
    first_name,
    last_name,
    display_name,
    plan,
    conversion_count,
    max_conversions
  )
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'first_name',
    NEW.raw_user_meta_data->>'last_name',
    NEW.raw_user_meta_data->>'display_name',
    'free',
    0,
    10
  );
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_conversion_count"("p_user_id" "uuid") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  UPDATE profiles
  SET conversion_count = COALESCE(conversion_count, 0) + 1
  WHERE id = p_user_id;
$$;


ALTER FUNCTION "public"."increment_conversion_count"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_monthly_conversion_count"("p_user_id" "uuid") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  UPDATE profiles
  SET monthly_conversion_count = COALESCE(monthly_conversion_count, 0) + 1
  WHERE id = p_user_id;
$$;


ALTER FUNCTION "public"."increment_monthly_conversion_count"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."requeue_stuck_tasks"("p_stuck_threshold_minutes" integer DEFAULT 10) RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
  DECLARE
    v_count int;
  BEGIN
    UPDATE conversion_tasks
       SET queue_status = 'queued',
           started_at   = NULL
     WHERE queue_status = 'processing'
       AND started_at < now() - (p_stuck_threshold_minutes || ' minutes')::interval;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
  END;
  $$;


ALTER FUNCTION "public"."requeue_stuck_tasks"("p_stuck_threshold_minutes" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."requeue_stuck_tasks"("p_stuck_threshold_minutes" integer, "p_max_retries" integer DEFAULT 3) RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    v_requeued_count INTEGER;
    v_failed_count   INTEGER;
BEGIN
    -- 1. Poison-task fail-out: stuck > threshold AND at/above the retry cap.
    --    These keep crashing the worker; mark 'failed' so they stop being
    --    resurrected. complete=true so the polling UI sees a terminal state.
    --    Preserved (not deleted) for inspection — cleanup_old_tasks ignores
    --    'failed' rows.
    UPDATE conversion_tasks
    SET queue_status = 'failed',
        complete     = TRUE,
        error        = COALESCE(error, '') ||
                       ' [auto-failed by requeue_stuck_tasks: exceeded max_retries=' ||
                       p_max_retries || ']'
    WHERE queue_status = 'processing'
      AND started_at < (NOW() - (p_stuck_threshold_minutes || ' minutes')::INTERVAL)
      AND retry_count >= p_max_retries;

    GET DIAGNOSTICS v_failed_count = ROW_COUNT;
    IF v_failed_count > 0 THEN
        RAISE NOTICE 'requeue_stuck_tasks: auto-failed % poison-task(s)', v_failed_count;
    END IF;

    -- 2. Requeue: stuck > threshold but still under the cap. Bump retry_count
    --    and clear started_at so the next attempt is clean.
    UPDATE conversion_tasks
    SET queue_status = 'queued',
        retry_count  = retry_count + 1,
        started_at   = NULL
    WHERE queue_status = 'processing'
      AND started_at < (NOW() - (p_stuck_threshold_minutes || ' minutes')::INTERVAL)
      AND retry_count < p_max_retries;

    GET DIAGNOSTICS v_requeued_count = ROW_COUNT;
    RETURN v_requeued_count;
END;
$$;


ALTER FUNCTION "public"."requeue_stuck_tasks"("p_stuck_threshold_minutes" integer, "p_max_retries" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reset_monthly_conversions"() RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    -- Reset conversions for users whose reset date is more than 30 days ago
    UPDATE profiles
    SET
        monthly_conversion_count = 0,
        conversion_count_reset_at = NOW()
    WHERE conversion_count_reset_at < NOW() - INTERVAL '30 days';
 
    RAISE NOTICE 'Reset monthly conversions for users';
END;
$$;


ALTER FUNCTION "public"."reset_monthly_conversions"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audiobook_chapters" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "audiobook_id" "uuid" NOT NULL,
    "chapter_id" "text" NOT NULL,
    "title" "text" NOT NULL,
    "position" integer NOT NULL,
    "audio_url" "text" NOT NULL,
    "duration" real DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "word_timings" "jsonb",
    "image_inserts" "jsonb",
    "word_timings_url" "text"
);


ALTER TABLE "public"."audiobook_chapters" OWNER TO "postgres";


COMMENT ON COLUMN "public"."audiobook_chapters"."word_timings" IS 'Word-level timing offsets for karaoke highlighting. Array of {word, start, end} objects with times in seconds. NULL when conversion predates this feature or timing extraction failed.';



CREATE TABLE IF NOT EXISTS "public"."audiobooks" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "title" "text" NOT NULL,
    "voice_id" "text" NOT NULL,
    "voice_name" "text" NOT NULL,
    "duration" integer DEFAULT 0,
    "current_position" integer DEFAULT 0,
    "status" "text" DEFAULT 'pending'::"text",
    "progress" integer DEFAULT 0,
    "is_custom" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "author" "text",
    "cover_url" "text",
    "current_chapter" integer DEFAULT 0,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "description" "text",
    "source_hash" "text",
    "language" "text",
    "device_id" "text",
    "is_demo" boolean DEFAULT false NOT NULL,
    CONSTRAINT "chk_audiobooks_identity" CHECK (((("user_id" IS NOT NULL) AND ("device_id" IS NULL)) OR (("user_id" IS NULL) AND ("device_id" IS NOT NULL))))
);


ALTER TABLE "public"."audiobooks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bookmarks" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "audiobook_id" "uuid" NOT NULL,
    "chapter_index" integer DEFAULT 0,
    "position_seconds" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."bookmarks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bookshare_tokens" (
    "user_id" "uuid" NOT NULL,
    "access_token" "text" NOT NULL,
    "refresh_token" "text",
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."bookshare_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chapters" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "audiobook_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "audio_url" "text",
    "duration" integer DEFAULT 0,
    "position" integer NOT NULL
);


ALTER TABLE "public"."chapters" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."device_push_tokens" (
    "device_id" "text" NOT NULL,
    "expo_push_token" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."device_push_tokens" FORCE ROW LEVEL SECURITY;


ALTER TABLE "public"."device_push_tokens" OWNER TO "postgres";


COMMENT ON TABLE "public"."device_push_tokens" IS 'Expo push tokens for anonymous-trial devices (X-Device-Id). Service-role only — no RLS policies by design.';



CREATE TABLE IF NOT EXISTS "public"."gutenberg_books" (
    "id" integer NOT NULL,
    "title" "text" NOT NULL,
    "authors" "text",
    "language" "text",
    "subjects" "text",
    "bookshelves" "text",
    "issued" "text",
    "search_text" "text"
);


ALTER TABLE "public"."gutenberg_books" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."playback_events" (
    "id" bigint NOT NULL,
    "user_id" "uuid",
    "audiobook_id" "uuid",
    "chapter_index" integer DEFAULT 0 NOT NULL,
    "position_seconds" double precision DEFAULT 0 NOT NULL,
    "segment" integer DEFAULT 0 NOT NULL,
    "playback_rate" double precision DEFAULT 1.0 NOT NULL,
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."playback_events" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."playback_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."playback_events_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."playback_events_id_seq" OWNED BY "public"."playback_events"."id";



CREATE TABLE IF NOT EXISTS "public"."processed_webhooks" (
    "id" integer NOT NULL,
    "event_id" "text" NOT NULL,
    "processed_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."processed_webhooks" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."processed_webhooks_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."processed_webhooks_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."processed_webhooks_id_seq" OWNED BY "public"."processed_webhooks"."id";



CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "display_name" "text",
    "avatar_url" "text",
    "plan" "text" DEFAULT 'free'::"text",
    "conversion_count" integer DEFAULT 0,
    "max_conversions" integer DEFAULT 10,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "first_name" "text",
    "last_name" "text",
    "subscription_tier" "text" DEFAULT 'free'::"text",
    "max_audiobooks" integer,
    "monthly_conversion_count" integer DEFAULT 0,
    "conversion_count_reset_at" timestamp with time zone DEFAULT "now"(),
    "max_monthly_conversions" integer,
    "stripe_customer_id" "text",
    "stripe_subscription_id" "text",
    "subscription_status" "text" DEFAULT 'inactive'::"text",
    "subscription_current_period_end" timestamp with time zone,
    "subscription_cancel_at_period_end" boolean DEFAULT false,
    "expo_push_token" "text",
    "karaoke_trial_used" boolean DEFAULT false NOT NULL,
    "terms_accepted_version" "text",
    "terms_accepted_at" timestamp with time zone,
    CONSTRAINT "max_audiobooks_positive" CHECK ((("max_audiobooks" IS NULL) OR ("max_audiobooks" > 0))),
    CONSTRAINT "monthly_conversion_count_non_negative" CHECK (("monthly_conversion_count" >= 0)),
    CONSTRAINT "profiles_plan_check" CHECK (("plan" = ANY (ARRAY['free'::"text", 'starter'::"text", 'pro'::"text", 'enterprise'::"text"]))),
    CONSTRAINT "valid_subscription_status" CHECK (("subscription_status" = ANY (ARRAY['incomplete'::"text", 'incomplete_expired'::"text", 'trialing'::"text", 'active'::"text", 'past_due'::"text", 'canceled'::"text", 'unpaid'::"text", 'inactive'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."security_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_type" character varying(50) NOT NULL,
    "user_id" "uuid",
    "ip_address" "inet",
    "details" "jsonb",
    "timestamp" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."security_audit_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."security_audit_log" IS 'Security audit log for tracking security-relevant events';



COMMENT ON COLUMN "public"."security_audit_log"."event_type" IS 'Type of security event (auth_success, auth_failure, rate_limit_exceeded, etc.)';



COMMENT ON COLUMN "public"."security_audit_log"."user_id" IS 'User ID if known (NULL for anonymous events)';



COMMENT ON COLUMN "public"."security_audit_log"."ip_address" IS 'Client IP address';



COMMENT ON COLUMN "public"."security_audit_log"."details" IS 'Additional event details (no sensitive data)';



COMMENT ON COLUMN "public"."security_audit_log"."timestamp" IS 'When the event occurred';



CREATE OR REPLACE VIEW "public"."recent_security_events" AS
 SELECT "event_type",
    "count"(*) AS "event_count",
    "max"("timestamp") AS "last_occurrence"
   FROM "public"."security_audit_log"
  WHERE ("timestamp" > ("now"() - '24:00:00'::interval))
  GROUP BY "event_type"
  ORDER BY ("count"(*)) DESC;


ALTER VIEW "public"."recent_security_events" OWNER TO "postgres";


ALTER TABLE ONLY "public"."playback_events" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."playback_events_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."processed_webhooks" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."processed_webhooks_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."audiobook_chapters"
    ADD CONSTRAINT "audiobook_chapters_audiobook_id_position_key" UNIQUE ("audiobook_id", "position");



ALTER TABLE ONLY "public"."audiobook_chapters"
    ADD CONSTRAINT "audiobook_chapters_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."audiobooks"
    ADD CONSTRAINT "audiobooks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bookmarks"
    ADD CONSTRAINT "bookmarks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bookmarks"
    ADD CONSTRAINT "bookmarks_user_id_audiobook_id_chapter_index_key" UNIQUE ("user_id", "audiobook_id", "chapter_index");



ALTER TABLE ONLY "public"."bookshare_tokens"
    ADD CONSTRAINT "bookshare_tokens_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."chapters"
    ADD CONSTRAINT "chapters_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."conversion_tasks"
    ADD CONSTRAINT "conversion_tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."device_push_tokens"
    ADD CONSTRAINT "device_push_tokens_pkey" PRIMARY KEY ("device_id");



ALTER TABLE ONLY "public"."gutenberg_books"
    ADD CONSTRAINT "gutenberg_books_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."playback_events"
    ADD CONSTRAINT "playback_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."processed_webhooks"
    ADD CONSTRAINT "processed_webhooks_event_id_key" UNIQUE ("event_id");



ALTER TABLE ONLY "public"."processed_webhooks"
    ADD CONSTRAINT "processed_webhooks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_stripe_customer_id_key" UNIQUE ("stripe_customer_id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_stripe_subscription_id_key" UNIQUE ("stripe_subscription_id");



ALTER TABLE ONLY "public"."security_audit_log"
    ADD CONSTRAINT "security_audit_log_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_audiobook_chapters_word_timings" ON "public"."audiobook_chapters" USING "gin" ("word_timings") WHERE ("word_timings" IS NOT NULL);



CREATE INDEX "idx_audiobooks_device_id" ON "public"."audiobooks" USING "btree" ("device_id") WHERE ("device_id" IS NOT NULL);



CREATE INDEX "idx_audiobooks_is_demo" ON "public"."audiobooks" USING "btree" ("is_demo") WHERE "is_demo";



CREATE INDEX "idx_audiobooks_user_id" ON "public"."audiobooks" USING "btree" ("user_id");



CREATE INDEX "idx_audiobooks_user_language" ON "public"."audiobooks" USING "btree" ("user_id", "language") WHERE ("language" IS NOT NULL);



CREATE INDEX "idx_audiobooks_user_source_hash" ON "public"."audiobooks" USING "btree" ("user_id", "source_hash", "created_at") WHERE ("source_hash" IS NOT NULL);



CREATE INDEX "idx_audit_event_type" ON "public"."security_audit_log" USING "btree" ("event_type");



CREATE INDEX "idx_audit_ip_address" ON "public"."security_audit_log" USING "btree" ("ip_address");



CREATE INDEX "idx_audit_timestamp" ON "public"."security_audit_log" USING "btree" ("timestamp");



CREATE INDEX "idx_audit_user_id" ON "public"."security_audit_log" USING "btree" ("user_id");



CREATE INDEX "idx_audit_user_timestamp" ON "public"."security_audit_log" USING "btree" ("user_id", "timestamp" DESC);



CREATE INDEX "idx_bookmarks_user_audiobook" ON "public"."bookmarks" USING "btree" ("user_id", "audiobook_id");



CREATE INDEX "idx_chapters_audiobook_id" ON "public"."chapters" USING "btree" ("audiobook_id");



CREATE INDEX "idx_chapters_audiobook_position" ON "public"."audiobook_chapters" USING "btree" ("audiobook_id", "position");



CREATE INDEX "idx_conversion_tasks_created_at" ON "public"."conversion_tasks" USING "btree" ("created_at");



CREATE INDEX "idx_conversion_tasks_device_id" ON "public"."conversion_tasks" USING "btree" ("device_id") WHERE ("device_id" IS NOT NULL);



CREATE INDEX "idx_conversion_tasks_id" ON "public"."conversion_tasks" USING "btree" ("id");



CREATE INDEX "idx_conversion_tasks_queue" ON "public"."conversion_tasks" USING "btree" ("queue_status", "queued_at") WHERE ("queue_status" = 'queued'::"text");



CREATE INDEX "idx_conversion_tasks_user_id" ON "public"."conversion_tasks" USING "btree" ("user_id");



CREATE INDEX "idx_gutenberg_search" ON "public"."gutenberg_books" USING "gin" ("search_text" "public"."gin_trgm_ops");



CREATE INDEX "idx_gutenberg_subjects" ON "public"."gutenberg_books" USING "gin" ("subjects" "public"."gin_trgm_ops");



CREATE INDEX "idx_playback_events_heatmap" ON "public"."playback_events" USING "btree" ("audiobook_id", "chapter_index", "segment");



CREATE INDEX "idx_playback_events_recorded_at" ON "public"."playback_events" USING "btree" ("recorded_at");



CREATE INDEX "idx_playback_events_user" ON "public"."playback_events" USING "btree" ("user_id", "audiobook_id");



CREATE INDEX "idx_processed_webhooks_event_id" ON "public"."processed_webhooks" USING "btree" ("event_id");



CREATE INDEX "idx_profiles_stripe_customer" ON "public"."profiles" USING "btree" ("stripe_customer_id");



CREATE INDEX "idx_profiles_stripe_subscription" ON "public"."profiles" USING "btree" ("stripe_subscription_id");



CREATE OR REPLACE TRIGGER "update_audiobooks_updated_at" BEFORE UPDATE ON "public"."audiobooks" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_conversion_tasks_updated_at" BEFORE UPDATE ON "public"."conversion_tasks" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



ALTER TABLE ONLY "public"."audiobook_chapters"
    ADD CONSTRAINT "audiobook_chapters_audiobook_id_fkey" FOREIGN KEY ("audiobook_id") REFERENCES "public"."audiobooks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."audiobooks"
    ADD CONSTRAINT "audiobooks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bookmarks"
    ADD CONSTRAINT "bookmarks_audiobook_id_fkey" FOREIGN KEY ("audiobook_id") REFERENCES "public"."audiobooks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bookmarks"
    ADD CONSTRAINT "bookmarks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bookshare_tokens"
    ADD CONSTRAINT "bookshare_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chapters"
    ADD CONSTRAINT "chapters_audiobook_id_fkey" FOREIGN KEY ("audiobook_id") REFERENCES "public"."audiobooks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."conversion_tasks"
    ADD CONSTRAINT "conversion_tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."playback_events"
    ADD CONSTRAINT "playback_events_audiobook_id_fkey" FOREIGN KEY ("audiobook_id") REFERENCES "public"."audiobooks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."playback_events"
    ADD CONSTRAINT "playback_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."security_audit_log"
    ADD CONSTRAINT "security_audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



CREATE POLICY "Service role can insert audit logs" ON "public"."security_audit_log" FOR INSERT TO "service_role" WITH CHECK (true);



CREATE POLICY "Service role can read audit logs" ON "public"."security_audit_log" FOR SELECT TO "service_role" USING (true);



CREATE POLICY "Users can insert own chapters" ON "public"."audiobook_chapters" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."audiobooks"
  WHERE (("audiobooks"."id" = "audiobook_chapters"."audiobook_id") AND ("audiobooks"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can view own chapters" ON "public"."audiobook_chapters" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."audiobooks"
  WHERE (("audiobooks"."id" = "audiobook_chapters"."audiobook_id") AND ("audiobooks"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users delete own audiobooks" ON "public"."audiobooks" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users insert own audiobooks" ON "public"."audiobooks" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users update own audiobooks" ON "public"."audiobooks" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users update own profile" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id"));



CREATE POLICY "Users view own audiobooks" ON "public"."audiobooks" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users view own profile" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() = "id"));



ALTER TABLE "public"."audiobook_chapters" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."audiobooks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bookmarks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bookshare_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."chapters" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."device_push_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."gutenberg_books" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "gutenberg_books are readable by everyone" ON "public"."gutenberg_books" FOR SELECT TO "authenticated", "anon" USING (true);



CREATE POLICY "owner_select_playback_events" ON "public"."playback_events" FOR SELECT USING (("audiobook_id" IN ( SELECT "audiobooks"."id"
   FROM "public"."audiobooks"
  WHERE ("audiobooks"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."playback_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."security_audit_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "service_role_insert_playback_events" ON "public"."playback_events" FOR INSERT TO "service_role" WITH CHECK (true);





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";





GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "service_role";











































































































































































GRANT ALL ON TABLE "public"."conversion_tasks" TO "anon";
GRANT ALL ON TABLE "public"."conversion_tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."conversion_tasks" TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_next_queued_task"("p_worker_id" "text", "p_global_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."claim_next_queued_task"("p_worker_id" "text", "p_global_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_next_queued_task"("p_worker_id" "text", "p_global_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."cleanup_old_audit_logs"("days_to_keep" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."cleanup_old_audit_logs"("days_to_keep" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."cleanup_old_audit_logs"("days_to_keep" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."cleanup_old_playback_events"("retention_days" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."cleanup_old_playback_events"("retention_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."cleanup_old_playback_events"("retention_days" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_active_conversions_for_user"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_active_conversions_for_user"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_active_conversions_for_user"("p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."increment_conversion_count"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."increment_conversion_count"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_conversion_count"("p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."increment_monthly_conversion_count"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."increment_monthly_conversion_count"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_monthly_conversion_count"("p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."requeue_stuck_tasks"("p_stuck_threshold_minutes" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."requeue_stuck_tasks"("p_stuck_threshold_minutes" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."requeue_stuck_tasks"("p_stuck_threshold_minutes" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."requeue_stuck_tasks"("p_stuck_threshold_minutes" integer, "p_max_retries" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."requeue_stuck_tasks"("p_stuck_threshold_minutes" integer, "p_max_retries" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."requeue_stuck_tasks"("p_stuck_threshold_minutes" integer, "p_max_retries" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."reset_monthly_conversions"() TO "anon";
GRANT ALL ON FUNCTION "public"."reset_monthly_conversions"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."reset_monthly_conversions"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "postgres";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "anon";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "service_role";



GRANT ALL ON FUNCTION "public"."show_limit"() TO "postgres";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "anon";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_limit"() TO "service_role";



GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "postgres";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "anon";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "service_role";
























GRANT ALL ON TABLE "public"."audiobook_chapters" TO "anon";
GRANT ALL ON TABLE "public"."audiobook_chapters" TO "authenticated";
GRANT ALL ON TABLE "public"."audiobook_chapters" TO "service_role";



GRANT ALL ON TABLE "public"."audiobooks" TO "anon";
GRANT ALL ON TABLE "public"."audiobooks" TO "authenticated";
GRANT ALL ON TABLE "public"."audiobooks" TO "service_role";



GRANT ALL ON TABLE "public"."bookmarks" TO "anon";
GRANT ALL ON TABLE "public"."bookmarks" TO "authenticated";
GRANT ALL ON TABLE "public"."bookmarks" TO "service_role";



GRANT ALL ON TABLE "public"."bookshare_tokens" TO "anon";
GRANT ALL ON TABLE "public"."bookshare_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."bookshare_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."chapters" TO "anon";
GRANT ALL ON TABLE "public"."chapters" TO "authenticated";
GRANT ALL ON TABLE "public"."chapters" TO "service_role";



GRANT ALL ON TABLE "public"."device_push_tokens" TO "anon";
GRANT ALL ON TABLE "public"."device_push_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."device_push_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."gutenberg_books" TO "anon";
GRANT ALL ON TABLE "public"."gutenberg_books" TO "authenticated";
GRANT ALL ON TABLE "public"."gutenberg_books" TO "service_role";



GRANT ALL ON TABLE "public"."playback_events" TO "anon";
GRANT ALL ON TABLE "public"."playback_events" TO "authenticated";
GRANT ALL ON TABLE "public"."playback_events" TO "service_role";



GRANT ALL ON SEQUENCE "public"."playback_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."playback_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."playback_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."processed_webhooks" TO "anon";
GRANT ALL ON TABLE "public"."processed_webhooks" TO "authenticated";
GRANT ALL ON TABLE "public"."processed_webhooks" TO "service_role";



GRANT ALL ON SEQUENCE "public"."processed_webhooks_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."processed_webhooks_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."processed_webhooks_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."security_audit_log" TO "anon";
GRANT ALL ON TABLE "public"."security_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."security_audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."recent_security_events" TO "anon";
GRANT ALL ON TABLE "public"."recent_security_events" TO "authenticated";
GRANT ALL ON TABLE "public"."recent_security_events" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































