import services from "../../services.json";

const ALL_SERVICES = [...services.it, ...services.dynamics];

function findService(id) {
  return ALL_SERVICES.find((s) => s.id === id);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sendConfirmationEmail(env, booking, service) {
  if (!env.RESEND_API_KEY) {
    console.log("RESEND_API_KEY not set - skipping email send", booking.id);
    return { sent: false, reason: "no_api_key" };
  }

  const from = env.RESEND_FROM || "Zettly <onboarding@resend.dev>";

  const html = `
    <div style="font-family: Arial, sans-serif; color: #111;">
      <h2>Your appointment is confirmed 🎉</h2>
      <p>Hi ${booking.customer_name},</p>
      <p>Here are your booking details:</p>
      <table style="border-collapse: collapse;">
        <tr><td style="padding:4px 12px 4px 0;"><b>Service</b></td><td>${service.name}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><b>Date</b></td><td>${booking.date}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><b>Time</b></td><td>${booking.time}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><b>Duration</b></td><td>${service.duration} min</td></tr>
        <tr><td style="padding:4px 12px 4px 0;"><b>Price</b></td><td>€${service.price}</td></tr>
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

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const { serviceId, date, time, name, email, phone, notes } = body;

  if (!serviceId || !date || !time || !name || !email) {
    return new Response(JSON.stringify({ error: "Missing required fields" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const service = findService(serviceId);
  if (!service) {
    return new Response(JSON.stringify({ error: "Unknown service" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (!isValidEmail(email)) {
    return new Response(JSON.stringify({ error: "Invalid email" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (!env.DB) {
    return new Response(
      JSON.stringify({ error: "Booking database not configured yet" }),
      { status: 503, headers: { "content-type": "application/json" } }
    );
  }

  // Re-check the slot is still free (avoid double-booking race)
  const { results: conflicts } = await env.DB.prepare(
    `SELECT time, duration_minutes FROM bookings WHERE date = ? AND status = 'confirmed'`
  )
    .bind(date)
    .all();

  const toMin = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };
  const start = toMin(time);
  const end = start + service.duration;
  const clash = conflicts.some((b) => {
    const bStart = toMin(b.time);
    const bEnd = bStart + b.duration_minutes;
    return start < bEnd && end > bStart;
  });

  if (clash) {
    return new Response(JSON.stringify({ error: "Slot just got booked, please pick another" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
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

  return new Response(
    JSON.stringify({
      id,
      service: service.name,
      date,
      time,
      price: service.price,
      emailSent: emailResult.sent,
    }),
    { headers: { "content-type": "application/json" } }
  );
}
