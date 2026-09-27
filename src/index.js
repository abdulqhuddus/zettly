import catalog from "../catalog.json";
import { generateBookingPdf, toBase64 } from "./pdf.js";
import { getSession } from "./auth.js";
import {
  handleAdminLogin,
  handleAdminLogout,
  handleAdminMe,
  handleAdminListBookings,
  handleAdminBookingDetail,
  handleAdminUpdateStatus,
} from "./admin.js";

// The site's actual 4-square brand mark, rasterized once (see
// scripts/make-logo-png.js) so the confirmation email can carry the real
// logo as an inline image rather than an approximation. Data-URI images
// render in Gmail, Apple Mail, Outlook.com and mobile clients; only legacy
// Outlook desktop (Word engine) won't show it, so the alt text still names
// the brand for that fallback case.
const LOGO_PNG_BASE64 =
  "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";

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
    detailsIntro: "Vielen Dank für Ihre Buchung bei Zettly.",
    attachmentTitle: "Buchungsbestätigung.pdf",
    ref: "Buchungsnummer",
    service: "Leistung",
    date: "Datum",
    time: "Uhrzeit",
    duration: "Dauer",
    price: "Preis",
    address: "Adresse",
    priceOnRequest: "Wird nach Diagnose vor Ort mitgeteilt",
    minutes: "Min.",
    reschedule: "Sie können Ihren Termin kostenlos stornieren – bis zu einem Tag vorher.",
    cancelButton: "Termin stornieren",
    cancelSubject: (ref) => `Stornierung Buchung ${ref}`,
    cancelBody: (ref, date, time) => `Hallo Zettly-Team,\n\nbitte stornieren Sie meine Buchung ${ref} am ${date} um ${time} Uhr.\n\nVielen Dank!`,
    cancelNote: "Bitte beachten Sie: Zettly behält sich das Recht vor, eine Buchung in Ausnahmefällen zu stornieren oder zu verschieben. Wir informieren Sie in diesem Fall umgehend.",
    pdfNote: "Bitte entnehmen Sie die vollständige Buchungsbestätigung dem beigefügten PDF.",
    signature: "Ihr Zettly-Team",
    subject: (bookingRef) => `Buchungsbestätigung ${bookingRef}`,
  },
  en: {
    heading: "Your appointment is confirmed",
    hi: (name) => `Hi ${name},`,
    detailsIntro: "Thanks for booking with Zettly.",
    attachmentTitle: "Booking-Confirmation.pdf",
    ref: "Booking reference",
    service: "Service",
    date: "Date",
    time: "Time",
    duration: "Duration",
    price: "Price",
    address: "Address",
    priceOnRequest: "Quoted after on-site diagnosis",
    minutes: "min",
    reschedule: "You can cancel free of charge – up to one day before your appointment.",
    cancelButton: "Cancel appointment",
    cancelSubject: (ref) => `Cancellation for booking ${ref}`,
    cancelBody: (ref, date, time) => `Hi Zettly team,\n\nPlease cancel my booking ${ref} on ${date} at ${time}.\n\nThank you!`,
    cancelNote: "Please note: Zettly reserves the right to cancel or reschedule a booking in exceptional cases. We will inform you immediately if this happens.",
    pdfNote: "Please find your full booking confirmation attached.",
    signature: "The Zettly Team",
    subject: (bookingRef) => `Booking Confirmation ${bookingRef}`,
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
  const from = env.RESEND_FROM || "Zettly <onboarding@resend.dev>";
  const priceText = service.quote ? t.priceOnRequest : `€${service.price}`;
  const dateDisplay = localizedDate(booking.date, lang);
  const cancelMailto = `mailto:kontakt@zettly.de?subject=${encodeURIComponent(t.cancelSubject(booking.bookingRef))}&body=${encodeURIComponent(t.cancelBody(booking.bookingRef, dateDisplay, booking.time))}`;

  const html = `
  <div style="font-family: 'Segoe UI', Arial, sans-serif; background:#f4f2fa; padding:32px 16px;">
    <div style="max-width:520px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; border:1px solid #e9e7ef;">
      <div style="background:#ffffff; padding:26px 28px 20px; border-bottom:1px solid #e9e7ef;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
          <tr>
            <td style="padding-right:10px; vertical-align:middle;">
              <img src="cid:zettly-logo" width="34" height="34" alt="zettly" style="display:block; width:34px; height:34px;">
            </td>
            <td style="vertical-align:middle;">
              <div style="font-family:'Helvetica Neue', Arial, sans-serif; font-size:24px; font-weight:300; letter-spacing:0.01em;"><span style="color:#111114;">zett</span><span style="color:#7C3AED;">ly</span></div>
            </td>
          </tr>
        </table>
        <div style="color:#6b6b74; font-size:14px; margin-top:10px;">${t.heading}</div>
        <div style="display:inline-block; margin-top:14px; background:#f3eeff; color:#7C3AED; font-size:12px; font-weight:700; padding:6px 12px; border-radius:999px;">${t.ref}: ${booking.bookingRef}</div>
      </div>
      <div style="height:4px; background:linear-gradient(90deg,#7C3AED,#a855f7 60%,#EC4899);"></div>
      <div style="padding:28px;">
        <p style="margin:0 0 6px; font-size:15px; font-weight:700; color:#111114;">${t.hi(booking.customer_name)}</p>
        <p style="margin:0 0 22px; font-size:13.5px; color:#6b6b74; line-height:1.5;">${t.detailsIntro}</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse; background:#f8f7fb; border:1px solid #e9e7ef; border-radius:12px;">
          <tr>
            <td style="padding:16px 18px; vertical-align:middle; width:44px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="36" height="36" style="width:36px; height:36px; background:#efe8ff; border-radius:9px;">
                <tr><td align="center" valign="middle" style="width:36px; height:36px; font-size:16px; font-weight:800; color:#7C3AED; font-family:'Helvetica Neue', Arial, sans-serif;">PDF</td></tr>
              </table>
            </td>
            <td style="padding:16px 18px 16px 0; vertical-align:middle;">
              <div style="font-size:13.5px; font-weight:700; color:#111114; margin-bottom:2px;">${t.attachmentTitle}</div>
              <div style="font-size:12.5px; color:#6b6b74;">${t.pdfNote}</div>
            </td>
          </tr>
        </table>
        <p style="margin:22px 0 0; font-size:12.5px; color:#6b6b74;">${t.reschedule}</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;">
          <tr>
            <td style="border-radius:8px; background:#fdeef2;">
              <a href="${cancelMailto}" style="display:inline-block; padding:11px 20px; font-family:'Helvetica Neue', Arial, sans-serif; font-size:13px; font-weight:700; color:#c2185b; text-decoration:none; border-radius:8px;">${t.cancelButton}</a>
            </td>
          </tr>
        </table>
        <p style="margin:14px 0 0; font-size:11.5px; color:#8a8a92; line-height:1.5;">${t.cancelNote}</p>
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
      customerAddress: booking.customer_address,
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
      // Inline logo referenced from the HTML body as `cid:zettly-logo`. A
      // data-URI <img> (tried previously) doesn't reliably render once the
      // mail passes through Resend/the recipient's client, so the logo is
      // sent as a proper inline attachment instead, which every major
      // client (Gmail, Outlook, Apple Mail) resolves via its Content-ID.
      {
        filename: "zettly-logo.png",
        content: LOGO_PNG_BASE64,
        content_id: "zettly-logo",
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
      subject: t.subject(booking.bookingRef),
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

  const { audience, categoryId, path, date, time, name, email, phone, address, notes, lang: rawLang } = body;
  const lang = rawLang === "en" ? "en" : "de";
  const audienceTag = audience === "business" ? "[business] " : audience === "home" ? "[home] " : "";

  if (!audience || !categoryId || !date || !time || !name || !email || !address) {
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
    `INSERT INTO bookings (id, service_id, service_name, price, duration_minutes, date, time, customer_name, customer_email, customer_phone, customer_address, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      address,
      notesWithAudience
    )
    .run();

  const booking = { id, bookingRef, breadcrumb, date, time, customer_name: name, customer_email: email, customer_address: address, serviceName };
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

    // ---- Admin API ----
    // /api/admin/login and /me are reachable without a session (that's how
    // you get one / check whether you have one); every other /api/admin/*
    // route requires a verified session cookie.
    if (url.pathname === "/api/admin/login" && request.method === "POST") {
      return handleAdminLogin(request, env);
    }
    if (url.pathname === "/api/admin/logout" && request.method === "POST") {
      return handleAdminLogout();
    }
    if (url.pathname === "/api/admin/me" && request.method === "GET") {
      return handleAdminMe(request, env);
    }
    if (url.pathname.startsWith("/api/admin/")) {
      const session = await getSession(request, env);
      if (!session) {
        return new Response(JSON.stringify({ error: "Not authenticated" }), {
          status: 401,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      if (url.pathname === "/api/admin/bookings" && request.method === "GET") {
        return handleAdminListBookings(url, env);
      }
      const bookingMatch = url.pathname.match(/^\/api\/admin\/bookings\/([^/]+)(?:\/status)?$/);
      if (bookingMatch && request.method === "GET") {
        return handleAdminBookingDetail(env, bookingMatch[1]);
      }
      if (bookingMatch && url.pathname.endsWith("/status") && request.method === "POST") {
        return handleAdminUpdateStatus(request, env, bookingMatch[1]);
      }
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    // The admin page itself carries no sensitive data server-side (it's a
    // static shell that fetches everything through the authenticated API
    // above), but keep it out of search results either way.
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      const res = await env.ASSETS.fetch(new Request(new URL("/admin/index.html", request.url), request));
      const headers = new Headers(res.headers);
      headers.set("X-Robots-Tag", "noindex, nofollow");
      return new Response(res.body, { status: res.status, headers });
    }

    // Everything else: serve the static site
    return env.ASSETS.fetch(request);
  },
};
