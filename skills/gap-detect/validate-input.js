import { loadReferenceQuestionSet } from "./reference.js";

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const DOMAIN_SHAPE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
const QUESTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

const SOURCE_TYPES = new Set([
  "crm_record",
  "crm_activity",
  "company_site",
  "news",
  "third_party",
  "internal_document",
]);

function normalizeAspects(rawAspects, questionId, questionIndex, fail) {
  if (rawAspects === undefined) return { ok: true, value: [] };
  if (!Array.isArray(rawAspects)) {
    fail(`questions[${questionIndex}].required_aspects must be an array when provided.`, {
      question_id: questionId,
    });
    return { ok: false };
  }

  const seen = new Set();
  const aspects = [];

  rawAspects.forEach((raw, aspectIndex) => {
    let aspectId = "";
    let sourceTypes = null;
    let claimIds = null;

    if (typeof raw === "string") {
      aspectId = raw.trim();
      sourceTypes = [aspectId];
    } else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const candidateId = raw.id ?? raw.aspect_id;
      aspectId = typeof candidateId === "string" ? candidateId.trim() : "";
      if (raw.source_types !== undefined) {
        sourceTypes = raw.source_types;
      } else if (raw.source_type !== undefined) {
        sourceTypes = [raw.source_type];
      }
      if (raw.claim_ids !== undefined) claimIds = raw.claim_ids;
    } else {
      fail(`questions[${questionIndex}].required_aspects[${aspectIndex}] must be an object or string.`, {
        question_id: questionId,
      });
      return;
    }

    if (aspectId === "" || !QUESTION_ID_PATTERN.test(aspectId)) {
      fail(`questions[${questionIndex}].required_aspects[${aspectIndex}] needs a stable aspect ID.`, {
        question_id: questionId,
      });
      return;
    }
    if (seen.has(aspectId)) {
      fail(`questions[${questionIndex}] has duplicate aspect ID "${aspectId}".`, {
        question_id: questionId,
        aspect_id: aspectId,
      });
      return;
    }
    seen.add(aspectId);

    if (sourceTypes !== null) {
      if (
        !Array.isArray(sourceTypes) ||
        sourceTypes.length === 0 ||
        sourceTypes.some((value) => typeof value !== "string" || !SOURCE_TYPES.has(value))
      ) {
        fail(
          `questions[${questionIndex}].required_aspects[${aspectIndex}].source_types must contain at least one known evidence source type.`,
          { question_id: questionId, aspect_id: aspectId },
        );
        return;
      }
      sourceTypes = [...new Set(sourceTypes)];
    }

    if (claimIds !== null) {
      if (
        !Array.isArray(claimIds) ||
        claimIds.length === 0 ||
        claimIds.some((value) => typeof value !== "string" || !/^clm_[A-Za-z0-9_-]+$/.test(value))
      ) {
        fail(
          `questions[${questionIndex}].required_aspects[${aspectIndex}].claim_ids must contain at least one evidence ID.`,
          { question_id: questionId, aspect_id: aspectId },
        );
        return;
      }
      claimIds = [...new Set(claimIds)];
    }

    if (sourceTypes === null && claimIds === null) {
      fail(
        `questions[${questionIndex}].required_aspects[${aspectIndex}] must declare source_types or claim_ids.`,
        { question_id: questionId, aspect_id: aspectId },
      );
      return;
    }

    aspects.push({
      id: aspectId,
      source_types: sourceTypes ?? [],
      claim_ids: claimIds ?? [],
    });
  });

  return { ok: true, value: aspects };
}

function normalizeQuestions(rawQuestions, reference, fail) {
  const source = rawQuestions === undefined ? reference.questions : rawQuestions;
  if (!Array.isArray(source)) {
    fail("questions must be an array when provided.");
    return [];
  }

  const seen = new Set();
  const questions = [];

  source.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail(`questions[${index}] must be an object.`);
      return;
    }

    const candidateId = raw.id ?? raw.question_id;
    const id = typeof candidateId === "string" ? candidateId.trim() : "";
    if (id === "" || !QUESTION_ID_PATTERN.test(id)) {
      fail(`questions[${index}].id must be a stable non-empty identifier.`);
      return;
    }
    if (seen.has(id)) {
      fail(`Duplicate question id "${id}".`, { question_id: id });
      return;
    }
    seen.add(id);

    const aspects = normalizeAspects(raw.required_aspects, id, index, fail);
    if (!aspects.ok) return;

    questions.push({
      id,
      required: raw.required === true,
      required_aspects: aspects.value,
    });
  });

  return questions;
}

export function validateInput(input) {
  const errors = [];
  const fail = (message, details) =>
    errors.push({
      code: "INVALID_INPUT",
      message,
      retryable: false,
      ...(details ? { details } : {}),
    });

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("Input must be an object.");
    return { ok: false, errors };
  }

  const rawAccountId = input.account_id;
  let accountId = "";
  if (typeof rawAccountId !== "string" || rawAccountId.trim() === "") {
    fail("account_id is required and must be a non-empty string.");
  } else {
    accountId = rawAccountId.trim();
    if (/\s/.test(accountId)) {
      fail(
        "account_id must be a resolved account identifier, not an account name; resolve the account first.",
        { provided: accountId },
      );
    } else if (DOMAIN_SHAPE.test(accountId)) {
      fail(
        "account_id looks like a domain reference, not a resolved account identifier; resolve the account first.",
        { provided: accountId },
      );
    } else if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      fail("account_id does not match the accepted identifier format.", { provided: accountId });
    }
  }

  let reference;
  try {
    reference = loadReferenceQuestionSet();
  } catch {
    errors.push({
      code: "INTERNAL_ERROR",
      message: "The first-meeting reference question set could not be loaded.",
      retryable: false,
    });
    return { ok: false, errors };
  }

  const questions = normalizeQuestions(input.questions, reference, fail);

  if (!Array.isArray(input.claims)) {
    fail("claims is required and must be an array.");
  }

  if (input.conflicts !== undefined && !Array.isArray(input.conflicts)) {
    fail("conflicts must be an array when provided.");
  }

  let questionSetVersion = input.question_set_version ?? reference.version;
  if (typeof questionSetVersion !== "string" || !SEMVER.test(questionSetVersion)) {
    fail("question_set_version must be a semantic version such as 0.1.0.");
  } else {
    questionSetVersion = questionSetVersion.trim();
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      account_id: accountId,
      questions,
      claims: input.claims,
      conflicts: input.conflicts ?? [],
      question_set_version: questionSetVersion,
    },
  };
}
