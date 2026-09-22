CREATE TYPE "public"."subscription_status" AS ENUM('active', 'grace', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."subscription_tier" AS ENUM('starter', 'pro', 'unlimited');--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"product_id" text NOT NULL,
	"tier" "subscription_tier" NOT NULL,
	"original_transaction_id" text NOT NULL,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"auto_renew" boolean DEFAULT true NOT NULL,
	"environment" text DEFAULT 'Production' NOT NULL,
	"last_transaction_id" text,
	"last_notification_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_original_transaction_id_unique" UNIQUE("original_transaction_id")
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "iap_account_token" uuid;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscriptions_user_idx" ON "subscriptions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "subscriptions_sync_idx" ON "subscriptions" USING btree ("status","updated_at");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_iap_account_token_unique" UNIQUE("iap_account_token");