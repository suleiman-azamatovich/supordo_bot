    if (result.overdueMinutes > 0) {
      msg += `⚠️ Покрыто просрочки: <b>${fmtDuration(result.overdueMinutes)}</b>\n`;
      msg += `✅ Чистое время: <b>${fmtDuration(result.netMinutes)}</b>\n`;
    }