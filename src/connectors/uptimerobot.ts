export interface UptimeRobotConfig {
  apiKey: string;
}

export interface UptimeRobotMonitor {
  id: number;
  friendlyName: string;
  url: string;
  type: number;
  status: number;
  interval: number;
  createDatetime: number;
}

export interface UptimeRobotPollResult {
  monitors: UptimeRobotMonitor[];
  error: string | null;
}

export interface UptimeRobotMonitorStatus {
  id: number;
  friendlyName: string;
  status: 'up' | 'down' | 'paused' | 'maintenance';
  previousStatus: 'up' | 'down' | 'paused' | 'maintenance' | null;
  statusChanged: boolean;
}

export async function pollUptimeRobot(config: UptimeRobotConfig): Promise<UptimeRobotPollResult> {
  try {
    const url = 'https://api.uptimerobot.com/v2/getMonitors';
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache',
      },
      body: new URLSearchParams({
        api_key: config.apiKey,
        format: 'json',
        logs: '1',
      }),
    });

    if (!response.ok) {
      return { monitors: [], error: `UptimeRobot API returned ${response.status}: ${response.statusText}` };
    }

    const data: any = await response.json();

    if (data.stat === 'fail') {
      return { monitors: [], error: `UptimeRobot API error: ${data.error?.message || 'unknown'}` };
    }

    const monitors: UptimeRobotMonitor[] = (data.monitors || []).map((m: any) => ({
      id: m.id,
      friendlyName: m.friendly_name,
      url: m.url,
      type: m.type,
      status: m.status,
      interval: m.interval,
      createDatetime: m.create_datetime,
    }));

    return { monitors, error: null };
  } catch (err: any) {
    return { monitors: [], error: `UptimeRobot poll failed: ${err.message}` };
  }
}

function parseMonitorStatus(status: number): 'up' | 'down' | 'paused' | 'maintenance' {
  switch (status) {
    case 2: return 'up';
    case 9: return 'down';
    case 0: return 'paused';
    default: return 'maintenance';
  }
}

export function detectStatusChanges(
  current: UptimeRobotMonitor[],
  previous: UptimeRobotMonitor[]
): UptimeRobotMonitorStatus[] {
  const prevMap = new Map(previous.map((m) => [m.id, m]));
  const changes: UptimeRobotMonitorStatus[] = [];

  for (const monitor of current) {
    const prev = prevMap.get(monitor.id);
    const currentStatus = parseMonitorStatus(monitor.status);
    const previousStatus = prev ? parseMonitorStatus(prev.status) : null;

    if (prev && currentStatus !== previousStatus) {
      changes.push({
        id: monitor.id,
        friendlyName: monitor.friendlyName,
        status: currentStatus,
        previousStatus,
        statusChanged: true,
      });
    }
  }

  return changes;
}

export function detectSSLIssues(monitors: UptimeRobotMonitor[]): UptimeRobotMonitor[] {
  return monitors.filter((m) => m.status === 9);
}

export function detectResponseDegradation(
  current: UptimeRobotMonitor[],
  previous: UptimeRobotMonitor[],
  threshold: number = 2
): UptimeRobotMonitor[] {
  const prevMap = new Map(previous.map((m) => [m.id, m]));
  const degraded: UptimeRobotMonitor[] = [];

  for (const monitor of current) {
    const prev = prevMap.get(monitor.id);
  }

  return degraded;
}