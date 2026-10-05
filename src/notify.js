// Cancellation email, shared by the admin panel (src/admin.js) and the
// customer self-service cancellation page (src/cancel.js), so both send the
// exact same notice with the same PDF attached rather than drifting apart.

import catalog from "../catalog.json";
import { generateBookingPdf, generateInvoicePdf, toBase64, formatEUR } from "./pdf.js";
import { LOGO_PNG_BASE64 } from "./logo.js";
import { localizedDate } from "./utils.js";
import { breadcrumbFromServiceId, resolveLeaf } from "./catalog-utils.js";

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
    priceOnRequest: "Wird nach Diagnose vor Ort mitgeteilt",
    priceOnConsultation: "Wird nach einem kostenlosen Beratungsgespräch mitgeteilt",
    consultationModeLabel: "Beratungsart",
    consultationModeOnline: "Online (Videoanruf)",
    consultationModeInPerson: "Vor Ort",
    lateFeeNote: (fee, original) =>
      `Da die Stornierung weniger als 24 Stunden vor dem Termin erfolgte, fällt eine Stornierungsgebühr von <strong>€${fee}</strong> an (ursprünglicher Preis: €${original}). Details dazu finden Sie im angehängten PDF.`,
    travelFeeNote: (fee) =>
      `Die bereits berechnete Anfahrtspauschale von <strong>€${fee}</strong> wird in diesem Fall nicht erstattet.`,
    noShowNote: "Dieser Termin wurde als Nichterscheinen (No-Show) vor Ort erfasst.",
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
    priceOnRequest: "Quoted after on-site diagnosis",
    priceOnConsultation: "Quoted after a free consultation",
    consultationModeLabel: "Consultation mode",
    consultationModeOnline: "Online (video call)",
    consultationModeInPerson: "In person",
    lateFeeNote: (fee, original) =>
      `Since this was cancelled less than 24 hours before the appointment, a cancellation fee of <strong>€${fee}</strong> applies (original price: €${original}). See the attached PDF for details.`,
    travelFeeNote: (fee) =>
      `The travel fee of <strong>€${fee}</strong> already assessed for this booking is not refunded in this case.`,
    noShowNote: "This appointment was recorded as a no-show at the booking address.",
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
  // Re-resolve the leaf this booking was made against so the cancelled-PDF
  // wording distinguishes a Fix/repair diagnosis quote from a business
  // consultation quote, same as the live booking flow does.
  const [svcAudience, svcCategoryId, ...svcPath] = (booking.service_id || "").split(":");
  const resolvedLeaf = svcAudience && svcCategoryId ? resolveLeaf(catalog, svcAudience, svcCategoryId, svcPath)?.leaf : null;
  const isConsultation = resolvedLeaf?.quoteKind === "consultation";
  const priceTextFor = (tt) => (booking.price ? `€${booking.price}` : (isConsultation ? tt.priceOnConsultation : tt.priceOnRequest));
  const consultationModeTextFor = (tt) =>
    isConsultation ? (booking.online_consultation ? tt.consultationModeOnline : tt.consultationModeInPerson) : null;
  const priceText = priceTextFor(t);
  const consultationModeText = consultationModeTextFor(t);
  const quantity = booking.quantity || 1;
  const unitPrice = booking.price && quantity > 1 ? Math.round((booking.price / quantity) * 100) / 100 : null;
  // Set by the caller (src/cancel.js / src/admin.js) whenever this
  // cancellation happened inside the 24h window and the late fee was
  // actually charged -- `booking.price` is already the fee amount by the
  // time it reaches here, and pre_cancellation_price is the original.
  const lateFeeApplied = booking.pre_cancellation_price != null;
  const originalPrice = booking.pre_cancellation_price;
  // Set by the caller whenever this booking had a travel/commute fee that
  // was kept (charged) rather than waived -- cancellation less than 3 hours
  // before the appointment, or a no-show.
  const travelFeeKept = (booking.commute_fee || 0) > 0 && booking.pre_cancellation_commute_fee == null;
  const noShow = !!booking.no_show;

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
        ${consultationModeText ? `<p style="margin:0 0 14px;"><span style="display:inline-block; background:${booking.online_consultation ? "#e8f8ef" : "#f3eeff"}; color:${booking.online_consultation ? "#16a34a" : "#7C3AED"}; font-size:11.5px; font-weight:700; padding:4px 10px; border-radius:999px;">${t.consultationModeLabel}: ${consultationModeText}</span></p>` : ""}
        ${lateFeeApplied ? `<p style="margin:0 0 14px; padding:10px 12px; background:#fdeef2; border-left:3px solid #c2185b; border-radius:6px; font-size:13px; color:#111114; line-height:1.5;">${t.lateFeeNote(booking.price, originalPrice)}</p>` : ""}
        ${noShow ? `<p style="margin:0 0 14px; padding:10px 12px; background:#fdeef2; border-left:3px solid #c2185b; border-radius:6px; font-size:13px; color:#111114; line-height:1.5;">${t.noShowNote}</p>` : ""}
        ${travelFeeKept ? `<p style="margin:0 0 14px; padding:10px 12px; background:#fdeef2; border-left:3px solid #c2185b; border-radius:6px; font-size:13px; color:#111114; line-height:1.5;">${t.travelFeeNote(booking.commute_fee)}</p>` : ""}
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
      cancelled: true,
      cancelledBy,
      cancellationReason: booking.cancellation_reason,
      liabilityAcceptedAt: booking.liability_accepted_at,
      privacyAcceptedAt: booking.privacy_accepted_at,
      isConsultation,
      quantity,
      unitPrice,
      lateFeeApplied,
      lateFeeAmount: lateFeeApplied ? booking.price : 0,
      originalPrice,
      lateFeeWaived: !!booking.cancellation_fee_waived,
      noShow,
      travelFeeKept,
      travelFeeAmount: travelFeeKept ? booking.commute_fee : 0,
    };
    const pdfBytesDe = generateBookingPdf({
      ...basePdfData,
      breadcrumb: breadcrumbDe,
      date: booking.date,
      dateDisplay: dateDisplayDe,
      priceText: priceTextFor(STRINGS.de),
      consultationModeText: consultationModeTextFor(STRINGS.de),
      lang: "de",
    });
    const pdfBytesEn = generateBookingPdf({
      ...basePdfData,
      breadcrumb: breadcrumbEn,
      date: booking.date,
      dateDisplay: dateDisplayEn,
      priceText: priceTextFor(STRINGS.en),
      consultationModeText: consultationModeTextFor(STRINGS.en),
      lang: "en",
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
  const [svcAudience, svcCategoryId, ...svcPath] = (booking.service_id || "").split(":");
  const resolvedLeaf = svcAudience && svcCategoryId ? resolveLeaf(catalog, svcAudience, svcCategoryId, svcPath)?.leaf : null;
  const isConsultation = resolvedLeaf?.quoteKind === "consultation";
  const priceText = booking.price ? `€${booking.price}` : (isConsultation ? "Wird nach einem kostenlosen Beratungsgespräch mitgeteilt" : "Wird nach Diagnose vor Ort mitgeteilt");
  const consultationModeText = isConsultation ? (booking.online_consultation ? "Online (Videoanruf)" : "Vor Ort") : null;

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
          ${consultationModeText ? `<tr><td style="padding:4px 0; color:#6b6b74;">Consultation mode</td><td style="padding:4px 0; text-align:right; font-weight:700;">${consultationModeText}</td></tr>` : ""}
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

// ---- Invoice (sent manually from the admin panel, after payment) --------

// Deterministic invoice numbering: no persisted counter needed since the
// booking reference itself is already unique and stable, so `INV-<ref>`
// gives a stable, human-readable invoice number without any DB changes.
export function invoiceNumberFor(bookingRef) {
  return `INV-${bookingRef}`;
}

const INVOICE_STRINGS = {
  de: {
    heading: "Ihre Rechnung",
    hi: (name) => `Hallo ${name},`,
    body: (num) => `anbei erhalten Sie Ihre Rechnung <strong>${num}</strong> für die erbrachte Leistung.`,
    attachmentTitle: "Rechnung (DE & EN)",
    attachmentNote: "Zwei PDF-Anhänge: eine deutsche und eine englische Fassung.",
    signature: "Ihr Zettly-Team",
    subject: (num) => `Ihre Rechnung ${num}`,
  },
  en: {
    heading: "Your invoice",
    hi: (name) => `Hi ${name},`,
    body: (num) => `please find attached your invoice <strong>${num}</strong> for the service provided.`,
    attachmentTitle: "Invoice (DE & EN)",
    attachmentNote: "Two PDF attachments: a German and an English version.",
    signature: "The Zettly Team",
    subject: (num) => `Your invoice ${num}`,
  },
};

/**
 * Email the customer their invoice, with BOTH a German and an English PDF
 * attached (same "always send both languages" pattern as the booking
 * confirmation and cancellation emails), after the admin marks payment as
 * received. `booking` is a raw `bookings` table row.
 */
export async function sendInvoiceEmail(env, booking, lang = "de") {
  if (!env.RESEND_API_KEY) return { sent: false, reason: "no_api_key" };
  const t = INVOICE_STRINGS[lang] || INVOICE_STRINGS.de;
  const bookingRef = `ZTL-${booking.id.split("-")[0].toUpperCase()}`;
  const invoiceNumber = invoiceNumberFor(bookingRef);
  const from = env.RESEND_FROM || "Zettly <no-reply@zettly.de>";
  const commuteFee = booking.commute_fee || 0;
  const quantity = booking.quantity || 1;
  const unitPrice = booking.price && quantity > 1 ? Math.round((booking.price / quantity) * 100) / 100 : null;
  // The invoice always uses German-standard number formatting (comma
  // decimal separator, period thousands separator, trailing "€"), even on
  // the English invoice -- only the surrounding labels differ by language.
  // Both the DE and EN PDFs get their own fallback text when there is no
  // price yet, but the same (German-style) number formatting otherwise.
  const servicePriceTextDe = booking.price ? formatEUR(booking.price) : "Vor Ort mitgeteilt";
  const servicePriceTextEn = booking.price ? formatEUR(booking.price) : "Quoted on-site";
  const priceTextDe = booking.price ? formatEUR(booking.price + commuteFee) : servicePriceTextDe;
  const priceTextEn = booking.price ? formatEUR(booking.price + commuteFee) : servicePriceTextEn;
  const servicePriceText = lang === "en" ? servicePriceTextEn : servicePriceTextDe;
  const priceText = lang === "en" ? priceTextEn : priceTextDe;
  const paymentStatus = lang === "en" ? "Paid" : "Bezahlt";

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
        <div style="display:inline-block; margin-top:14px; background:#f3eeff; color:#7C3AED; font-size:12px; font-weight:700; padding:6px 12px; border-radius:999px;">${invoiceNumber}</div>
      </div>
      <div style="padding:26px 28px;">
        <p style="margin:0 0 14px; font-size:14px; font-weight:700; color:#111114;">${t.hi(booking.customer_name)}</p>
        <p style="margin:0 0 22px; font-size:13.5px; color:#6b6b74; line-height:1.5;">${t.body(invoiceNumber)}</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse; background:#f8f7fb; border:1px solid #e9e7ef; border-radius:12px;">
          <tr>
            <td style="padding:16px 18px; vertical-align:middle; width:44px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="36" height="36" style="width:36px; height:36px; background:#efe8ff; border-radius:9px;">
                <tr><td align="center" valign="middle" style="width:36px; height:36px; font-size:16px; font-weight:800; color:#7C3AED; font-family:'Helvetica Neue', Arial, sans-serif;">PDF</td></tr>
              </table>
            </td>
            <td style="padding:16px 18px 16px 0; vertical-align:middle;">
              <div style="font-size:13.5px; font-weight:700; color:#111114; margin-bottom:2px;">${t.attachmentTitle}</div>
              <div style="font-size:12.5px; color:#6b6b74;">${t.attachmentNote}</div>
            </td>
          </tr>
        </table>
        <p style="margin:22px 0 0; font-size:13px; font-weight:700; color:#111114;">${t.signature}</p>
      </div>
    </div>
  </div>`;

  let attachments;
  try {
    const breadcrumbDe = breadcrumbFromServiceId(catalog, booking.service_id, "de") || [booking.service_name];
    const breadcrumbEn = breadcrumbFromServiceId(catalog, booking.service_id, "en") || [booking.service_name];
    const invoiceDateDe = localizedDate(new Date().toISOString().slice(0, 10), "de");
    const invoiceDateEn = localizedDate(new Date().toISOString().slice(0, 10), "en");
    const dateDisplayDe = localizedDate(booking.date, "de");
    const dateDisplayEn = localizedDate(booking.date, "en");
    const baseData = {
      invoiceNumber,
      bookingRef,
      customerName: booking.customer_name,
      customerEmail: booking.customer_email,
      customerAddress: booking.customer_address,
      time: booking.time,
      commuteFee,
      quantity,
      unitPrice,
    };
    const pdfBytesDe = generateInvoicePdf({
      ...baseData, servicePriceText: servicePriceTextDe, priceText: priceTextDe, breadcrumb: breadcrumbDe, dateDisplay: dateDisplayDe, invoiceDate: invoiceDateDe, paymentStatus: "Bezahlt", lang: "de",
    });
    const pdfBytesEn = generateInvoicePdf({
      ...baseData, servicePriceText: servicePriceTextEn, priceText: priceTextEn, breadcrumb: breadcrumbEn, dateDisplay: dateDisplayEn, invoiceDate: invoiceDateEn, paymentStatus: "Paid", lang: "en",
    });
    attachments = [
      { filename: `zettly-rechnung-${invoiceNumber}-de.pdf`, content: toBase64(pdfBytesDe) },
      { filename: `zettly-invoice-${invoiceNumber}-en.pdf`, content: toBase64(pdfBytesEn) },
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
      subject: t.subject(invoiceNumber),
      html,
      ...(attachments ? { attachments } : {}),
    }),
  });
  return { sent: res.ok, status: res.status };
}

// ---- Payment link (dummy placeholder, until a real payment gateway is
// integrated) --------------------------------------------------------------

const PAYMENT_LINK_STRINGS = {
  de: {
    heading: "Zahlungslink",
    hi: (name) => `Hallo ${name},`,
    body: "bitte begleichen Sie Ihre Buchung über den folgenden Zahlungslink:",
    buttonLabel: "Jetzt bezahlen",
    note: "Hinweis: Dies ist derzeit ein Platzhalter-Link, da die Anbindung an einen Zahlungsanbieter noch aussteht.",
    signature: "Ihr Zettly-Team",
    subject: (ref) => `Zahlungslink für Buchung ${ref}`,
  },
  en: {
    heading: "Payment link",
    hi: (name) => `Hi ${name},`,
    body: "please settle your booking using the payment link below:",
    buttonLabel: "Pay now",
    note: "Note: this is currently a placeholder link, since integration with a real payment gateway is still pending.",
    signature: "The Zettly Team",
    subject: (ref) => `Payment link for booking ${ref}`,
  },
};

// A real payment gateway integration is awaited/pending -- this generates an
// explicit DUMMY placeholder link only, never a real payable URL, so it's
// obviously a stand-in rather than something that could be mistaken for a
// working checkout.
export function dummyPaymentLinkFor(bookingRef) {
  return `https://pay.zettly.de/dummy/${encodeURIComponent(bookingRef)}`;
}

/**
 * Email the customer a placeholder payment link. Dummy/for-now only, per the
 * real payment gateway integration still being pending -- see
 * dummyPaymentLinkFor(). `booking` is a raw `bookings` table row.
 */
// overrideEmail lets an admin send the payment link to a different address
// than the one on the booking -- e.g. the customer who made the booking
// doesn't have access to that inbox and asked for it to go elsewhere
// instead.
export async function sendPaymentLinkEmail(env, booking, lang = "de", overrideEmail = null) {
  if (!env.RESEND_API_KEY) return { sent: false, reason: "no_api_key" };
  const t = PAYMENT_LINK_STRINGS[lang] || PAYMENT_LINK_STRINGS.de;
  const bookingRef = `ZTL-${booking.id.split("-")[0].toUpperCase()}`;
  const from = env.RESEND_FROM || "Zettly <no-reply@zettly.de>";
  const paymentLink = dummyPaymentLinkFor(bookingRef);

  const html = `
  <div style="font-family: 'Segoe UI', Arial, sans-serif; background:#f4f2fa; padding:32px 16px;">
    <div style="max-width:480px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; border:1px solid #e9e7ef;">
      <div style="background:#ffffff; padding:24px 28px 18px; border-bottom:1px solid #e9e7ef;">
        <div style="font-family:'Helvetica Neue', Arial, sans-serif; font-size:21px; font-weight:200; letter-spacing:0.01em;"><span style="color:#111114;">zett</span><span style="color:#7C3AED;">ly</span></div>
        <div style="color:#6b6b74; font-size:13px; margin-top:8px;">${t.heading}</div>
      </div>
      <div style="padding:26px 28px;">
        <p style="margin:0 0 14px; font-size:14px; font-weight:700; color:#111114;">${t.hi(booking.customer_name)}</p>
        <p style="margin:0 0 20px; font-size:13.5px; color:#6b6b74; line-height:1.5;">${t.body}</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:18px;">
          <tr>
            <td style="border-radius:8px; background:#7C3AED;">
              <a href="${paymentLink}" style="display:inline-block; padding:11px 22px; font-family:'Helvetica Neue', Arial, sans-serif; font-size:13px; font-weight:700; color:#ffffff; text-decoration:none; border-radius:8px;">${t.buttonLabel}</a>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 18px; font-size:11.5px; color:#8a8a92; line-height:1.5;">${t.note}</p>
        <p style="margin:0; font-size:13px; font-weight:700; color:#111114;">${t.signature}</p>
      </div>
    </div>
  </div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from,
      to: overrideEmail || booking.customer_email,
      subject: t.subject(bookingRef),
      html,
    }),
  });
  return { sent: res.ok, status: res.status, paymentLink };
}
