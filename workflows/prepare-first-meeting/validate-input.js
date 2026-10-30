import { EVIDENCE_SOURCE_IDS } from "../../adapters/evidence-adapter.js";
import { validate } from "../../schemas/index.js";
import { loadDefaultQuestions } from "./reference.js";

const AUDIENCES = ["internal_sales", "executive", "customer"];
const CLASSIFICATIONS = ["public", "internal", "confidential"];
const TEMPLATE_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/;
const QUESTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const TOP_LEVEL_KEYS = new Set([
  "account_reference",
  "questions",
  "requested_sources",
  "audience",
  "template_id",
  "classification_ceiling",
  "context",
]);

const CONTEXT_KEYS = new Set(["requested_by", "roles", "permitted_classifications"]);

/**
 * Validate workflow input and apply the documented deterministic defaults.
 * Nothing is repaired: an unknown field, source, audience, or classification is
 * reported as a structured input error.
 *
 * @param {unknown} input
 * @returns {{ok: true, value: object} | {ok: false, errors: object[]}}
 */
export function validateInput(input) {
  const errors = [];
  const fail = (code, message, details) =>
    errors.push({ code, message, retryable: false, ...(details ? { details } : {}) });

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("INVALID_INPUT", "Input must be an object.");
    return { ok: false, errors };
  }

  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      fail("INVALID_INPUT", `Unknown workflow input field "${key}".`);
    }
  }

  const accountReference =
    typeof input.account_reference === "string" ? input.account_reference.trim() : "";
  if (accountReference === "") {
    fail("INVALID_INPUT", "account_reference is required and must be a non-empty string.");
  }

  let questions;
  if (input.questions === undefined || input.questions === null) {
    try {
      questions = loadDefaultQuestions().questions;
    } catch {
      fail("INTERNAL_ERROR", "The first-meeting reference question set could not be loaded.");
    }
  } else if (!Array.isArray(input.questions) || input.questions.length === 0) {
    fail("INVALID_INPUT", "questions must be null or a non-empty array.");
  } else {
    questions = [];
    const seen = new Set();
    input.questions.forEach((question, index) => {
      if (typeof question !== "object" || question === null || Array.isArray(question)) {
        fail("INVALID_INPUT", `questions[${index}] must be an object.`);
        return;
      }
      for (const key of Object.keys(question)) {
        if (!["id", "text", "question"].includes(key)) {
          fail("INVALID_INPUT", `questions[${index}] has unknown field "${key}".`);
        }
      }
      const id = typeof question.id === "string" ? question.id.trim() : "";
      if (id === "" || !QUESTION_ID_PATTERN.test(id)) {
        fail("INVALID_INPUT", `questions[${index}].id must be a stable non-empty identifier.`);
        return;
      }
      if (seen.has(id)) {
        fail("INVALID_INPUT", `Duplicate question id "${id}".`, { question_id: id });
        return;
      }
      const textSource = question.text ?? question.question;
      const text = typeof textSource === "string" ? textSource.trim() : "";
      if (text === "") {
        fail("INVALID_INPUT", `questions[${index}].text is required for ${id}.`);
        return;
      }
      seen.add(id);
      questions.push({ id, text });
    });
  }

  let requestedSources;
  if (input.requested_sources === undefined) {
    requestedSources = ["crm", "public_source"];
  } else if (!Array.isArray(input.requested_sources) || input.requested_sources.length === 0) {
    fail("INVALID_INPUT", "requested_sources must be a non-empty array when provided.");
  } else {
    requestedSources = [];
    input.requested_sources.forEach((source, index) => {
      if (typeof source !== "string" || source.trim() === "") {
        fail("INVALID_INPUT", `requested_sources[${index}] must be a non-empty string.`);
        return;
      }
      const normalized = source.trim();
      if (!EVIDENCE_SOURCE_IDS.includes(normalized)) {
        fail("UNSUPPORTED_SOURCE", `Unknown source "${normalized}".`, {
          source: normalized,
          supported_sources: [...EVIDENCE_SOURCE_IDS],
        });
        return;
      }
      if (requestedSources.includes(normalized)) {
        fail("INVALID_INPUT", `Duplicate requested source "${normalized}".`, {
          source: normalized,
        });
        return;
      }
      requestedSources.push(normalized);
    });
  }

  const audience = input.audience ?? "internal_sales";
  if (!AUDIENCES.includes(audience)) {
    fail("INVALID_INPUT", `audience must be one of: ${AUDIENCES.join(", ")}.`);
  }

  const templateId = input.template_id ?? "first-meeting-brief-v1";
  if (typeof templateId !== "string" || !TEMPLATE_PATTERN.test(templateId)) {
    fail("INVALID_INPUT", "template_id must be a valid template identifier.");
  }

  const classificationCeiling = input.classification_ceiling ?? "internal";
  if (!CLASSIFICATIONS.includes(classificationCeiling)) {
    fail(
      "INVALID_INPUT",
      `classification_ceiling must be one of: ${CLASSIFICATIONS.join(", ")}.`,
    );
  }

  let context = {};
  if (input.context !== undefined) {
    if (
      typeof input.context !== "object" ||
      input.context === null ||
      Array.isArray(input.context)
    ) {
      fail("INVALID_INPUT", "context must be an object when provided.");
    } else {
      for (const key of Object.keys(input.context)) {
        if (!CONTEXT_KEYS.has(key)) {
          fail("INVALID_INPUT", `context contains unknown field "${key}".`);
        }
      }
      if (input.context.requested_by !== undefined) {
        if (
          typeof input.context.requested_by !== "string" ||
          input.context.requested_by.trim() === ""
        ) {
          fail("INVALID_INPUT", "context.requested_by must be a non-empty string when provided.");
        } else {
          context.requested_by = input.context.requested_by.trim();
        }
      }
      if (input.context.roles !== undefined) {
        if (
          !Array.isArray(input.context.roles) ||
          input.context.roles.some((role) => typeof role !== "string")
        ) {
          fail("INVALID_INPUT", "context.roles must be an array of strings when provided.");
        } else {
          context.roles = [...input.context.roles];
        }
      }
      if (input.context.permitted_classifications !== undefined) {
        const values = input.context.permitted_classifications;
        if (
          !Array.isArray(values) ||
          values.some((value) => !CLASSIFICATIONS.includes(value))
        ) {
          fail(
            "INVALID_INPUT",
            `context.permitted_classifications must be an array of: ${CLASSIFICATIONS.join(", ")}.`,
          );
        } else {
          context.permitted_classifications = [...values];
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const value = {
    account_reference: accountReference,
    questions,
    requested_sources: requestedSources,
    audience,
    template_id: templateId,
    classification_ceiling: classificationCeiling,
    context,
  };

  const { valid, errors: schemaErrors } = validate("workflowInput", value);
  if (!valid) {
    return {
      ok: false,
      errors: [
        {
          code: "INVALID_INPUT",
          message: "Workflow input does not validate against workflow-input.schema.json.",
          retryable: false,
          details: { problems: schemaErrors },
        },
      ],
    };
  }

  return { ok: true, value };
}
