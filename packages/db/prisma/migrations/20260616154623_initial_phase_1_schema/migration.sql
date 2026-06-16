-- CreateEnum
CREATE TYPE "org_role" AS ENUM ('BUYER_USER', 'BUYER_ADMIN', 'SUPPLIER_USER', 'SUPPLIER_ADMIN', 'NETWORK_ADMIN');

-- CreateEnum
CREATE TYPE "org_type" AS ENUM ('BUYER', 'SUPPLIER', 'BOTH');

-- CreateEnum
CREATE TYPE "relationship_status" AS ENUM ('PENDING_INVITATION', 'ACTIVE', 'SUSPENDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "document_number_source" AS ENUM ('NETWORK', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "invitation_status" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "audit_action" AS ENUM ('CREATED', 'PUBLISHED', 'ACKNOWLEDGED', 'STATUS_CHANGED', 'SUPERSEDED', 'CANCELLED', 'LINKED', 'UNLINKED', 'ATTACHMENT_ADDED', 'ATTACHMENT_REMOVED', 'READ');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified_at" TIMESTAMP(3),
    "password_hash" TEXT,
    "display_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_org_memberships" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "role" "org_role" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_org_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orgs" (
    "id" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "org_type" "org_type" NOT NULL,
    "contact" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orgs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_identifiers" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "scheme" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trading_relationships" (
    "id" TEXT NOT NULL,
    "buyer_org_id" TEXT NOT NULL,
    "supplier_org_id" TEXT NOT NULL,
    "status" "relationship_status" NOT NULL,
    "established_at" TIMESTAMP(3),
    "terminated_at" TIMESTAMP(3),
    "buyer_internal_supplier_id" TEXT,
    "enabled_document_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "payment_terms_ref" TEXT,
    "default_currency" TEXT,
    "default_incoterms" TEXT,
    "document_number_source" "document_number_source" NOT NULL DEFAULT 'NETWORK',
    "summary_invoicing_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trading_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relationship_invitations" (
    "id" TEXT NOT NULL,
    "trading_relationship_id" TEXT,
    "invited_by_user_id" TEXT NOT NULL,
    "invited_email" TEXT NOT NULL,
    "invited_org_name" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "invitation_status" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "declined_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relationship_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "document_type" TEXT NOT NULL,
    "document_number" TEXT NOT NULL,
    "issuer_org_id" TEXT NOT NULL,
    "recipient_org_id" TEXT NOT NULL,
    "trading_relationship_id" TEXT NOT NULL,
    "current_version_id" TEXT,
    "status" TEXT NOT NULL,
    "reference_number" TEXT,
    "total_amount" DECIMAL(18,4),
    "currency" TEXT,
    "issue_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "body" JSONB NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "change_reason" TEXT,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_links" (
    "id" TEXT NOT NULL,
    "from_document_id" TEXT NOT NULL,
    "to_document_id" TEXT NOT NULL,
    "link_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" TEXT NOT NULL,

    CONSTRAINT "document_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_audit_log" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "actor_org_id" TEXT NOT NULL,
    "action" "audit_action" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "version_id" TEXT,
    "storage_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaded_by_id" TEXT NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_outbox" (
    "id" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "document_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "notification_status" NOT NULL DEFAULT 'PENDING',
    "delivered_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "user_org_memberships_org_id_idx" ON "user_org_memberships"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_org_memberships_user_id_org_id_key" ON "user_org_memberships"("user_id", "org_id");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_idx" ON "user_sessions"("user_id");

-- CreateIndex
CREATE INDEX "org_identifiers_org_id_idx" ON "org_identifiers"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_identifiers_scheme_value_key" ON "org_identifiers"("scheme", "value");

-- CreateIndex
CREATE INDEX "trading_relationships_supplier_org_id_idx" ON "trading_relationships"("supplier_org_id");

-- CreateIndex
CREATE UNIQUE INDEX "trading_relationships_buyer_org_id_supplier_org_id_key" ON "trading_relationships"("buyer_org_id", "supplier_org_id");

-- CreateIndex
CREATE UNIQUE INDEX "relationship_invitations_token_key" ON "relationship_invitations"("token");

-- CreateIndex
CREATE INDEX "relationship_invitations_invited_email_idx" ON "relationship_invitations"("invited_email");

-- CreateIndex
CREATE UNIQUE INDEX "documents_current_version_id_key" ON "documents"("current_version_id");

-- CreateIndex
CREATE INDEX "documents_recipient_org_id_status_idx" ON "documents"("recipient_org_id", "status");

-- CreateIndex
CREATE INDEX "documents_trading_relationship_id_idx" ON "documents"("trading_relationship_id");

-- CreateIndex
CREATE INDEX "documents_document_type_status_idx" ON "documents"("document_type", "status");

-- CreateIndex
CREATE INDEX "documents_issue_date_idx" ON "documents"("issue_date");

-- CreateIndex
CREATE UNIQUE INDEX "documents_issuer_org_id_document_type_document_number_key" ON "documents"("issuer_org_id", "document_type", "document_number");

-- CreateIndex
CREATE INDEX "document_versions_document_id_idx" ON "document_versions"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_document_id_version_number_key" ON "document_versions"("document_id", "version_number");

-- CreateIndex
CREATE INDEX "document_links_to_document_id_link_type_idx" ON "document_links"("to_document_id", "link_type");

-- CreateIndex
CREATE INDEX "document_links_from_document_id_link_type_idx" ON "document_links"("from_document_id", "link_type");

-- CreateIndex
CREATE UNIQUE INDEX "document_links_from_document_id_to_document_id_link_type_key" ON "document_links"("from_document_id", "to_document_id", "link_type");

-- CreateIndex
CREATE INDEX "document_audit_log_document_id_occurred_at_idx" ON "document_audit_log"("document_id", "occurred_at");

-- CreateIndex
CREATE INDEX "document_audit_log_actor_org_id_occurred_at_idx" ON "document_audit_log"("actor_org_id", "occurred_at");

-- CreateIndex
CREATE INDEX "attachments_document_id_idx" ON "attachments"("document_id");

-- CreateIndex
CREATE INDEX "attachments_sha256_idx" ON "attachments"("sha256");

-- CreateIndex
CREATE INDEX "notification_outbox_status_created_at_idx" ON "notification_outbox"("status", "created_at");

-- CreateIndex
CREATE INDEX "notification_outbox_recipient_id_idx" ON "notification_outbox"("recipient_id");

-- AddForeignKey
ALTER TABLE "user_org_memberships" ADD CONSTRAINT "user_org_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_org_memberships" ADD CONSTRAINT "user_org_memberships_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_identifiers" ADD CONSTRAINT "org_identifiers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trading_relationships" ADD CONSTRAINT "trading_relationships_buyer_org_id_fkey" FOREIGN KEY ("buyer_org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trading_relationships" ADD CONSTRAINT "trading_relationships_supplier_org_id_fkey" FOREIGN KEY ("supplier_org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationship_invitations" ADD CONSTRAINT "relationship_invitations_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationship_invitations" ADD CONSTRAINT "relationship_invitations_trading_relationship_id_fkey" FOREIGN KEY ("trading_relationship_id") REFERENCES "trading_relationships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_issuer_org_id_fkey" FOREIGN KEY ("issuer_org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_recipient_org_id_fkey" FOREIGN KEY ("recipient_org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_trading_relationship_id_fkey" FOREIGN KEY ("trading_relationship_id") REFERENCES "trading_relationships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "document_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_from_document_id_fkey" FOREIGN KEY ("from_document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_to_document_id_fkey" FOREIGN KEY ("to_document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_audit_log" ADD CONSTRAINT "document_audit_log_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_audit_log" ADD CONSTRAINT "document_audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_audit_log" ADD CONSTRAINT "document_audit_log_actor_org_id_fkey" FOREIGN KEY ("actor_org_id") REFERENCES "orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
