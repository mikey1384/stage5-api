import { getDatabase } from "./core";

export const STAGE5_PILOT_EXPERIMENT_TAG = "phantom_fund_experiment";
export const STAGE5_PILOT_OFFER_CODE = "creator_localization_25";

export async function recordPilotReservationCreated({
  checkoutSessionId,
  reservationId,
  source,
  locale,
}: {
  checkoutSessionId: string;
  reservationId: string;
  source: string;
  locale: string;
}): Promise<void> {
  const db = getDatabase();
  await db
    .prepare(
      `INSERT INTO stage5_pilot_reservations (
         checkout_session_id,
         reservation_id,
         experiment_tag,
         offer_code,
         status,
         source,
         locale,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, 'created', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(checkout_session_id) DO UPDATE SET
         source = excluded.source,
         locale = excluded.locale,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(
      checkoutSessionId,
      reservationId,
      STAGE5_PILOT_EXPERIMENT_TAG,
      STAGE5_PILOT_OFFER_CODE,
      source,
      locale,
    )
    .run();
}

export async function completePilotReservation({
  checkoutSessionId,
  customerEmail,
  videoUrl,
  targetLanguage,
  rightsConfirmed,
  stripeEventId,
  stripeEventType,
}: {
  checkoutSessionId: string;
  customerEmail: string;
  videoUrl: string;
  targetLanguage: string;
  rightsConfirmed: boolean;
  stripeEventId: string;
  stripeEventType: string;
}): Promise<void> {
  const db = getDatabase();
  const result = await db
    .prepare(
      `UPDATE stage5_pilot_reservations
       SET status = 'completed',
           customer_email = ?,
           video_url = ?,
           target_language = ?,
           rights_confirmed = ?,
           stripe_event_id = ?,
           stripe_event_type = ?,
           updated_at = CURRENT_TIMESTAMP,
           completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
       WHERE checkout_session_id = ?
         AND experiment_tag = ?
         AND offer_code = ?
         AND status != 'invalidated'`,
    )
    .bind(
      customerEmail,
      videoUrl,
      targetLanguage,
      rightsConfirmed ? 1 : 0,
      stripeEventId,
      stripeEventType,
      checkoutSessionId,
      STAGE5_PILOT_EXPERIMENT_TAG,
      STAGE5_PILOT_OFFER_CODE,
    )
    .run();

  if (Number(result?.meta?.changes ?? 0) !== 1) {
    throw new Error(
      `Pilot reservation is missing or not attributable: ${checkoutSessionId}`,
    );
  }
}
