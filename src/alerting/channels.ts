import * as nodemailer from 'nodemailer';

export type ChannelType = 'slack' | 'email' | 'pagerduty';

export interface SlackConfig {
  webhookUrl: string;
}

export interface EmailConfig {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  fromAddress: string;
  toAddresses: string[];
}

export interface PagerDutyConfig {
  routingKey: string;
}

export type ChannelConfig = SlackConfig | EmailConfig | PagerDutyConfig;

export interface NotificationPayload {
  title: string;
  description: string;
  failureType: string;
  severity: string;
  detectedAt: string;
  checkId?: string;
  eventId?: string;
}

function formatSlackMessage(payload: NotificationPayload): object {
  const colorMap: Record<string, string> = {
    critical: '#FF0000',
    warning: '#FFA500',
    info: '#3498DB',
  };

  return {
    attachments: [{
      color: colorMap[payload.severity] || '#808080',
      title: payload.title,
      text: payload.description,
      fields: [
        { title: 'Type', value: payload.failureType, short: true },
        { title: 'Severity', value: payload.severity, short: true },
        { title: 'Detected At', value: payload.detectedAt, short: false },
      ],
      footer: 'Nightlamp Monitoring',
      ts: Math.floor(new Date(payload.detectedAt).getTime() / 1000),
    }],
  };
}

function formatPagerDutyPayload(payload: NotificationPayload): object {
  const severityMap: Record<string, string> = {
    critical: 'critical',
    warning: 'warning',
    info: 'info',
  };

  return {
    routing_key: '',
    event_action: 'trigger',
    payload: {
      summary: payload.title,
      source: `nightlamp-check-${payload.checkId || 'unknown'}`,
      severity: severityMap[payload.severity] || 'info',
      timestamp: payload.detectedAt,
      component: payload.failureType,
      group: 'nightlamp',
      class: 'failure_event',
      custom_details: {
        description: payload.description,
        eventId: payload.eventId,
      },
    },
  };
}

async function sendSlack(config: SlackConfig, payload: NotificationPayload): Promise<void> {
  const body = formatSlackMessage(payload);
  const response = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Slack webhook returned ${response.status}: ${text}`);
  }
}

async function sendEmail(config: EmailConfig, payload: NotificationPayload): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
  });

  const subject = `[${payload.severity.toUpperCase()}] Nightlamp Alert: ${payload.title}`;

  const html = `
    <h2>${payload.title}</h2>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;">
      <tr><td><strong>Type</strong></td><td>${payload.failureType}</td></tr>
      <tr><td><strong>Severity</strong></td><td>${payload.severity}</td></tr>
      <tr><td><strong>Description</strong></td><td>${payload.description}</td></tr>
      <tr><td><strong>Detected At</strong></td><td>${payload.detectedAt}</td></tr>
      <tr><td><strong>Event ID</strong></td><td>${payload.eventId || 'N/A'}</td></tr>
    </table>
    <hr>
    <p style="color:#888;font-size:12px;">Sent by Nightlamp Monitoring</p>
  `;

  await transporter.sendMail({
    from: config.fromAddress,
    to: config.toAddresses.join(', '),
    subject,
    html,
    text: `${payload.title}\n\nType: ${payload.failureType}\nSeverity: ${payload.severity}\nDescription: ${payload.description}\nDetected At: ${payload.detectedAt}`,
  });
}

async function sendPagerDuty(config: PagerDutyConfig, payload: NotificationPayload): Promise<void> {
  const body = formatPagerDutyPayload(payload) as Record<string, any>;
  body.routing_key = config.routingKey;
  const response = await fetch('https://events.pagerduty.com/v2/enqueue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`PagerDuty returned ${response.status}: ${text}`);
  }
}

export async function sendNotification(
  channelType: ChannelType,
  config: ChannelConfig,
  payload: NotificationPayload
): Promise<void> {
  switch (channelType) {
    case 'slack':
      await sendSlack(config as SlackConfig, payload);
      break;
    case 'email':
      await sendEmail(config as EmailConfig, payload);
      break;
    case 'pagerduty':
      await sendPagerDuty(config as PagerDutyConfig, payload);
      break;
  }
}
