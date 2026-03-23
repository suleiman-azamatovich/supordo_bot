-- AlterTable
ALTER TABLE "Rental" ADD COLUMN     "clientName" TEXT,
ADD COLUMN     "sellerUserId" INTEGER;

-- AddForeignKey
ALTER TABLE "Rental" ADD CONSTRAINT "Rental_sellerUserId_fkey" FOREIGN KEY ("sellerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
