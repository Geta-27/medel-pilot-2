const { upsertSlot, getSlot } = require("../data/scheduleSlots.cjs");
const { createOpportunity } = require("../data/opportunities.cjs");
const { getRules } = require("../data/providerRules.cjs");

function id(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2,9);
}

async function ingestSnapshot(providerId, slots) {
  const saved = [];
  for (const s of (slots || [])) {
    saved.push(await upsertSlot({ ...s, providerId }));
  }
  return saved;
}

async function ingestEvent(event) {
  const existing = await getSlot(event.slotId);

  const slot = await upsertSlot({
    slotId: event.slotId,
    providerId: event.providerId,
    startTime: event.startTime || existing?.startTime || null,
    endTime: event.endTime || existing?.endTime || null,
    status: existing?.status || "OPEN",
    specialty: existing?.specialty || event.specialty || null,
    insurance: existing?.insurance || event.insurance || null,
    language: existing?.language || event.language || null,
    location: existing?.location || event.location || null,
    heldByCareX: existing?.heldByCareX || false,
  });

  const rules = await getRules(event.providerId);

  if (event.eventType === "APPOINTMENT_CANCELLED" && rules.releaseCancelledSlotsImmediately) {
    await upsertSlot({ ...slot, status: "CANCELLED", heldByCareX: false });
    return createOpportunity({
      opportunityId: id("opp"),
      providerId: event.providerId,
      slotId: event.slotId,
      type: "cancellation",
      specialty: slot.specialty,
      insurance: slot.insurance,
      language: slot.language,
      location: slot.location,
    });
  }

  if (event.eventType === "NO_SHOW_CONFIRMED") {
    await upsertSlot({ ...slot, status: "NO_SHOW_CONFIRMED", heldByCareX: false });
    return createOpportunity({
      opportunityId: id("opp"),
      providerId: event.providerId,
      slotId: event.slotId,
      type: "no_show",
      specialty: slot.specialty,
      insurance: slot.insurance,
      language: slot.language,
      location: slot.location,
    });
  }

  return null;
}

module.exports = { ingestSnapshot, ingestEvent };
