import catalog from "../catalog.json";
import { generateBookingPdf, toBase64 } from "./pdf.js";

const AUDIENCE_LABELS = {
  home: { de: "Zuhause", en: "Home" },
  business: { de: "Unternehmen", en: "Business" },
};

function localizedDate(dateStr, lang) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(lang === "en" ? "en-GB" : "de-DE", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

// Full selection breadcrumb: audience, category, then each tree choice - in
// the same shape the frontend summary card and PDF/email now show.
function fullBreadcrumb(resolved, audience, lang) {
  const parts = [AUDIENCE_LABELS[audience]?.[lang] || AUDIENCE_LABELS[audience]?.de || audience];
  if (resolved.category?.name) parts.push(resolved.category.name[lang] || resolved.category.name.de);
  for (const b of resolved.breadcrumb) parts.push(b[lang] || b.de);
  return parts;
}

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
    detailsIntro: "Vielen Dank für Ihre Buchung bei Zettly. Hier Ihre Details:",
    ref: "Buchungsnummer",
    service: "Leistung",
    date: "Datum",
    time: "Uhrzeit",
    duration: "Dauer",
    price: "Preis",
    priceOnRequest: "Wird nach Diagnose vor Ort mitgeteilt",
    minutes: "Min.",
    reschedule: "Falls Sie umbuchen oder stornieren möchten, antworten Sie einfach auf diese E-Mail.",
    pdfNote: "Ihre Buchungsbestätigung als PDF finden Sie im Anhang.",
    signature: "Ihr Zettly-Team",
    subject: (serviceName, date, time) => `Bestätigt: ${serviceName} am ${date} um ${time}`,
  },
  en: {
    heading: "Your appointment is confirmed",
    hi: (name) => `Hi ${name},`,
    detailsIntro: "Thanks for booking with Zettly. Here are your details:",
    ref: "Booking reference",
    service: "Service",
    date: "Date",
    time: "Time",
    duration: "Duration",
    price: "Price",
    priceOnRequest: "Quoted after on-site diagnosis",
    minutes: "min",
    reschedule: "If you need to reschedule or cancel, just reply to this email.",
    pdfNote: "Your booking confirmation is attached as a PDF.",
    signature: "The Zettly Team",
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
  const priceText = service.quote ? t.priceOnRequest : `€${service.price}`;
  const priceCellHtml = service.quote ? t.priceOnRequest : `&euro;${service.price}`;
  const dateDisplay = localizedDate(booking.date, lang);
  const breadcrumbHtml = booking.breadcrumb.join(
    ' <span style="color:#c4b5fd;">&rsaquo;</span> '
  );

  const html = `
  <div style="font-family: 'Segoe UI', Arial, sans-serif; background:#f4f2fa; padding:32px 16px;">
    <div style="max-width:520px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; border:1px solid #e9e7ef;">
      <div style="background:linear-gradient(120deg,#7C3AED,#a855f7 60%,#EC4899); padding:28px 28px 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
          <tr>
            <td style="padding-right:11px; vertical-align:middle;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="36" height="36" style="width:36px; height:36px; background:#ffffff; border-radius:10px;">
                <tr>
                  <td align="center" valign="middle" style="width:36px; height:36px; font-family:'Segoe UI', Arial, sans-serif; font-size:19px; font-weight:800; color:#7C3AED;">z</td>
                </tr>
              </table>
            </td>
            <td style="vertical-align:middle;">
              <div style="color:#ffffff; font-size:24px; font-weight:800; letter-spacing:-0.02em;">zettly</div>
            </td>
          </tr>
        </table>
        <div style="color:#f1e9ff; font-size:14px; margin-top:10px;">${t.heading}</div>
        <div style="display:inline-block; margin-top:14px; background:rgba(255,255,255,0.18); color:#ffffff; font-size:12px; font-weight:700; padding:6px 12px; border-radius:999px;">${t.ref}: ${booking.bookingRef}</div>
      </div>
      <div style="padding:28px;">
        <p style="margin:0 0 6px; font-size:15px; font-weight:700; color:#111114;">${t.hi(booking.customer_name)}</p>
        <p style="margin:0 0 18px; font-size:13.5px; color:#6b6b74;">${t.detailsIntro}</p>
        <div style="font-size:11px; font-weight:700; color:#6b6b74; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:6px;">${t.service}</div>
        <div style="font-size:14px; font-weight:700; color:#7C3AED; margin-bottom:18px; line-height:1.6;">${breadcrumbHtml}</div>
        <table style="width:100%; border-collapse:collapse; border-top:1px solid #e9e7ef; padding-top:6px;">
          <tr><td style="padding:9px 0; font-size:11.5px; color:#6b6b74; text-transform:uppercase;">${t.date}</td><td style="padding:9px 0; font-size:14px; font-weight:700; color:#111114; text-align:right;">${dateDisplay}</td></tr>
          <tr><td style="padding:9px 0; font-size:11.5px; color:#6b6b74; text-transform:uppercase; border-top:1px solid #f1f0f5;">${t.time}</td><td style="padding:9px 0; font-size:14px; font-weight:700; color:#111114; text-align:right; border-top:1px solid #f1f0f5;">${booking.time}</td></tr>
          <tr><td style="padding:9px 0; font-size:11.5px; color:#6b6b74; text-transform:uppercase; border-top:1px solid #f1f0f5;">${t.duration}</td><td style="padding:9px 0; font-size:14px; font-weight:700; color:#111114; text-align:right; border-top:1px solid #f1f0f5;">${service.duration} ${t.minutes}</td></tr>
          <tr><td style="padding:9px 0; font-size:11.5px; color:#6b6b74; text-transform:uppercase; border-top:1px solid #f1f0f5;">${t.price}</td><td style="padding:9px 0; font-size:15px; font-weight:800; color:#7C3AED; text-align:right; border-top:1px solid #f1f0f5;">${priceCellHtml}</td></tr>
        </table>
        <p style="margin:20px 0 0; font-size:12.5px; color:#6b6b74;">${t.pdfNote}</p>
        <p style="margin:14px 0 0; font-size:12.5px; color:#6b6b74;">${t.reschedule}</p>
        <p style="margin:18px 0 0; font-size:13px; font-weight:700; color:#111114;">${t.signature}</p>
      </div>
    </div>
  </div>
  `;

  let attachments;
  try {
    const pdfBytes = generateBookingPdf({
      bookingRef: booking.bookingRef,
      customerName: booking.customer_name,
      customerEmail: booking.customer_email,
      breadcrumb: booking.breadcrumb,
      date: booking.date,
      dateDisplay,
      time: booking.time,
      duration: service.duration,
      priceText,
      lang,
    });
    attachments = [
      {
        filename: `zettly-${booking.bookingRef}.pdf`,
        content: toBase64(pdfBytes),
      },
    ];
  } catch (e) {
    attachments = undefined;
  }

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
      ...(attachments ? { attachments } : {}),
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
  const bookingRef = `ZTL-${id.split("-")[0].toUpperCase()}`;
  const breadcrumb = fullBreadcrumb(resolved, audience, lang);
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

  const booking = { id, bookingRef, breadcrumb, date, time, customer_name: name, customer_email: email, serviceName };
  const emailResult = await sendConfirmationEmail(env, booking, service, lang);

  return json({
    id,
    bookingRef,
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
