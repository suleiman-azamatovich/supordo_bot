-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'TARIFF_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'TARIFF_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'TARIFF_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'DISCOUNT_SET';

-- AlterTable
ALTER TABLE "Rental" ADD COLUMN     "basePriceKgs" INTEGER,
ADD COLUMN     "discountPercent" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tariffPriceKgs" INTEGER;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "discountNote" TEXT,
ADD COLUMN     "discountPercent" INTEGER NOT NULL DEFAULT 0;
