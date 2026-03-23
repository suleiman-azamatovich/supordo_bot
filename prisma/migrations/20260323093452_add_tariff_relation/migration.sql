-- AddForeignKey
ALTER TABLE "Rental" ADD CONSTRAINT "Rental_tariffId_fkey" FOREIGN KEY ("tariffId") REFERENCES "Tariff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
