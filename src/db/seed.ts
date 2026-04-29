import { PrismaClient, Role, BoardStatus } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

async function main() {
  const adminTgIds = (process.env.ADMIN_TG_IDS ?? process.env.ADMIN_TG_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (adminTgIds.length === 0) {
    console.error("ADMIN_TG_IDS (or ADMIN_TG_ID) is required in .env for seeding");
    process.exit(1);
  }

  // Create spot first (admin needs it)
  const spot = await prisma.spot.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, name: "Ала-Арчинское водохранилище" },
  });
  console.log(`Spot: ${spot.name}`);

  // Create or update admin users
  for (const adminTgId of adminTgIds) {
    const admin = await prisma.user.upsert({
      where: { tgId: BigInt(adminTgId) },
      update: { role: Role.ADMIN, spotId: spot.id },
      create: {
        tgId: BigInt(adminTgId),
        role: Role.ADMIN,
        name: "Admin",
        spotId: spot.id,
      },
    });
    console.log(`Admin user created/updated: id=${admin.id}, tgId=${admin.tgId}`);
  }

  // Create or update cashier users (optional)
  const cashierTgIds = (process.env.CASHIER_TG_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const cashierTgId of cashierTgIds) {
    const cashier = await prisma.user.upsert({
      where: { tgId: BigInt(cashierTgId) },
      update: { role: Role.CASHIER, spotId: spot.id },
      create: {
        tgId: BigInt(cashierTgId),
        role: Role.CASHIER,
        name: "Cashier",
        spotId: spot.id,
      },
    });
    console.log(`Cashier user created/updated: id=${cashier.id}, tgId=${cashier.tgId}`);
  }

  // Create 20 boards with permanent sequential codes SUP-01..SUP-20
  const boards = Array.from({ length: 20 }, (_, i) => ({
    code: `SUP-${String(i + 1).padStart(2, "0")}`,
    title: `SUP-${String(i + 1).padStart(2, "0")}`,
    spotId: spot.id,
  }));

  for (const b of boards) {
    await prisma.board.upsert({
      where: { code: b.code },
      update: {},
      create: { ...b, status: BoardStatus.AVAILABLE },
    });
  }
  console.log(`Boards created: ${boards.length}`);

  // Create tariffs (prices in KGS — сом). promoPrice — акционная цена.
  const tariffs = [
    { spotId: spot.id, name: "1 час", durationMinutes: 60, price: 900, promoPrice: 800 },
    { spotId: spot.id, name: "1,5 часа", durationMinutes: 90, price: 1200, promoPrice: null },
    { spotId: spot.id, name: "2 часа", durationMinutes: 120, price: 1500, promoPrice: null },
  ];

  // Delete existing tariffs and recreate
  await prisma.tariff.deleteMany({});
  for (const t of tariffs) {
    await prisma.tariff.create({ data: t });
  }
  console.log(`Tariffs created: ${tariffs.length}`);

  console.log("\nSeed completed!");
  console.log("Deep link examples (QR codes):");
  for (const b of boards) {
    console.log(`  ${b.code} -> t.me/<BOT_USERNAME>?start=board_${b.code}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
