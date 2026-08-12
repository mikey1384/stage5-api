import { getDatabase } from "./core";

export async function isInternalDevice({
  deviceId,
}: {
  deviceId: string;
}): Promise<boolean> {
  const row = await getDatabase()
    .prepare(
      `SELECT 1 AS is_internal
         FROM internal_devices
        WHERE device_id = ?
        LIMIT 1`,
    )
    .bind(deviceId)
    .first();

  return row !== null;
}
