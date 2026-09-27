import services from "../services.json";

const ALL_SERVICES = [...services.it, ...services.dynamics];

const OPEN_HOUR = 9;
const CLOSE_HOUR = 17;
const SLOT_STEP_MIN = 30;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function isWeekend(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

function findService(id) {
  return ALL_SERVICES.find((s) => s.id === id);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function handleServices() {
  return json(services);
}

async function handleAvailability(url, env) {
  const date = url.searchParams.get("date");
  const duration = parseInt(url.searchParams.get("duration") || "60", 10);

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ error: "Invalid or missing date" }, 400);
  }

  if (isWeekend(date)) {
    return json({ date, slots: [] });
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

  return json({ date, slots });
}

async function sendConfirmationEmail(env, booking, service) {
  if (!env.RESEND_API_KEY) {
    return { sent: false, reason: "no_api_key" };
  }

  const from = env.RESEND_FROM || "Zettly <onboarding@resend.dev>";

  const html = `
    <div style="font-family: Arial, sans-serif; color: #111;">
      <h2>Your appointment is confirmed</h2>
      <p>Hi ${booking.customer_name},</p>
      <p>Here are your booking details:</p>
      <table style="border-collapse: collapse;">
        <tr><td style="padding:4px 12px 4px 0;"><b>Service</b></td><td>${service.name}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><b>Date</b></td><td>${booking.date}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><b>Time</b></td><td>${booking.time}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><b>Duration</b></td><td>${service.duration} min</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><b>Price</b></td><td>&euro;${service.price}</td></tr>
      </table>
      <p>If you need to reschedule or cancel, just reply to this email.</p>
      <p>- Zettly</p>
    </div>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: booking.customer_email,
      subject: `Confirmed: ${service.name} on ${booking.date} at ${booking.time}`,
      html,
    }),
  });

  return { sent: res.ok, status: res.status };
}

async function handleBook(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { serviceId, date, time, name, email, phone, notes } = body;

  if (!serviceId || !date || !time || !name || !email) {
    return json({ error: "Missing required fields" }, 400);
  }

  const service = findService(serviceId);
  if (!service) {
    return json({ error: "Unknown service" }, 400);
  }

  if (!isValidEmail(email)) {
    return json({ error: "Invalid email" }, 400);
  }

  if (!env.DB) {
    return json({ error: "Booking database not configured yet" }, 503);
  }

  const { results: conflicts } = await env.DB.prepare(
    `SELECT time, duration_minutes FROM bookings WHERE date = ? AND status = 'confirmed'`
  )
    .bind(date)
    .all();

  const start = toMinutes(time);
  const end = start + service.duration;
  const clash = conflicts.some((b) => {
    const bStart = toMinutes(b.time);
    const bEnd = bStart + b.duration_minutes;
    return start < bEnd && end > bStart;
  });

  if (clash) {
    return json({ error: "Slot just got booked, please pick another" }, 409);
  }

  const id = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO bookings (id, service_id, service_name, price, duration_minutes, date, time, customer_name, customer_email, customer_phone, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      service.id,
      service.name,
      service.price,
      service.duration,
      date,
      time,
      name,
      email,
      phone || null,
      notes || null
    )
    .run();

  const booking = { id, date, time, customer_name: name, customer_email: email };
  const emailResult = await sendConfirmationEmail(env, booking, service);

  return json({
    id,
    service: service.name,
    date,
    time,
    price: service.price,
    emailSent: emailResult.sent,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/services" && request.method === "GET") {
      return handleServices();
    }
    if (url.pathname === "/api/availability" && request.method === "GET") {
      return handleAvailability(url, env);
    }
    if (url.pathname === "/api/book" && request.method === "POST") {
      return handleBook(request, env);
    }

    // Everything else: serve the static site
    return env.ASSETS.fetch(request);
  },
};
