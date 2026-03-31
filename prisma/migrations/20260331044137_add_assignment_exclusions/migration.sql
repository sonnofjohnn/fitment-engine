-- CreateTable
CREATE TABLE "AssignmentExclusion" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssignmentExclusion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssignmentExclusion_shop_idx" ON "AssignmentExclusion"("shop");

-- CreateIndex
CREATE INDEX "AssignmentExclusion_shop_productTitle_idx" ON "AssignmentExclusion"("shop", "productTitle");

-- CreateIndex
CREATE UNIQUE INDEX "AssignmentExclusion_shop_productId_key" ON "AssignmentExclusion"("shop", "productId");
