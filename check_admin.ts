import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
async function main() {
  const admin = await p.user.findFirst({ where: { role: 'ADMIN' } });
  console.log('Admin:', admin ? `id=${admin.id} tgId=${admin.tgId} role=${admin.role} name=${admin.name}` : 'NOT FOUND');
  await p.$disconnect();
}
main();
