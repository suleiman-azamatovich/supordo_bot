-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "PaymentProof_createdAt_idx" ON "PaymentProof"("createdAt");

-- CreateIndex
CREATE INDEX "PaymentProof_kind_status_createdAt_idx" ON "PaymentProof"("kind", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Rental_createdAt_idx" ON "Rental"("createdAt");

-- CreateIndex
CREATE INDEX "Rental_status_createdAt_idx" ON "Rental"("status", "createdAt");
