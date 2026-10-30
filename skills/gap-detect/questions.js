function claimCoversAspect(claim, aspect) {
  const sourceTypeMatch =
    aspect.source_types.length > 0 && aspect.source_types.includes(claim.source_type);
  const claimIdMatch =
    aspect.claim_ids.length > 0 && aspect.claim_ids.includes(claim.claim_id);
  return sourceTypeMatch || claimIdMatch;
}

export function classifyQuestions(questions, acceptedClaims, conflicts) {
  const claimsByQuestion = new Map(questions.map((question) => [question.id, []]));

  for (const claim of acceptedClaims.values()) {
    for (const questionId of claim.question_ids ?? []) {
      claimsByQuestion.get(questionId)?.push(claim);
    }
  }

  return questions.map((question) => {
    const relevantClaims = claimsByQuestion.get(question.id) ?? [];
    const relevantIds = new Set(relevantClaims.map((claim) => claim.claim_id));
    const applicableConflicts = conflicts.filter((conflict) =>
      conflict.claim_ids.some((claimId) => relevantIds.has(claimId)),
    );

    if (applicableConflicts.length > 0) {
      const supportingIds = new Set(relevantIds);
      for (const conflict of applicableConflicts) {
        for (const claimId of conflict.claim_ids) supportingIds.add(claimId);
      }
      return {
        question_id: question.id,
        status: "conflicted",
        supporting_evidence_ids: [...supportingIds].sort(),
        reason_codes: ["conflicting_claims"],
        conflict_ids: applicableConflicts
          .map((conflict) => conflict.conflict_id)
          .sort(),
      };
    }

    if (relevantClaims.length === 0) {
      return {
        question_id: question.id,
        status: "unanswered",
        supporting_evidence_ids: [],
        missing_evidence_description: "No supporting claims were provided.",
        reason_codes: ["no_supporting_claims"],
      };
    }

    const unsupportedAspects = (question.required_aspects ?? []).filter(
      (aspect) => !relevantClaims.some((claim) => claimCoversAspect(claim, aspect)),
    );

    if (unsupportedAspects.length > 0) {
      return {
        question_id: question.id,
        status: "partial",
        supporting_evidence_ids: [...relevantIds].sort(),
        missing_evidence_description:
          "Some aspects of this question lack supporting claims.",
        reason_codes: ["partial_support"],
      };
    }

    return {
      question_id: question.id,
      status: "answered",
      supporting_evidence_ids: [...relevantIds].sort(),
      reason_codes: [],
    };
  });
}
