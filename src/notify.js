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
    const breadcrumb = breadcrumbFromServiceId(catalog, booking.service_id, lang) || [booking.service_name];
    const pdfBytes = generateBookingPdf({
      bookingRef,
      customerName: booking.customer_name,
      customerEmail: booking.customer_email,
      customerAddress: booking.customer_address,
      breadcrumb,
      date: booking.date,
      dateDisplay,
      time: booking.time,
      duration: booking.duration_minutes,
      priceText,
      lang,
      cancelled: true,
      cancelledBy,
      cancellationReason: booking.cancellation_reason,
    });
    attachments = [
      { filename: `zettly-${bookingRef}-cancelled.pdf`, content: toBase64(pdfBytes) },
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
