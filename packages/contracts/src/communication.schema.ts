import { z } from 'zod';

// Stage 5 — hospital-initiated communication/request to the payer.
// Outbound traffic is logged in integration_message as usual; the
// case-detail timeline reads claim_event rows of type
// `communication.outbound_sent` / `communication.inbound_received`.
//
// Use cases this enables:
//   * T2-6 pre-auth approved less than requested — hospital asks
//     the payer to clarify the deduction or counter-submit.
//   * T2-10 pending enhancement at discharge — hospital tells the
//     payer "patient released, enhancement filed deferred" so
//     adjudication doesn't stall on the IRDAI 3-hour rule.
//   * T3-3 partial approval with vague reason — operator (or an
//     auto-rule) raises a Communication query for line-item breakup.
//
// Free-form `text` is the message body. `inReplyToCorrelationId`
// optionally threads a follow-up onto an earlier inbound (e.g. the
// payer asked a question, we send a clarification *before* the
// query is formally responded). It is NOT the same as
// preauth.query.respond — query response is a state-transitioning
// gesture; this is purely a messaging layer.

export const SendCommunicationRequestSchema = z.object({
  text: z
    .string()
    .min(1, 'Message text is required.')
    .max(5000, 'Message text must be 5000 characters or fewer.'),
  inReplyToCorrelationId: z.string().uuid().optional(),
});
export type SendCommunicationRequest = z.infer<typeof SendCommunicationRequestSchema>;

export const SendCommunicationResponseSchema = z.object({
  correlationId: z.string(),
  sentAt: z.string().datetime(),
});
export type SendCommunicationResponse = z.infer<typeof SendCommunicationResponseSchema>;

// One entry in the case-detail communications timeline. Direction
// flips for inbound vs. outbound; text is the parsed payload from
// the FHIR Communication.payload[0].contentString.
export const CommunicationEntrySchema = z.object({
  id: z.string().uuid(),
  direction: z.enum(['outbound', 'inbound']),
  text: z.string(),
  correlationId: z.string().nullable(),
  inReplyToCorrelationId: z.string().nullable(),
  occurredAt: z.string().datetime(),
  recordedById: z.string().uuid().nullable(),
  // T1-5 — true when this outbound was parked by the replay queue
  // (transient gateway failure) and is awaiting re-issue. Lets the
  // UI distinguish "sent and acknowledged" from "sent and pending
  // gateway recovery". Always false for inbound entries.
  queued: z.boolean().default(false),
});
export type CommunicationEntry = z.infer<typeof CommunicationEntrySchema>;

export const ListCommunicationsResponseSchema = z.object({
  entries: z.array(CommunicationEntrySchema),
});
export type ListCommunicationsResponse = z.infer<typeof ListCommunicationsResponseSchema>;
