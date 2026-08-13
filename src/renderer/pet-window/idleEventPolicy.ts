export function canTriggerLongIdleEvent(
  chatOpen: boolean,
  screenMonitoringActive: boolean
): boolean {
  return !chatOpen && !screenMonitoringActive;
}
