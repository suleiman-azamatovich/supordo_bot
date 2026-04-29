/**
 * Сервис ценообразования.
 *
 * Централизованная логика применения скидок ко всем видам платежей:
 *  - базовая цена аренды (по тарифу)
 *  - продление аренды
 *  - оплата просрочки (по ставке из настроек, settings.overdue_rate_per_min)
 *
 * Принципы:
 *  - Скидка хранится как целый процент (0..100) в `User.discountPercent`.
 *  - При создании аренды процент фиксируется (snapshot) в `Rental.discountPercent`,
 *    `Rental.tariffPriceKgs` (цена до скидки) и `Rental.basePriceKgs` (после).
 *  - Все последующие расчёты используют snapshot, а не актуальный процент.
 *  - Продление использует актуальный процент клиента на момент оплаты продления.
 *  - Округление: цена после скидки округляется до целых сом (Math.round),
 *    сумма скидки вычисляется как разница `price - discounted` (всегда целое).
 */

/**
 * Нормализовать процент скидки в диапазон [0..100].
 * Значения вне диапазона (в т. ч. NaN) обрезаются.
 */
export function normalizePercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.trunc(percent)));
}

/**
 * Применить скидку к цене. Возвращает цену после скидки (целое число сом).
 *
 * @param price — исходная цена в сомах
 * @param percent — процент скидки [0..100]
 */
export function applyDiscount(price: number, percent: number): number {
  const p = normalizePercent(percent);
  if (p === 0) return price;
  return Math.round((price * (100 - p)) / 100);
}

/**
 * Посчитать сумму скидки в сомах (price − priceAfterDiscount).
 */
export function discountAmount(price: number, percent: number): number {
  return price - applyDiscount(price, percent);
}

/**
 * Форматирование скидки в виде «20% (−160 сом)» — для UI.
 */
export function fmtDiscount(price: number, percent: number): string {
  const p = normalizePercent(percent);
  if (p === 0) return "";
  const diff = discountAmount(price, p);
  return `${p}% (−${diff} сом)`;
}

/**
 * Возвращает эффективную цену тарифа с учётом акции.
 * Если у тарифа задан `promoPrice` и он меньше `price` — используется promoPrice.
 * Иначе возвращается обычная `price`.
 */
export function tariffEffectivePrice(tariff: { price: number; promoPrice?: number | null }): number {
  const promo = tariff.promoPrice;
  if (promo != null && promo >= 0 && promo < tariff.price) return promo;
  return tariff.price;
}

/**
 * Проверка, что у тарифа сейчас активна акция (promoPrice задан и меньше price).
 */
export function hasActivePromo(tariff: { price: number; promoPrice?: number | null }): boolean {
  const promo = tariff.promoPrice;
  return promo != null && promo >= 0 && promo < tariff.price;
}
