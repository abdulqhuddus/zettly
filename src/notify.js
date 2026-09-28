// Cancellation email, shared by the admin panel (src/admin.js) and the
// customer self-service cancellation page (src/cancel.js), so both send the
// exact same notice with the same PDF attached rather than drifting apart.

import catalog from "../catalog.json";
import { generateBookingPdf, toBase64 } from "./pdf.js";
import { LOGO_PNG_BASE64 } from "./logo.js";
import { localizedDate } from "./utils.js";
import { breadcrumbFromServiceId } from "./catalog-utils.js";

const STRINGS = {
  de: {
    heading: "Ihr Termin wurde storniert",
    hi: (name) => `Hallo ${name},`,
    body: (ref, date, time) =>
      `Ihre Buchung <strong>${ref}</strong> für ${date} um ${time} Uhr wurde storniert.`,
    bodyPlain: (ref, date, time) => `Ihre Buchung ${ref} für ${date} um ${time} Uhr wurde storniert.`,
    attachmentNote: "Zur Übersicht finden Sie die stornierte Buchung im angehängten PDF.",
    rebook: "Falls Sie einen neuen Termin buchen möchten, besuchen Sie gerne erneut unsere Website.",
    signature: "Ihr Zettly-Team",
    subject: (ref) => `Stornierung Buchung ${ref}`,
  },
  en: {
    heading: "Your appointment has been cancelled",
    hi: (name) => `Hi ${name},`,
    body: (ref, date, time) =>
      `Your booking <strong>${ref}</strong> for ${date} at ${time} has been cancelled.`,
    bodyPlain: (ref, date, time) => `Your booking ${ref} for ${date} at ${time} has been cancelled.`,
    attachmentNote: "For your records, the cancelled booking is attached as a PDF.",
    rebook: "If you'd like to book a new appointment, feel free to visit our website again.",
    signature: "The Zettly Team",
    subject: (ref) => `Cancellation for booking ${ref}`,
  },
};

/**
 * Send a cancellation notice (with the booking's PDF re-attached, now
 * showing as cancelled context) to the customer on a booking row.
 * `booking` is a raw `bookings` table row (id, date, time, customer_name,
 * customer_email, customer_address, service_name, price, duration_minutes, …).
 */
export async function sendCancellationEmail(env, booking, lang = "de", opts = {}) {
  const cancelledBy = opts.cancelledBy === "admin" ? "admin" : "customer";
  if (!env.RESEND_API_KEY) return { sent: false, reason: "no_api_key" };
  const t = STRINGS[lang] || STRINGS.de;
  const bookingRef = `ZTL-${booking.id.split("-")[0].toUpperCase()}`;
  const from = env.RESEND_FROM || "Zettly <no-reply@zettly.de>";
  const dateDisplay = localizedDate(booking.date, lang);
  const priceText = booking.price ? `€${booking.price}` : lang === "en" ? "Quoted on-site" : "Vor Ort mitgeteilt";

  const html = `
  <div style="font-family: 'Segoe UI', Arial, sans-serif; background:#f4f2fa; padding:32px 16px;">
    <div style="max-width:480px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; border:1px solid #e9e7ef;">
      <div style="background:#ffffff; padding:24px 28px 18px; border-bottom:1px solid #e9e7ef;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
          <tr>
            <td style="padding-right:10px; vertical-align:middle;">
              <img src="cid:zettly-logo" width="30" height="30" alt="zettly" style="display:block; width:30px; height:30px;">
            </td>
            <td style="vertical-align:middle;">
              <div style="font-family:'Helvetica Neue', Arial, sans-serif; font-size:21px; font-weight:200; letter-spacing:0.01em;"><span style="color:#111114;">zett</span><span style="color:#7C3AED;">ly</span></div>
            </td>
          </tr>
        </table>
        <div style="color:#6b6b74; font-size:13px; margin-top:8px;">${t.heading}</div>
      </div>
      <div style="padding:26px 28px;">
        <p style="margin:0 0 14px; font-size:14px; font-weight:700; color:#111114;">${t.hi(booking.customer_name)}</p>
        <p style="margin:0 0 14px; font-size:13.5px; color:#6b6b74; line-height:1.5;">${t.body(bookingRef, dateDisplay, booking.time)}</p>
        <p style="margin:0 0 14px; font-size:12.5px; color:#8a8a92; line-height:1.5;">${t.attachmentNote}</p>
        <p style="margin:0; font-size:13.5px; color:#6b6b74; line-height:1.5;">${t.rebook}</p>
        <p style="margin:22px 0 0; font-size:13px; font-weight:700; color:#111114;">${t.signature}</p>
      </div>
    </div>
  </div>`;

  let attachments;
  try {
    // Always attach both a German and an English copy of the cancellation
    // PDF, regardless of which language this notice's own body is in.
    const breadcrumbDe = breadcrumbFromServiceId(catalog, booking.service_id, "de") || [booking.service_name];
    const breadcrumbEn = breadcrumbFromServiceId(catalog, booking.service_id, "en") || [booking.service_name];
    const dateDisplayDe = localizedDate(booking.date, "de");
    const dateDisplayEn = localizedDate(booking.date, "en");
    const basePdfData = {
      bookingRef,
      customerName: booking.customer_name,
      customerEmail: booking.customer_email,
      customerAddress: booking.customer_address,
      time: booking.time,
      duration: booking.duration_minutes,
      priceText,
      cancelled: true,
      cancelledBy,
      cancellationReason: booking.cancellation_reason,
    };
    const pdfBytesDe = generateBookingPdf({
      ...basePdfData, breadcrumb: breadcrumbDe, date: booking.date, dateDisplay: dateDisplayDe, lang: "de",
    });
    const pdfBytesEn = generateBookingPdf({
      ...basePdfData, breadcrumb: breadcrumbEn, date: booking.date, dateDisplay: dateDisplayEn, lang: "en",
    });
    attachments = [
      { filename: `zettly-storniert-${bookingRef}-de.pdf`, content: toBase64(pdfBytesDe) },
      { filename: `zettly-cancelled-${bookingRef}-en.pdf`, content: toBase64(pdfBytesEn) },
      { filename: "zettly-logo.png", content: LOGO_PNG_BASE64, content_id: "zettly-logo" },
    ];
  } catch {
    attachments = undefined;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from,
      to: booking.customer_email,
      subject: t.subject(bookingRef),
      html,
      ...(attachments ? { attachments } : {}),
    }),
  });
  return { sent: res.ok, status: res.status };
}

