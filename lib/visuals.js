const { escapeHtml } = require("./markdown-renderer.js");

const SLUG = /^[a-z][a-z0-9-]{0,47}$/;
const HASH = /^[a-f0-9]{64}$/;
const TONES = new Set(["neutral", "active", "success", "warning", "error"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// All visual text is single-line plain text; limits count Unicode code points, as PostgreSQL does.
const UNSAFE_TEXT = /<\/?[a-z][^>]*>|(?:https?:\/\/|javascript\s*:|data\s*:|www\.)|```|\p{Cc}/iu;

function validateVisuals(visuals) {
  const errors = [];
  if (visuals === undefined) return errors;
  function shape(value, fields, location) {
    if (!object(value)) { errors.push(`${location} must be an object`); return false; }
    if (Object.keys(value).some((key) => !fields.includes(key))) errors.push(`${location} contains unknown fields`);
    return true;
  }
  function text(value, max, location, optional = false) {
    if (optional && value === undefined) return;
    if (typeof value !== "string" || (!optional && !value.trim()) || [...value].length > max || UNSAFE_TEXT.test(value)) {
      errors.push(`${location} must be plain text of at most ${max} characters`);
    }
  }
  function slug(value, location) {
    if (typeof value !== "string" || !SLUG.test(value)) errors.push(`${location} must be a short ASCII slug`);
  }
  function array(value, min, max, location, optional = false) {
    if (optional && value === undefined) return [];
    if (!Array.isArray(value) || value.length < min || value.length > max) {
      errors.push(`${location} must contain ${min}..${max} items`);
      return [];
    }
    return value;
  }
  function unique(items, location) {
    const ids = items.filter(object).map((item) => item.id);
    if (new Set(ids).size !== ids.length) errors.push(`${location} ids must be unique`);
  }
  const items = array(visuals, 0, 3, "visuals");
  unique(items, "visuals");
  items.forEach((visual, vi) => {
    const p = `visuals[${vi}]`;
    if (!shape(visual, ["version", "id", "title", "description", "alt", "emailAssetId", "emailScenarioId", "emailStep", "scenarios"], p)) return;
    if (visual.version !== 1) errors.push(`${p}.version must be 1`);
    slug(visual.id, `${p}.id`);
    text(visual.title, 120, `${p}.title`);
    text(visual.description, 1200, `${p}.description`);
    text(visual.alt, 1200, `${p}.alt`);
    if (typeof visual.emailAssetId !== "string" || !HASH.test(visual.emailAssetId)) errors.push(`${p}.emailAssetId must be a lowercase SHA256`);
    slug(visual.emailScenarioId, `${p}.emailScenarioId`);
    const scenarios = array(visual.scenarios, 1, 8, `${p}.scenarios`);
    unique(scenarios, `${p}.scenarios`);
    scenarios.forEach((scenario, si) => {
      const s = `${p}.scenarios[${si}]`;
      if (!shape(scenario, ["id", "label", "steps"], s)) return;
      slug(scenario.id, `${s}.id`);
      text(scenario.label, 120, `${s}.label`);
      array(scenario.steps, 1, 12, `${s}.steps`).forEach((step, ti) => {
        const t = `${s}.steps[${ti}]`;
        if (!shape(step, ["title", "description", "nodes", "edges", "metrics"], t)) return;
        text(step.title, 120, `${t}.title`);
        text(step.description, 1200, `${t}.description`);
        const nodes = array(step.nodes, 1, 12, `${t}.nodes`);
        unique(nodes, `${t}.nodes`);
        nodes.forEach((node, ni) => {
          const n = `${t}.nodes[${ni}]`;
          if (!shape(node, ["id", "label", "detail", "tone"], n)) return;
          slug(node.id, `${n}.id`);
          text(node.label, 120, `${n}.label`);
          text(node.detail, 600, `${n}.detail`, true);
          if (!TONES.has(node.tone)) errors.push(`${n}.tone is not allowed`);
        });
        array(step.edges, 0, 24, `${t}.edges`, true).forEach((edge, ei) => {
          const e = `${t}.edges[${ei}]`;
          if (!shape(edge, ["from", "to", "label"], e)) return;
          for (const field of ["from", "to"]) {
            slug(edge[field], `${e}.${field}`);
            if (!nodes.some((node) => object(node) && node.id === edge[field])) errors.push(`${e}.${field} must reference a node`);
          }
          text(edge.label, 160, `${e}.label`);
        });
        array(step.metrics, 0, 6, `${t}.metrics`, true).forEach((metric, mi) => {
          const m = `${t}.metrics[${mi}]`;
          if (!shape(metric, ["label", "value"], m)) return;
          text(metric.label, 120, `${m}.label`);
          text(metric.value, 120, `${m}.value`);
        });
      });
    });
    const selected = scenarios.find((scenario) => object(scenario) && scenario.id === visual.emailScenarioId);
    if (!selected) errors.push(`${p}.emailScenarioId must reference a scenario`);
    if (!Number.isInteger(visual.emailStep) || visual.emailStep < 0 || !Array.isArray(selected?.steps) || visual.emailStep >= selected.steps.length) {
      errors.push(`${p}.emailStep must reference a step`);
    }
  });
  return errors;
}

function renderVisualFrameHtml(step) {
  const nodes = step.nodes.map((node) => `<div class="visual-node" data-node-id="${escapeHtml(node.id)}" data-tone="${TONES.has(node.tone) ? node.tone : "neutral"}"><strong>${escapeHtml(node.label)}</strong>${node.detail ? `<p>${escapeHtml(node.detail)}</p>` : ""}</div>`).join("");
  const edges = (step.edges ?? []).map((edge) => {
    const from = step.nodes.find((node) => node.id === edge.from)?.label ?? edge.from;
    const to = step.nodes.find((node) => node.id === edge.to)?.label ?? edge.to;
    return `<li><span class="visual-edge-from">${escapeHtml(from)}</span><span class="visual-arrow" aria-label="에서 다음으로"> → </span><span class="visual-edge-to">${escapeHtml(to)}</span><span class="visual-edge-label">${escapeHtml(edge.label)}</span></li>`;
  }).join("");
  const metrics = (step.metrics ?? []).map((metric) => `<div><dt>${escapeHtml(metric.label)}</dt><dd>${escapeHtml(metric.value)}</dd></div>`).join("");
  return `<div class="visual-step"><h3>${escapeHtml(step.title)}</h3><p>${escapeHtml(step.description)}</p></div><div class="visual-nodes">${nodes}</div>${edges ? `<ul class="visual-edges" aria-label="연결 방향">${edges}</ul>` : ""}${metrics ? `<dl class="visual-metrics">${metrics}</dl>` : ""}`;
}

function renderVisualsHtml(visuals, options = {}) {
  const errors = validateVisuals(visuals);
  if (errors.length) throw new Error(`Invalid visuals: ${errors.join("; ")}`);
  return (visuals ?? []).map((visual) => {
    const caption = `<figcaption><h2 class="visual-title">${escapeHtml(visual.title)}</h2><p class="visual-description">${escapeHtml(visual.description)}</p></figcaption>`;
    if (options.email) {
      return `<figure class="lesson-visual" style="margin:24px 0">${caption}<img src="cid:visual-${visual.emailAssetId}" alt="${escapeHtml(visual.alt)}" width="720" style="display:block;width:100%;max-width:720px;height:auto;border:0"><p>${escapeHtml(visual.alt)}</p></figure>`;
    }
    return `<figure class="lesson-visual" data-visual-id="${visual.id}">${caption}<div data-visual-frame>${renderVisualFrameHtml(visual.scenarios[0].steps[0])}</div><p class="visual-alt">${escapeHtml(visual.alt)}</p></figure>`;
  }).join("");
}

module.exports = { validateVisuals, renderVisualFrameHtml, renderVisualsHtml };
