import services from "../../services.json";

export async function onRequestGet() {
  return new Response(JSON.stringify(services), {
    headers: { "content-type": "application/json" },
  });
}
