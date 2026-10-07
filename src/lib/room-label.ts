/**
 * "Room 3" for display, whatever form the room number arrives in. The portal
 * stores `rooms.room_number` as "Room N" (and agreement_requests.room_number
 * copies it verbatim), so blindly prefixing "Room " printed "Room Room 3" on
 * labels — and on lease PDFs. Returns "" for an empty/missing number.
 */
export function roomLabel(roomNumber: string | null | undefined): string {
  const bare = (roomNumber ?? "").trim().replace(/^room\s+/i, "");
  return bare ? `Room ${bare}` : "";
}
