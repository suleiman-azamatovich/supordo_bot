-- AlterEnum
ALTER TYPE "PaymentProofKind" ADD VALUE 'OVERDUE';

-- AlterTable
ALTER TABLE "Rental" ADD COLUMN     "extraCost" INTEGER NOT NULL DEFAULT 0;
