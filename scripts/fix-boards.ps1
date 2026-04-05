$file = "c:\Users\suleiman\Projects\subordo_bot\src\modules\admin\boards.ts"
$lines = [System.IO.File]::ReadAllLines($file, [System.Text.Encoding]::UTF8)

# Lines 138-173 (0-indexed: 137-172) = RENTED branch
$newBlock = @(
'  } else if (board.status === BoardStatus.RENTED) {'
'    const rental = board.rentals[0];'
'    if (rental) {'
'      const client = escapeHtml(rental.clientName ?? rental.user.name);'
''
'      // Аренда в стадии оплаты'
'      if (["CREATED", "WAIT_PAYMENT", "WAIT_ADMIN"].includes(rental.status)) {'
'        text = `💳 <b>${board.code}</b> — ожидает оплаты\n\n`;'
'        text += `👤 Клиент: <b>${client}</b>\n`;'
'        if (rental.tariff) {'
'          text += `💰 Тариф: ${rental.tariff.name} — ${fmtPrice(rental.tariff.price)}\n`;'
'        }'
'        text += `📅 Создана: ${fmtDate(rental.createdAt)}\n`;'
''
'        if (rental.status === "CREATED" || rental.status === "WAIT_PAYMENT") {'
'          text += `\n⏳ <i>Клиент ещё не отправил чек оплаты.</i>`;'
'        } else {'
'          // WAIT_ADMIN — ищем отправленный чек'
'          const proof = await prisma.paymentProof.findFirst({'
'            where: { kind: "RENTAL", refId: rental.id, status: PaymentProofStatus.SUBMITTED },'
'            orderBy: { createdAt: "desc" },'
'          });'
'          if (proof) {'
'            text += `\n📎 <b>Чек оплаты #${proof.id}</b> — ожидает проверки\n`;'
'            text += `💰 Сумма: <b>${fmtPrice(proof.amount)}</b>\n`;'
'            kb.text(`✅ Подтвердить`, `pay:approve:${proof.id}`)'
'              .text(`❌ Отклонить`, `pay:reject:${proof.id}`)'
'              .row();'
'          } else {'
'            text += `\n⏳ <i>Ожидает подтверждения администратора.</i>`;'
'          }'
'        }'
''
'      // Активная аренда'
'      } else {'
'        text = `🔵 <b>${board.code}</b> — в аренде\n\n`;'
'        text += `👤 Клиент: <b>${client}</b>\n`;'
'        if (rental.startAt) text += `⏱ Старт: ${fmtDate(rental.startAt)}\n`;'
'        if (rental.tariff) {'
'          const totalMin = rental.tariff.durationMinutes + (rental.extraMinutes ?? 0);'
'          text += `💰 Тариф: ${rental.tariff.name} — ${fmtPrice(rental.tariff.price)}\n`;'
'          if (rental.startAt) {'
'            const endAt = new Date(rental.startAt.getTime() + totalMin * 60_000);'
'            const now = new Date();'
'            const remaining = Math.max(0, Math.ceil((endAt.getTime() - now.getTime()) / 60_000));'
'            if (rental.status === "WAIT_RETURN") {'
'              text += `⏰ <b>Время вышло! Ожидает возврата</b>\n`;'
'            } else if (remaining > 0) {'
'              text += `⏳ Осталось: <b>${fmtDuration(remaining)}</b>\n`;'
'            }'
'          }'
'        }'
''
'        if (rental.status === "WAIT_RETURN") {'
'          const overdue = await rentalService.getOverdueMinutes(rental);'
'          if (overdue > 0) {'
'            const cost = overdue * rentalService.OVERDUE_RATE_PER_MIN;'
'            text += `⚠️ <b>Просрочка: ${fmtDuration(overdue)} — ${fmtPrice(cost)}</b> (${rentalService.OVERDUE_RATE_PER_MIN} сом/мин)\n`;'
'          }'
'          kb.text("📩 Напомнить о возврате", `admin:remind_return:${rental.id}`).row();'
'        }'
'        kb.text("⏱ Продлить", `admin:extend:${rental.id}`).row();'
'        kb.text("✅ Принять доску", `return:confirm:${rental.id}`).row();'
'      }'
'    } else {'
'      text = `💳 <b>${board.code}</b> — в аренде (данные не найдены)`;'
'    }'
'  }'
)

# Build new file: lines 0-136 + new block + lines 173+
$result = @()
$result += $lines[0..136]
$result += $newBlock
$result += $lines[173..($lines.Count - 1)]

$text = $result -join "`r`n"
[System.IO.File]::WriteAllText($file, $text, [System.Text.UTF8Encoding]::new($false))
Write-Host "OK: replaced lines 138-173 with new RENTED branch ($($newBlock.Count) lines)"
