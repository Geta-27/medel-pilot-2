function scoreRequest(request, providerId, slot, opportunity) {

  let score = 0;

  const providerSpecialty =
    opportunity.specialty || slot.specialty || "urgent_care";

  const providerInsurance =
    opportunity.insurance || slot.insurance || null;

  const providerLanguage =
    opportunity.language || slot.language || "English";

  const providerLocation =
    opportunity.location || slot.location || null;

  if (request.status !== "PENDING") return -1;

  if (request.assignedProviderId) return -1;

  if (request.bookingId) return -1;

  if (!request.specialty || request.specialty === providerSpecialty)
    score += 4;

  if (!providerInsurance ||
      !request.insurance ||
      request.insurance === providerInsurance)
    score += 3;

  if (!request.language ||
      request.language === providerLanguage)
    score += 2;

  if (!providerLocation ||
      !request.location ||
      request.location === providerLocation)
    score += 1;

  return score;
}

function pickBestRequest(requests, providerId, slot, opportunity) {

  const scored = requests
    .map(r => ({
      request: r,
      score: scoreRequest(r, providerId, slot, opportunity)
    }))
    .filter(x => x.score >= 0)
    .sort((a,b)=>b.score-a.score);

  return scored.length ? scored[0].request : null;
}

module.exports = {
  pickBestRequest,
  scoreRequest
};
