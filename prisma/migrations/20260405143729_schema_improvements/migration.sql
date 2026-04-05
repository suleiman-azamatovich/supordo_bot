/*
  Warnings:

  - Changed the type of `action` on the `AuditLog` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Added the required column `updatedAt` to the `Rental` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATED', 'WALKIN_CREATED', 'WAIT_PAYMENT', 'SUBMITTED', 'APPROVED_AND_RENTED', 'RETURNED', 'CANCELLED', 'EXTENDED', 'EXTEND_REQUESTED', 'EXTEND_REJECTED', 'CLOSE_OVERDUE', 'PAYMENT_APPROVED', 'PAYMENT_REJECTED', 'ROLE_CHANGED', 'MODE_TOGGLED', 'QR_UPDATED');

-- AlterTable: safely convert action from String to AuditAction enum
-- 1. Rename old column
ALTER TABLE "AuditLog" RENAME COLUMN "action" TO "action_old";
-- 2. Add new enum column with a default
ALTER TABLE "AuditLog" ADD COLUMN "action" "AuditAction";
-- 3. Migrate existing data (map known strings to enum values)
UPDATE "AuditLog" SET "action" = "action_old"::"AuditAction" WHERE "action_old" IN (
  'CREATED','WALKIN_CREATED','WAIT_PAYMENT','SUBMITTED','APPROVED_AND_RENTED',
  'RETURNED','CANCELLED','EXTENDED','EXTEND_REQUESTED','EXTEND_REJECTED',
  'CLOSE_OVERDUE','PAYMENT_APPROVED','PAYMENT_REJECTED','ROLE_CHANGED',
  'MODE_TOGGLED','QR_UPDATED'
);
-- 4. Set NOT NULL and drop old column
DELETE FROM "AuditLog" WHERE "action" IS NULL;
ALTER TABLE "AuditLog" ALTER COLUMN "action" SET NOT NULL;
ALTER TABLE "AuditLog" DROP COLUMN "action_old";

-- AlterTable
ALTER TABLE "Board" ADD COLUMN     "imageFileId" TEXT;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "isRead" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PaymentProof" ADD COLUMN     "reviewedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Rental" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW();

-- AlterTable
ALTER TABLE "Spot" ADD COLUMN     "address" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Tariff" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW();

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "Board_status_idx" ON "Board"("status");

-- CreateIndex
CREATE INDEX "Board_spotId_idx" ON "Board"("spotId");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_idx" ON "Notification"("userId", "isRead");

-- CreateIndex
CREATE INDEX "PaymentProof_status_idx" ON "PaymentProof"("status");

-- CreateIndex
CREATE INDEX "PaymentProof_kind_refId_idx" ON "PaymentProof"("kind", "refId");

-- CreateIndex
CREATE INDEX "Rental_status_idx" ON "Rental"("status");

-- CreateIndex
CREATE INDEX "Rental_spotId_idx" ON "Rental"("spotId");

-- CreateIndex
CREATE INDEX "Rental_boardId_idx" ON "Rental"("boardId");

-- CreateIndex
CREATE INDEX "Rental_userId_idx" ON "Rental"("userId");

-- CreateIndex
CREATE INDEX "Rental_startAt_idx" ON "Rental"("startAt");

-- CreateIndex
CREATE INDEX "Tariff_spotId_isActive_idx" ON "Tariff"("spotId", "isActive");
