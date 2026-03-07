export const TRANSCRIPTION_R2_RESERVATION_SCOPE = "transcribe-r2";

export function buildR2TranscriptionReservationKey(jobId: string): string {
  return `${TRANSCRIPTION_R2_RESERVATION_SCOPE}:${jobId}`;
}
