// Small helpers shared across src/index.js, src/admin.js and src/cancel.js —
// kept in one place so nothing gets duplicated (or drifts) between them.

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Current wall-clock date/time in Europe/Berlin, independent of the
// runtime's own timezone.
export function berlinNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  // hour12:false can yield "24" for midnight; normalize to 0.
  const hour = map.hour === "24" ? 0 : parseInt(map.hour, 10);
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    minutes: hour * 60 + parseInt(map.minute, 10),
  };
}

// Minutes between "now" (Europe/Berlin) and a given date+time (also
// interpreted as Europe/Berlin wall-clock), for cancellation-window checks.
export function minutesUntil(date, time) {
  const now = berlinNow();
  const nowTotal = dateToDayIndex(now.date) * 1440 + now.minutes;
  const apptTotal = dateToDayIndex(date) * 1440 + toMinutes(time);
  return apptTotal - nowTotal;
}

function dateToDayIndex(dateStr) {
  // Days since epoch for a YYYY-MM-DD string, treated as a plain calendar
  // date (no timezone conversion) so it composes with berlinNow()'s
  // already-Berlin-local date string.
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function localizedDate(dateStr, lang) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(lang === "en" ? "en-GB" : "de-DE", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}
