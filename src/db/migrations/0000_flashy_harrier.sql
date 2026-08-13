CREATE TYPE "public"."admin_decision_action" AS ENUM('approve', 'reject', 'edit', 'request_reanalysis', 'direct_change');--> statement-breakpoint
CREATE TYPE "public"."ai_job_status" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ai_operation" AS ENUM('classify_relevance', 'extract_claims', 'compare_claims', 'analyse_provenance', 'evaluate_evidence', 'recommend_status', 'embed');--> statement-breakpoint
CREATE TYPE "public"."claim_relationship_type" AS ENUM('equivalent', 'subsumes', 'refines', 'contradicts', 'related');--> statement-breakpoint
CREATE TYPE "public"."claim_source_stance" AS ENUM('supports', 'contradicts', 'mentions');--> statement-breakpoint
CREATE TYPE "public"."development_outcome" AS ENUM('unknown', 'reflected_in_development', 'changed_during_development', 'cut', 'in_final_game', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."information_type" AS ENUM('fact', 'official', 'report', 'leak', 'rumour', 'speculation', 'prediction', 'interpretation');--> statement-breakpoint
CREATE TYPE "public"."initiated_by" AS ENUM('ai', 'human', 'system');--> statement-breakpoint
CREATE TYPE "public"."investigation_status" AS ENUM('unverified', 'corroborated', 'strongly_corroborated', 'confirmed', 'disproven', 'unresolvable');--> statement-breakpoint
CREATE TYPE "public"."source_item_type" AS ENUM('article', 'reddit_post', 'reddit_comment', 'forum_post', 'video', 'social_post', 'official_statement', 'press_release', 'interview_transcript', 'other');--> statement-breakpoint
CREATE TYPE "public"."source_relationship_type" AS ENUM('original', 'independent_corroboration', 'citation', 'repetition', 'aggregation', 'derivative', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('news_outlet', 'official_developer', 'official_publisher', 'youtube_channel', 'reddit_account', 'forum_account', 'social_media_account', 'unknown');--> statement-breakpoint
CREATE TABLE "admin_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"ai_result_id" integer,
	"admin_user_id" integer NOT NULL,
	"action" "admin_decision_action" NOT NULL,
	"notes" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"display_name" varchar(200) NOT NULL,
	"email" varchar(320) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "ai_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"operation" "ai_operation" NOT NULL,
	"provider" varchar(50) NOT NULL,
	"model" varchar(100) NOT NULL,
	"status" "ai_job_status" DEFAULT 'pending' NOT NULL,
	"input_ref" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_estimate_usd" numeric(10, 6),
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"ai_job_id" integer NOT NULL,
	"claim_id" integer,
	"structured_output" jsonb NOT NULL,
	"confidence" numeric(4, 3),
	"reasoning" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_development_outcome_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"claim_id" integer NOT NULL,
	"previous_outcome" "development_outcome",
	"new_outcome" "development_outcome" NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	"confidence" numeric(4, 3),
	"initiated_by" "initiated_by" NOT NULL,
	"ai_result_id" integer,
	"admin_decision_id" integer
);
--> statement-breakpoint
CREATE TABLE "claim_investigation_status_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"claim_id" integer NOT NULL,
	"previous_status" "investigation_status",
	"new_status" "investigation_status" NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	"confidence" numeric(4, 3),
	"initiated_by" "initiated_by" NOT NULL,
	"ai_result_id" integer,
	"admin_decision_id" integer
);
--> statement-breakpoint
CREATE TABLE "claim_relationships" (
	"id" serial PRIMARY KEY NOT NULL,
	"claim_id_a" integer NOT NULL,
	"claim_id_b" integer NOT NULL,
	"relationship_type" "claim_relationship_type" NOT NULL,
	"confidence" numeric(4, 3),
	"created_by" "initiated_by" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"claim_id" integer NOT NULL,
	"source_item_id" integer NOT NULL,
	"stance" "claim_source_stance" NOT NULL,
	"supporting_excerpt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_topics" (
	"id" serial PRIMARY KEY NOT NULL,
	"claim_id" integer NOT NULL,
	"topic_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"statement" text NOT NULL,
	"information_type" "information_type" NOT NULL,
	"first_reported_at" timestamp with time zone,
	"current_investigation_status" "investigation_status" DEFAULT 'unverified' NOT NULL,
	"current_investigation_status_since" timestamp with time zone,
	"current_development_outcome" "development_outcome" DEFAULT 'unknown' NOT NULL,
	"current_development_outcome_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "development_transition_evidence" (
	"id" serial PRIMARY KEY NOT NULL,
	"transition_id" integer NOT NULL,
	"evidence_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" serial PRIMARY KEY NOT NULL,
	"claim_id" integer NOT NULL,
	"source_item_id" integer,
	"description" text NOT NULL,
	"evidence_type" varchar(100) NOT NULL,
	"added_by" "initiated_by" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investigation_transition_evidence" (
	"id" serial PRIMARY KEY NOT NULL,
	"transition_id" integer NOT NULL,
	"evidence_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(200) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "source_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" integer NOT NULL,
	"item_type" "source_item_type" NOT NULL,
	"url" text NOT NULL,
	"canonical_url" text,
	"title" text,
	"author" varchar(300),
	"published_at" timestamp with time zone,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"excerpt" text,
	"raw_content_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_relationships" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_item_id_a" integer NOT NULL,
	"source_item_id_b" integer NOT NULL,
	"relationship_type" "source_relationship_type" NOT NULL,
	"confidence" numeric(4, 3),
	"evidence_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(300) NOT NULL,
	"source_type" "source_type" NOT NULL,
	"homepage_url" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"slug" varchar(100) NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_decisions" ADD CONSTRAINT "admin_decisions_ai_result_id_ai_results_id_fk" FOREIGN KEY ("ai_result_id") REFERENCES "public"."ai_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_decisions" ADD CONSTRAINT "admin_decisions_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_results" ADD CONSTRAINT "ai_results_ai_job_id_ai_jobs_id_fk" FOREIGN KEY ("ai_job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_results" ADD CONSTRAINT "ai_results_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_development_outcome_history" ADD CONSTRAINT "claim_development_outcome_history_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_development_outcome_history" ADD CONSTRAINT "claim_development_outcome_history_ai_result_id_ai_results_id_fk" FOREIGN KEY ("ai_result_id") REFERENCES "public"."ai_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_development_outcome_history" ADD CONSTRAINT "claim_development_outcome_history_admin_decision_id_admin_decisions_id_fk" FOREIGN KEY ("admin_decision_id") REFERENCES "public"."admin_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_investigation_status_history" ADD CONSTRAINT "claim_investigation_status_history_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_investigation_status_history" ADD CONSTRAINT "claim_investigation_status_history_ai_result_id_ai_results_id_fk" FOREIGN KEY ("ai_result_id") REFERENCES "public"."ai_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_investigation_status_history" ADD CONSTRAINT "claim_investigation_status_history_admin_decision_id_admin_decisions_id_fk" FOREIGN KEY ("admin_decision_id") REFERENCES "public"."admin_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_relationships" ADD CONSTRAINT "claim_relationships_claim_id_a_claims_id_fk" FOREIGN KEY ("claim_id_a") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_relationships" ADD CONSTRAINT "claim_relationships_claim_id_b_claims_id_fk" FOREIGN KEY ("claim_id_b") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_sources" ADD CONSTRAINT "claim_sources_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_sources" ADD CONSTRAINT "claim_sources_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_topics" ADD CONSTRAINT "claim_topics_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_topics" ADD CONSTRAINT "claim_topics_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_transition_evidence" ADD CONSTRAINT "development_transition_evidence_transition_id_claim_development_outcome_history_id_fk" FOREIGN KEY ("transition_id") REFERENCES "public"."claim_development_outcome_history"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "development_transition_evidence" ADD CONSTRAINT "development_transition_evidence_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_source_item_id_source_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_transition_evidence" ADD CONSTRAINT "investigation_transition_evidence_transition_id_claim_investigation_status_history_id_fk" FOREIGN KEY ("transition_id") REFERENCES "public"."claim_investigation_status_history"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_transition_evidence" ADD CONSTRAINT "investigation_transition_evidence_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_items" ADD CONSTRAINT "source_items_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_relationships" ADD CONSTRAINT "source_relationships_source_item_id_a_source_items_id_fk" FOREIGN KEY ("source_item_id_a") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_relationships" ADD CONSTRAINT "source_relationships_source_item_id_b_source_items_id_fk" FOREIGN KEY ("source_item_id_b") REFERENCES "public"."source_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dev_outcome_history_claim_idx" ON "claim_development_outcome_history" USING btree ("claim_id","changed_at");--> statement-breakpoint
CREATE INDEX "inv_status_history_claim_idx" ON "claim_investigation_status_history" USING btree ("claim_id","changed_at");--> statement-breakpoint
CREATE INDEX "claim_relationships_pair_idx" ON "claim_relationships" USING btree ("claim_id_a","claim_id_b");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_sources_unique" ON "claim_sources" USING btree ("claim_id","source_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_topics_unique" ON "claim_topics" USING btree ("claim_id","topic_id");--> statement-breakpoint
CREATE INDEX "claims_project_idx" ON "claims" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "claims_inv_status_idx" ON "claims" USING btree ("current_investigation_status");--> statement-breakpoint
CREATE INDEX "claims_dev_outcome_idx" ON "claims" USING btree ("current_development_outcome");--> statement-breakpoint
CREATE UNIQUE INDEX "dev_transition_evidence_unique" ON "development_transition_evidence" USING btree ("transition_id","evidence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inv_transition_evidence_unique" ON "investigation_transition_evidence" USING btree ("transition_id","evidence_id");--> statement-breakpoint
CREATE INDEX "source_items_url_idx" ON "source_items" USING btree ("url");--> statement-breakpoint
CREATE INDEX "source_items_hash_idx" ON "source_items" USING btree ("raw_content_hash");--> statement-breakpoint
CREATE INDEX "source_relationships_pair_idx" ON "source_relationships" USING btree ("source_item_id_a","source_item_id_b");--> statement-breakpoint
CREATE UNIQUE INDEX "topics_project_slug_unique" ON "topics" USING btree ("project_id","slug");