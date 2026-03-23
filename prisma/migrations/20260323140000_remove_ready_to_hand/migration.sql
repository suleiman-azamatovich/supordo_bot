-- AlterEnum: remove READY_TO_HAND from RentalStatus
ALTER TABLE "Rental" ALTER COLUMN "status" DROP DEFAULT;
ALTER TYPE "RentalStatus" RENAME TO "RentalStatus_old";
CREATE TYPE "RentalStatus" AS ENUM ('CREATED', 'WAIT_PAYMENT', 'WAIT_ADMIN', 'RENTED', 'WAIT_RETURN', 'RETURNED', 'CANCELLED');
ALTER TABLE "Rental" ALTER COLUMN "status" TYPE "RentalStatus" USING ("status"::text::"RentalStatus");
DROP TYPE "RentalStatus_old";
