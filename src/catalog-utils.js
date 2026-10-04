// Shared catalog-tree helpers, used both when a booking is first created
// (src/index.js) and when reconstructing what was booked later from the
// stored service_id (src/cancel.js's self-service cancellation page, which
// needs the full "Zuhause › Category › ..." breadcrumb, not just the leaf
// name the bookings table stores in service_name).

export const AUDIENCE_LABELS = {
  home: { de: "Zuhause", en: "Home" },
  business: { de: "Unternehmen", en: "Business" },
};

// Walk a category's decision tree following a list of chosen option ids,
// returning the resolved leaf plus the breadcrumb of option labels chosen
// along the way.
export function resolveLeaf(catalog, audience, categoryId, path) {
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

// Full selection breadcrumb: audience, category, then each tree choice - in
// the same shape the frontend summary card and PDF/email show.
export function fullBreadcrumb(resolved, audience, lang) {
  const parts = [AUDIENCE_LABELS[audience]?.[lang] || AUDIENCE_LABELS[audience]?.de || audience];
  if (resolved.category?.name) parts.push(resolved.category.name[lang] || resolved.category.name.de);
  for (const b of resolved.breadcrumb) parts.push(b[lang] || b.de);
  return parts;
}

export function localizedBreadcrumbName(resolved, lang) {
  if (resolved.leaf.name) return resolved.leaf.name[lang] || resolved.leaf.name.de;
  return resolved.breadcrumb.map((b) => b[lang] || b.de).join(" – ");
}

// A booking's stored service_id is "<audience>:<categoryId>:<choice1>:<choice2>...".
// Re-resolves it against the current catalog to recover the full breadcrumb
// for display later (the bookings table only stores the leaf's service_name).
// Returns null if the id doesn't parse or no longer resolves (e.g. the
// catalog changed since the booking was made) — callers should fall back to
// the stored leaf service_name in that case.
// Flattens the whole catalog tree into a list of bookable leaves, each with
// the serviceId string a booking would store and its full breadcrumb in
// both languages -- used by the admin "create a manual order" form's
// service picker, which needs every leaf as flat options rather than the
// public site's step-by-step tree walk.
export function listCatalogLeaves(catalog) {
  const leaves = [];
  for (const audience of Object.keys(catalog)) {
    for (const category of catalog[audience] || []) {
      const walk = (node, path, crumbDe, crumbEn) => {
        if (!node) return;
        if (node.type === "leaf") {
          // Matches fullBreadcrumb()'s shape exactly: audience + category +
          // each chosen option's name along the path -- the same breadcrumb
          // the rest of the app (admin dashboard, cancel page) shows for a
          // booking made against this leaf.
          leaves.push({
            serviceId: `${audience}:${category.id}:${path.join(":")}`,
            breadcrumbDe: [AUDIENCE_LABELS[audience]?.de || audience, category.name?.de, ...crumbDe].filter(Boolean),
            breadcrumbEn: [AUDIENCE_LABELS[audience]?.en || audience, category.name?.en || category.name?.de, ...crumbEn].filter(Boolean),
            quote: !!node.quote,
            quoteKind: node.quoteKind || null,
            price: node.quote ? null : node.price,
            duration: node.duration,
          });
          return;
        }
        if (node.type === "branch") {
          for (const option of node.options || []) {
            walk(option.next, [...path, option.id], [...crumbDe, option.name?.de], [...crumbEn, option.name?.en || option.name?.de]);
          }
        }
      };
      walk(category.root, [], [], []);
    }
  }
  return leaves;
}

export function breadcrumbFromServiceId(catalog, serviceId, lang) {
  if (!serviceId || typeof serviceId !== "string") return null;
  const [audience, categoryId, ...path] = serviceId.split(":");
  if (!audience || !categoryId) return null;
  const resolved = resolveLeaf(catalog, audience, categoryId, path);
  if (!resolved) return null;
  return fullBreadcrumb(resolved, audience, lang);
}
