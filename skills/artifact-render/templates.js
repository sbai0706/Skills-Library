import { renderFirstMeetingBrief } from "./first-meeting-brief.js";

/**
 * Minimal template registry. It exists so future templates can be added
 * without building a general document framework. Unknown templates never fall
 * back to a default.
 */
export const TEMPLATES = Object.freeze({
  "first-meeting-brief-v1": Object.freeze({
    id: "first-meeting-brief-v1",
    render: renderFirstMeetingBrief,
  }),
});

export function renderTemplate(templateId, structuredInput, context = {}) {
  const template = TEMPLATES[templateId];
  if (!template) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: `Unknown output template "${templateId}".`,
        retryable: false,
        details: {
          template_id: templateId,
          supported_templates: Object.keys(TEMPLATES).sort(),
        },
      },
    };
  }

  return { ok: true, value: template.render(structuredInput, context) };
}