// The address that gets a heads-up whenever a customer cancels their own
// booking. Fixed here rather than in env config, same as the new-booking
// admin notification in src/index.js — it's the owner's own inbox, not
// something that should vary per-deployment.
const ADMIN_NOTIFY_EMAIL = "mohammed.qhuddus@gmail.com";

/**
 * A short, internal-only notice to the site owner that a customer cancelled
 * their own booking (self-service, via the link in their confirmation
 * email) — not sent when the admin panel itself performs the cancellation,
 * since the admin already knows in that case. Best-effort: failing to send
 * this must never affect the customer-facing cancellation flow.
 */
export async function sendAdminCancellationNotification(env, booking) {
  if (!env.RESEND_API_KEY) return { sent: false, reason: "no_api_key" };
  const from = env.RESEND_FROM || "Zettly <no-reply@zettly.de>";
  const bookingRef = `ZTL-${booking.id.split("-")[0].toUpperCase()}`;
  const dateDisplay = localizedDate(booking.date, "de");
  const priceText = booking.price ? `€${booking.price}` : "Vor Ort mitgeteilt";

  const html = `
  <div style="font-family: 'Segoe UI', Arial, sans-serif; background:#f4f2fa; padding:32px 16px;">
    <div style="max-width:480px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; border:1px solid #e9e7ef;">
      <div style="background:#ffffff; padding:22px 26px 16px; border-bottom:1px solid #e9e7ef;">
        <div style="font-family:'Helvetica Neue', Arial, sans-serif; font-size:20px; font-weight:200; letter-spacing:0.01em;"><span style="color:#111114;">zett</span><span style="color:#7C3AED;">ly</span></div>
        <div style="color:#6b6b74; font-size:13px; margin-top:6px;">A customer cancelled their booking</div>
      </div>
      <div style="padding:24px 26px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse; font-size:13.5px; color:#111114;">
          <tr><td style="padding:4px 0; color:#6b6b74;">Reference</td><td style="padding:4px 0; text-align:right; font-weight:700;">${bookingRef}</td></tr>
          <tr><td style="padding:4px 0; color:#6b6b74;">Service</td><td style="padding:4px 0; text-align:right;">${booking.service_name}</td></tr>
          <tr><td style="padding:4px 0; color:#6b6b74;">Date</td><td style="padding:4px 0; text-align:right;">${dateDisplay}</td></tr>
          <tr><td style="padding:4px 0; color:#6b6b74;">Time</td><td style="padding:4px 0; text-align:right;">${booking.time}</td></tr>
          <tr><td style="padding:4px 0; color:#6b6b74;">Price</td><td style="padding:4px 0; text-align:right;">${priceText}</td></tr>
          <tr><td style="padding:12px 0 4px; color:#6b6b74;">Customer</td><td style="padding:12px 0 4px; text-align:right;">${booking.customer_name}</td></tr>
          <tr><td style="padding:4px 0; color:#6b6b74;">Email</td><td style="padding:4px 0; text-align:right;">${booking.customer_email}</td></tr>
          ${booking.customer_phone ? `<tr><td style="padding:4px 0; color:#6b6b74;">Phone</td><td style="padding:4px 0; text-align:right;">${booking.customer_phone}</td></tr>` : ""}
          <tr><td style="padding:12px 0 4px; color:#6b6b74; vertical-align:top;">Reason given</td><td style="padding:12px 0 4px; text-align:right;">${booking.cancellation_reason || "—"}</td></tr>
        </table>
      </div>
    </div>
  </div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from,
      to: ADMIN_NOTIFY_EMAIL,
      subject: `Booking ${bookingRef} cancelled by customer`,
      html,
    }),
  });
  return { sent: res.ok, status: res.status };
}
