import catalog from "../catalog.json";
import { generateBookingPdf, toBase64 } from "./pdf.js";
import { getSession, createCancelToken } from "./auth.js";
import { json, toMinutes, berlinNow, isValidEmail, localizedDate } from "./utils.js";
import { LOGO_PNG_BASE64 } from "./logo.js";
import { resolveLeaf as resolveLeafFromCatalog, fullBreadcrumb as buildFullBreadcrumb, localizedBreadcrumbName } from "./catalog-utils.js";
import {
  handleAdminLogin,
  handleAdminLogout,
  handleAdminMe,
  handleAdminListBookings,
  handleAdminBookingDetail,
  handleAdminUpdateStatus,
} from "./admin.js";
import { handleCancelInfo, handleCancelSubmit } from "./cancel.js";

// How long a "cancel my booking" link in the confirmation email stays valid.
// Generous on purpose (appointments can be booked weeks out) — the 24-hour
// cutoff on actually cancelling is enforced separately, server-side, in
// src/cancel.js based on the booking's real date/time, not this expiry.
const CANCEL_LINK_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function resolveLeaf(audience, categoryId, path) {
  return resolveLeafFromCatalog(catalog, audience, categoryId, path);
}

function fullBreadcrumb(resolved, audience, lang) {
  return buildFullBreadcrumb(resolved, audience, lang);
}

const OPEN_HOUR = 9;
const CLOSE_HOUR = 17;
const SLOT_STEP_MIN = 30;

const BOOKING_LEAD_MINUTES = 120;

// Buffer kept around every existing booking so the technician always has
// travel/prep time on both sides: nothing else can start less than 2 hours
// before it, or less than 3 hours after it starts. A noon booking blocks
// 10:00–14:59, so the next slot anyone can take is 15:00.
const BOOKING_BUFFER_BEFORE_MIN = 120;
const BOOKING_BUFFER_AFTER_MIN = 180;

function bookingBlocksSlot(candidateStart, candidateEnd, bookingStart) {
  return candidateStart < bookingStart + BOOKING_BUFFER_AFTER_MIN && candidateEnd > bookingStart - BOOKING_BUFFER_BEFORE_MIN;
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
    reschedule: "Sie können Ihren Termin kostenlos stornieren – bis zu 24 Stunden vorher.",
    cancelButton: "Termin stornieren",
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
    reschedule: "You can cancel free of charge – up to 24 hours before your appointment.",
    cancelButton: "Cancel appointment",
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

    const conflicts = existing.some((b) => bookingBlocksSlot(t, slotEnd, toMinutes(b.time)));

    slots.push({ time, available: !conflicts });
  }

  return json({ date, slots });
}

async function sendConfirmationEmail(env, booking, service, lang) {
  if (!env.RESEND_API_KEY) {
    return { sent: false, reason: "no_api_key" };
  }

  const t = EMAIL_STRINGS[lang] || EMAIL_STRINGS.de;
  const from = env.RESEND_FROM || "Zettly <no-reply@zettly.de>";
  const priceText = service.quote ? t.priceOnRequest : `€${service.price}`;

  let cancelUrl = null;
  if (env.SESSION_SECRET) {
    const token = await createCancelToken(env.SESSION_SECRET, booking.id, Date.now() + CANCEL_LINK_TTL_MS);
    cancelUrl = `${new URL(env.SITE_URL || "https://zettly.de").origin}/cancel?token=${encodeURIComponent(token)}&lang=${lang}`;
  }

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
              <div style="font-family:'Helvetica Neue', Arial, sans-serif; font-size:24px; font-weight:200; letter-spacing:0.01em;"><span style="color:#111114;">zett</span><span style="color:#7C3AED;">ly</span></div>
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
        ${
          cancelUrl
            ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;">
          <tr>
            <td style="border-radius:8px; background:#fdeef2;">
              <a href="${cancelUrl}" style="display:inline-block; padding:11px 20px; font-family:'Helvetica Neue', Arial, sans-serif; font-size:13px; font-weight:700; color:#c2185b; text-decoration:none; border-radius:8px;">${t.cancelButton}</a>
            </td>
          </tr>
        </table>`
            : ""
        }
        <p style="margin:14px 0 0; font-size:11.5px; color:#8a8a92; line-height:1.5;">${t.cancelNote}</p>
        <p style="margin:18px 0 0; font-size:13px; font-weight:700; color:#111114;">${t.signature}</p>
      </div>
    </div>
  </div>
  `;

  let attachments;
  try {
    // Always attach both a German and an English copy of the confirmation
    // PDF, regardless of which language the customer booked in or the
    // email body itself is written in.
    const dateDisplayDe = localizedDate(booking.date, "de");
    const dateDisplayEn = localizedDate(booking.date, "en");
    const pdfBytesDe = generateBookingPdf({
      bookingRef: booking.bookingRef,
      customerName: booking.customer_name,
      customerEmail: booking.customer_email,
      customerAddress: booking.customer_address,
      breadcrumb: booking.breadcrumbDe,
      date: booking.date,
      dateDisplay: dateDisplayDe,
      time: booking.time,
      duration: service.duration,
      priceText,
      lang: "de",
    });
    const pdfBytesEn = generateBookingPdf({
      bookingRef: booking.bookingRef,
      customerName: booking.customer_name,
      customerEmail: booking.customer_email,
      customerAddress: booking.customer_address,
      breadcrumb: booking.breadcrumbEn,
      date: booking.date,
      dateDisplay: dateDisplayEn,
      time: booking.time,
      duration: service.duration,
      priceText,
      lang: "en",
    });
    attachments = [
      {
        filename: `zettly-buchung-${booking.bookingRef}-de.pdf`,
        content: toBase64(pdfBytesDe),
      },
      {
        filename: `zettly-booking-${booking.bookingRef}-en.pdf`,
        content: toBase64(pdfBytesEn),
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
  const clash = conflicts.some((b) => bookingBlocksSlot(start, end, toMinutes(b.time)));

  if (clash) {
    return json({ error: "Slot just got booked, please pick another" }, 409);
  }

  const id = crypto.randomUUID();
  const bookingRef = `ZTL-${id.split("-")[0].toUpperCase()}`;
  const breadcrumb = fullBreadcrumb(resolved, audience, lang);
  // The confirmation PDF always ships in both languages (two attachments),
  // regardless of which language the customer booked in, so both
  // breadcrumbs are resolved here rather than just the request's own lang.
  const breadcrumbDe = fullBreadcrumb(resolved, audience, "de");
  const breadcrumbEn = fullBreadcrumb(resolved, audience, "en");
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

  const booking = { id, bookingRef, breadcrumb, breadcrumbDe, breadcrumbEn, date, time, customer_name: name, customer_email: email, customer_address: address, serviceName };
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
    if (url.pathname === "/api/cancel-info" && request.method === "GET") {
      return handleCancelInfo(url, env);
    }
    if (url.pathname === "/api/cancel" && request.method === "POST") {
      return handleCancelSubmit(request, env);
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

    // Public self-service cancellation page — a static shell (like /admin)
    // that reads ?token= and drives it through /api/cancel-info + /api/cancel.
    if (url.pathname === "/cancel" || url.pathname === "/cancel/") {
      return env.ASSETS.fetch(new Request(new URL("/cancel/index.html", request.url), request));
    }

    // Everything else: serve the static site
    return env.ASSETS.fetch(request);
  },
};
