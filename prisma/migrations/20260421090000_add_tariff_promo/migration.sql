-- AlterTable
ALTER TABLE "Tariff" ADD COLUMN "promoPrice" INTEGER;

-- AlterTable
ALTER TABLE "Rental" ADD COLUMN "tariffOriginalPriceKgs" INTEGER;
