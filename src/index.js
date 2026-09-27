import catalog from "../catalog.json";

// Walk a category's decision tree following a list of chosen option ids,
// returning the resolved leaf plus the breadcrumb of option labels chosen
// along the way. Never trusts client-submitted price/duration/name.
function resolveLeaf(audience, categoryId, path) {
  const categories = catalog[audience];
  if (!categories) return null;
  const category = categories.find((c) => c.id === categoryId);
  if (!category) return null;

  let node = category.root;
  const breadcrumb = [];
  for (const choiceId of path || []) {
    if (!node || node.type !== "branch") return null;
    const chosen = node.options.find((o) => o.id === choiceId);
    if (!chosen) return null;
    breadcrumb.push(chosen.name);
    node = chosen.next;
  }
  if (!node || node.type !== "leaf") return null;
  return { leaf: node, breadcrumb, category };
}

function localizedBreadcrumbName(resolved, lang) {
  if (resolved.leaf.name) return resolved.leaf.name[lang] || resolved.leaf.name.de;
  return resolved.breadcrumb.map((b) => b[lang] || b.de).join(" – ");
}

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

const BOOKING_LEAD_MINUTES = 120;

// Current wall-clock date/time in Europe/Berlin, independent of the runtime's own timezone.
function berlinNow() {
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

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const EMAIL_STRINGS = {
  de: {
    heading: "Ihr Termin ist bestätigt",
    hi: (name) => `Hallo ${name},`,
    detailsIntro: "Hier sind Ihre Buchungsdetails:",
    service: "Leistung",
    date: "Datum",
    time: "Uhrzeit",
    duration: "Dauer",
    price: "Preis",
    priceOnRequest: "Wird nach Diagnose vor Ort mitgeteilt",
    minutes: "Min.",
    reschedule: "Falls Sie umbuchen oder stornieren möchten, antworten Sie einfach auf diese E-Mail.",
    signature: "- Zettly",
    subject: (serviceName, date, time) => `Bestätigt: ${serviceName} am ${date} um ${time}`,
  },
  en: {
    heading: "Your appointment is confirmed",
    hi: (name) => `Hi ${name},`,
    detailsIntro: "Here are your booking details:",
    service: "Service",
    date: "Date",
    time: "Time",
    duration: "Duration",
    price: "Price",
    priceOnRequest: "Quoted after on-site diagnosis",
    minutes: "min",
    reschedule: "If you need to reschedule or cancel, just reply to this email.",
    signature: "- Zettly",
    subject: (serviceName, date, time) => `Confirmed: ${serviceName} on ${date} at ${time}`,
  },
};

async function handleServices() {
  return json(catalog);
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

  const now = berlinNow();
  if (date < now.date) {
    return json({ date, slots: [] });
  }
  const cutoffMinutes = date === now.date ? now.minutes + BOOKING_LEAD_MINUTES : -Infinity;

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
    if (t < cutoffMinutes) continue;
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

async function sendConfirmationEmail(env, booking, service, lang) {
  if (!env.RESEND_API_KEY) {
    return { sent: false, reason: "no_api_key" };
  }

  const t = EMAIL_STRINGS[lang] || EMAIL_STRINGS.de;
  const serviceName = booking.serviceName;
  const from = env.RESEND_FROM || "Zettly <onboarding@resend.dev>";
  const priceCell = service.quote ? t.priceOnRequest : `&euro;${service.price}`;

  const html = `
    <div style="font-family: Arial, sans-serif; color: #111;">
      <h2>${t.heading}</h2>
      <p>${t.hi(booking.customer_name)}</p>
      <p>${t.detailsIntro}</p>
      <table style="border-collapse: collapse;">
        <tr><td style="padding:4px 12px 4px 0;"><b>${t.service}</b></td><td>${serviceName}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><b>${t.date}</b></td><td>${booking.date}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><b>${t.time}</b></td><td>${booking.time}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><b>${t.duration}</b></td><td>${service.duration} ${t.minutes}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><b>${t.price}</b></td><td>${priceCell}</td></tr>
      </table>
      <p>${t.reschedule}</p>
      <p>${t.signature}</p>
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
      subject: t.subject(serviceName, booking.date, booking.time),
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

  const { audience, categoryId, path, date, time, name, email, phone, notes, lang: rawLang } = body;
  const lang = rawLang === "en" ? "en" : "de";
  const audienceTag = audience === "business" ? "[business] " : audience === "home" ? "[home] " : "";

  if (!audience || !categoryId || !date || !time || !name || !email) {
    return json({ error: "Missing required fields" }, 400);
  }

  const resolved = resolveLeaf(audience, categoryId, path);
  if (!resolved) {
    return json({ error: "Unknown service" }, 400);
  }
  const { leaf } = resolved;
  const serviceName = localizedBreadcrumbName(resolved, lang);
  const service = { duration: leaf.duration, price: leaf.price, quote: leaf.quote };
  const quoteTag = leaf.quote ? "[Kostenvoranschlag vor Ort] " : "";
  const notesWithAudience = `${audienceTag}${quoteTag}${notes || ""}`.trim() || null;

  if (!isValidEmail(email)) {
    return json({ error: "Invalid email" }, 400);
  }

  const now = berlinNow();
  const requestedMinutes = toMinutes(time);
  const isPastDate = date < now.date;
  const isTooSoon = date === now.date && requestedMinutes < now.minutes + BOOKING_LEAD_MINUTES;
  if (isPastDate || isTooSoon) {
    return json({ error: "This time is no longer available, please pick a later slot" }, 409);
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
  const serviceIdStr = `${audience}:${categoryId}:${(path || []).join(":")}`;

  await env.DB.prepare(
    `INSERT INTO bookings (id, service_id, service_name, price, duration_minutes, date, time, customer_name, customer_email, customer_phone, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      serviceIdStr,
      serviceName,
      leaf.quote ? 0 : leaf.price,
      leaf.duration,
      date,
      time,
      name,
      email,
      phone || null,
      notesWithAudience
    )
    .run();

  const booking = { id, date, time, customer_name: name, customer_email: email, serviceName };
  const emailResult = await sendConfirmationEmail(env, booking, service, lang);

  return json({
    id,
    service: serviceName,
    date,
    time,
    price: leaf.quote ? null : leaf.price,
    quote: !!leaf.quote,
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
