// GET /api/availability?date=YYYY-MM-DD&duration=60
// Returns { date, slots: [{ time: "09:00", available: true }, ...] }

const OPEN_HOUR = 9;
const CLOSE_HOUR = 17;
const SLOT_STEP_MIN = 30;

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function isWeekend(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  const duration = parseInt(url.searchParams.get("duration") || "60", 10);

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Response(JSON.stringify({ error: "Invalid or missing date" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (isWeekend(date)) {
    return new Response(JSON.stringify({ date, slots: [] }), {
      headers: { "content-type": "application/json" },
    });
  }

  let existing = [];
  if (env.DB) {
    const { results } = await env.DB.prepare(
      "SELECT time, duration_minutes FROM bookings WHERE date = ? AND status = 'confirmed'"
    )
      .bind(date)
      .all();
    existing = results;
  }

  const slots = [];
  for (let t = OPEN_HOUR * 60; t + duration <= CLOSE_HOUR * 60; t += SLOT_STEP_MIN) {
    const hh = String(Math.floor(t / 60)).padStart(2, "0");
    const mm = String(t % 60).padStart(2, "0");
    const time = `${hh}:${mm}`;
    const slotEnd = t + duration;

    const conflicts = existing.some((b) => {
      const bStart = toMinutes(b.time);
      const bEnd = bStart + b.duration_minutes;
      return t < bEnd && slotEnd > bStart;
    });

    slots.push({ time, available: !conflicts });
  }

  return new Response(JSON.stringify({ date, slots }), {
    headers: { "content-type": "application/json" },
  });
}
