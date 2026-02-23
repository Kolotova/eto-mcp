function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized === "" ? fallback : normalized;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const normalized = String(value).trim();
    return normalized === "" ? fallback : normalized;
  }
  return fallback;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function truncate(text: string, max = 70): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1).trim()}…`;
}

function starsBar(stars?: number): string {
  if (stars === undefined || !Number.isFinite(stars) || stars < 1) {
    return "⭐️—";
  }

  const n = Math.max(1, Math.min(5, Math.floor(stars)));
  return "⭐️".repeat(n);
}

function formatCurrency(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (normalized === "RUB") {
    return "₽";
  }
  if (normalized === "EUR") {
    return "€";
  }
  if (normalized === "USD") {
    return "$";
  }
  return normalized;
}

function formatDate(iso: string): string {
  const normalized = iso.trim();
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return normalized;
  }
  const [, yyyy, mm, dd] = match;
  return `${dd}.${mm}.${yyyy}`;
}

function formatPrice(value: unknown): string {
  const n = asNumber(value);
  if (n === undefined) {
    return "—";
  }
  return Math.round(n).toLocaleString("ru-RU");
}

function formatRating(value: unknown): string | undefined {
  const numeric = asNumber(value);
  if (numeric !== undefined) {
    if (numeric < 3) {
      return String(Math.round(numeric));
    }
    return numeric.toFixed(1);
  }

  const text = asString(value, "");
  if (text === "") {
    return undefined;
  }
  return text;
}

function formatLocation(countryValue: unknown, cityValue: unknown, flagValue: unknown): string {
  const country = escapeHtml(truncate(asString(countryValue, "—"), 40));
  const city = escapeHtml(truncate(asString(cityValue, "—"), 40));
  const flag = asString(flagValue, "");

  if (flag) {
    return `${flag} ${country}, ${city}`;
  }
  return `${country}, ${city}`;
}

function buildPhotoUrl(imageValue: unknown): string | undefined {
  const imageUrl = asString(imageValue, "");
  if (!imageUrl) {
    return undefined;
  }

  if (/^https?:\/\//i.test(imageUrl)) {
    return imageUrl;
  }

  const base = asString(process.env.BASE_URL, "") || asString(process.env.PUBLIC_BASE_URL, "");
  if (!base) {
    return imageUrl;
  }

  const normalizedBase = base.replace(/\/+$/, "");
  const normalizedPath = imageUrl.startsWith("/") ? imageUrl : `/${imageUrl}`;
  return `${normalizedBase}${normalizedPath}`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatTourCaption(t: any): string {
  const hotelName = escapeHtml(truncate(asString(t?.hotel_name, "Без названия"), 70));
  const stars = asNumber(t?.stars);
  const starsText = starsBar(stars);
  const ratingText = formatRating(t?.rating);
  const starsLine = ratingText ? `${starsText} • ${ratingText}` : starsText;

  const dateFrom = formatDate(asString(t?.date_from, "—"));
  const nights = asNumber(t?.nights);
  const nightsText = nights !== undefined ? `${Math.max(0, Math.floor(nights))}` : "—";

  const meal = escapeHtml(truncate(asString(t?.meal, "—"), 24));
  const room = escapeHtml(truncate(asString(t?.room, "—"), 24));
  const operator = escapeHtml(truncate(asString(t?.operator, "—"), 30));

  const currencyCode = asString(t?.currency, "RUB");
  const currency = escapeHtml(formatCurrency(currencyCode));
  const price = formatPrice(t?.price);
  const location = formatLocation(t?.country_name, t?.city_name, t?.flag_emoji);
  const photoUrl = buildPhotoUrl(t?.image_url);

  const lines = [
    `<b>${hotelName}</b>`,
    starsLine,
    `📍 ${location}`,
    "",
    `📅 ${dateFrom} • ${nightsText} ночей`,
    `🍽 ${meal} • 🛏 ${room}`,
    `💸 <b>${price} ${currency}</b>`,
    `🧳 ${operator}`
  ];

  if (photoUrl) {
    lines.push(`🖼 Фото: ${escapeHtml(photoUrl)}`);
  }

  lines.push("", "<i>🔥 Часто выбирают • уточним наличие</i>");

  return lines.join("\n");
}

function renderMessage(output: any, top: number): string {
  const rawResults = Array.isArray(output?.results) ? output.results : [];

  if (rawResults.length === 0) {
    return "😕 Ничего не нашла по фильтрам.\n\nПопробуй:\n• увеличить budget_max\n• снизить rating\n• расширить nights_min/max";
  }

  const sorted = [...rawResults].sort((a, b) => {
    const ap = asNumber(a?.price) ?? 1e18;
    const bp = asNumber(b?.price) ?? 1e18;
    return ap - bp;
  });

  const shown = sorted.slice(0, top);
  const lines: string[] = [];

  lines.push(`🔥 Топ-${shown.length} туров`);
  lines.push("");

  for (let i = 0; i < shown.length; i += 1) {
    const t = shown[i] ?? {};
    const idx = `${i + 1}${String.fromCodePoint(0xfe0f, 0x20e3)}`;

    const hotelName = escapeHtml(truncate(asString(t.hotel_name, "Без названия")));
    const stars = asNumber(t.stars);
    const starsText = starsBar(stars);

    const ratingText = formatRating(t.rating);
    const starsLine = ratingText ? `${starsText} • ${ratingText}` : starsText;

    const dateFrom = formatDate(asString(t.date_from, "—"));
    const nights = asNumber(t.nights);
    const nightsText = nights !== undefined ? `${Math.max(0, Math.floor(nights))}` : "—";

    const meal = escapeHtml(truncate(asString(t.meal, "—"), 24));
    const room = escapeHtml(truncate(asString(t.room, "—"), 24));
    const operator = escapeHtml(truncate(asString(t.operator, "—"), 30));
    const location = formatLocation(t.country_name, t.city_name, t.flag_emoji);

    const currencyCode = asString(t.currency, "RUB");
    const currency = escapeHtml(formatCurrency(currencyCode));
    const price = formatPrice(t.price);
    const photoUrl = buildPhotoUrl(t.image_url);

    lines.push(`${idx} <b>${hotelName}</b>`);
    lines.push(`📍 ${location}`);
    lines.push(starsLine);
    lines.push("");
    lines.push(`📅 ${dateFrom} • ${nightsText} ночей`);
    lines.push(`🍽 ${meal} • 🛏 ${room}`);
    lines.push(`💸 <b>${price} ${currency}</b>`);
    lines.push(`🧳 ${operator}`);
    if (photoUrl) {
      lines.push(`🖼 Фото: ${escapeHtml(photoUrl)}`);
    }

    if (i < shown.length - 1) {
      lines.push("");
    }
  }

  const requestid = escapeHtml(asString(output?.requestid, "—"));
  const ms = asNumber(output?.meta?.ms);
  const msText = ms !== undefined ? `${Math.max(0, Math.floor(ms))}` : "0";

  lines.push("");
  lines.push(`<i>requestid: ${requestid} • ${msText}ms</i>`);

  return lines.join("\n");
}

export function formatToursForTelegram(output: any, opts?: { top?: number }): string {
  const rawResults = Array.isArray(output?.results) ? output.results : [];
  if (rawResults.length === 0) {
    return "😕 Ничего не нашла по фильтрам.\n\nПопробуй:\n• увеличить budget_max\n• снизить rating\n• расширить nights_min/max";
  }

  const requestedTop = asNumber(opts?.top);
  let top = Math.max(1, Math.min(rawResults.length, Math.floor(requestedTop ?? 5)));

  let message = renderMessage(output, top);
  while (message.length > 3500 && top > 1) {
    top -= 1;
    message = renderMessage(output, top);
  }

  return message;
}
