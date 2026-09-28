const PRIORITY = new Map([
  ["INVESTIGATE_SUSPENSION", 10],
  ["RETRY_SUPPLIER_PROVISIONING", 20],
  ["REVIEW_PUBLISHER", 30],
  ["PROVISION_TRIP_COM", 40],
  ["ACTIVATE_COMMERCIAL", 50]
]);

export function buildPublisherOperatorWorkQueue(snapshots) {
  if (!Array.isArray(snapshots)) {
    throw new TypeError("snapshots must be an array");
  }

  return snapshots
    .filter(item => item?.next_action_owner === "CHINAFLOW")
    .map(item => ({
      publisher_id: item.publisher_id,
      display_name: item.display_name,
      hostname: item.hostname,
      current_stage: item.current_stage,
      next_action: item.next_action,
      blocker: item.blocker ?? null,
      priority: PRIORITY.get(item.next_action) ?? 999,
      created_at: item.created_at ?? null
    }))
    .sort((a, b) =>
      a.priority - b.priority ||
      String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) ||
      String(a.publisher_id).localeCompare(String(b.publisher_id))
    );
}
