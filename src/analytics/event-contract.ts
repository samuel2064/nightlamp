export const PLAN_TIERS = ['free', 'pro', 'team', 'enterprise'] as const;

export const SURVEY_IDS = [
  'welcome',
  'microsurvey_monitor_created',
  'microsurvey_alert_received',
  'microsurvey_playbook_completed',
  'microsurvey_team_invite',
  'nps_day14',
  'nps_day30',
  'exit_account_delete',
  'exit_inactivity',
] as const;

export const FEEDBACK_TYPES = ['bug_report', 'feature_request', 'general'] as const;

export const NPS_CATEGORIES = ['detractor', 'passive', 'promoter'] as const;

export const CAUSE_CATEGORIES = [
  'configuration',
  'dependency',
  'credential',
  'capacity',
  'code_defect',
  'network',
  'upstream',
  'unknown',
] as const;

export const FIX_CATEGORIES = [
  'configuration',
  'dependency',
  'credential',
  'capacity',
  'code_fix',
  'network',
  'upstream',
  'none',
] as const;

type PropertyType = 'string' | 'number' | 'integer' | 'boolean';

interface PropertySpec {
  type: PropertyType;
  enum?: readonly string[];
  maxLength?: number;
  pattern?: RegExp;
  min?: number;
  max?: number;
}

const PROPERTY_SPECS: Record<string, PropertySpec> = {
  user_id_hash: { type: 'string', maxLength: 128, pattern: /^[a-f0-9]{16,128}$/i },
  organization_id_hash: { type: 'string', maxLength: 128, pattern: /^[a-f0-9]{16,128}$/i },
  plan: { type: 'string', enum: PLAN_TIERS },
  signup_date: { type: 'string', maxLength: 40 },
  cohort_week: { type: 'string', maxLength: 16, pattern: /^\d{4}-W\d{1,2}$/ },
  device_type: { type: 'string', enum: ['desktop', 'mobile', 'tablet'] },
  os: { type: 'string', maxLength: 64 },
  browser: { type: 'string', maxLength: 64 },
  app_version: { type: 'string', maxLength: 32 },
  is_beta: { type: 'boolean' },
  session_id: { type: 'string', maxLength: 128 },
  experiment: { type: 'string', maxLength: 64 },
  variant: { type: 'string', maxLength: 64 },
  route_template: { type: 'string', maxLength: 200, pattern: /^\/[A-Za-z0-9_\-\/{}:.]*$/ },
  response_id: { type: 'string', maxLength: 200 },
  source: { type: 'string', enum: ['landing', 'invite', 'direct', 'demo_conversion'] },
  invite_token_used: { type: 'boolean' },
  demo_mode: { type: 'boolean' },
  step: { type: 'string', enum: ['connect', 'select', 'configure', 'test'] },
  step_number: { type: 'integer', min: 1, max: 4 },
  duration_ms: { type: 'integer', min: 0 },
  provider: { type: 'string', maxLength: 64 },
  repos_selected: { type: 'integer', min: 0 },
  checks_enabled: { type: 'integer', min: 0 },
  skipped: { type: 'boolean' },
  error_code: { type: 'string', maxLength: 100 },
  recoverable: { type: 'boolean' },
  total_duration_ms: { type: 'integer', min: 0 },
  monitor_id: { type: 'string', maxLength: 128 },
  monitor_type: { type: 'string', enum: ['web', 'api', 'database', 'cron'] },
  repo_count: { type: 'integer', min: 0 },
  entry_point: { type: 'string', enum: ['landing', 'invite', 'direct', 'demo_conversion', 'wizard', 'dashboard_empty_state'] },
  time_to_first_check_ms: { type: 'integer', min: 0 },
  time_to_first_monitor_ms: { type: 'integer', min: 0 },
  alert_id: { type: 'string', maxLength: 128 },
  severity: { type: 'string', enum: ['critical', 'high', 'warning', 'info'] },
  alert_type: { type: 'string', enum: ['uptime', 'performance', 'error_rate', 'dependency', 'custom'] },
  delivery_channel: { type: 'string', enum: ['email', 'slack', 'pagerduty', 'in_app', 'push'] },
  time_since_monitor_created_ms: { type: 'integer', min: 0 },
  playbook_id: { type: 'string', maxLength: 128 },
  incident_id: { type: 'string', maxLength: 128 },
  trigger_source: { type: 'string', enum: ['incident_detail', 'alert_notification', 'dashboard', 'history'] },
  steps_completed: { type: 'integer', min: 0 },
  total_steps: { type: 'integer', min: 0 },
  time_to_resolve_ms: { type: 'integer', min: 0 },
  steps_executed: { type: 'integer', min: 0 },
  user_initiated: { type: 'boolean' },
  cause_category: { type: 'string', enum: CAUSE_CATEGORIES },
  fix_category: { type: 'string', enum: FIX_CATEGORIES },
  feedback_type: { type: 'string', enum: FEEDBACK_TYPES },
  response_time_ms: { type: 'integer', min: 0 },
  survey_id: { type: 'string', enum: SURVEY_IDS },
  score: { type: 'number', min: 0, max: 10 },
  nps_category: { type: 'string', enum: NPS_CATEGORIES },
  completion_rate: { type: 'number', min: 0, max: 1 },
  time_spent_ms: { type: 'integer', min: 0 },
  prompt_trigger: { type: 'string', enum: ['auto', 'manual', 'after_ack', 'after_session_3'] },
  previous_dismissals: { type: 'integer', min: 0 },
  platform: { type: 'string', enum: ['ios', 'android', 'desktop'] },
  was_pwa_before: { type: 'boolean' },
  feature: {
    type: 'string',
    enum: [
      'team_invite',
      'custom_playbook',
      'maintenance_window',
      'webhook_integration',
      'api_access',
      'dashboard_share',
      'export_data',
      'on_call_schedule',
    ],
  },
  first_use: { type: 'boolean' },
  signal_type: {
    type: 'string',
    enum: [
      'account_delete',
      'monitor_delete',
      'all_monitors_paused',
      'no_login_7d',
      'no_login_14d',
      'no_login_30d',
      'plan_downgrade',
      'payment_failed',
    ],
  },
  monitor_count_before: { type: 'integer', min: 0 },
  days_since_last_login: { type: 'integer', min: 0 },
  invite_id: { type: 'string', maxLength: 128 },
  role: { type: 'string', enum: ['owner', 'admin', 'member', 'viewer'] },
  time_to_accept_hours: { type: 'number', min: 0 },
  abbreviated_onboarding: { type: 'boolean' },
  onboarding_completed: { type: 'boolean' },
  time_since_delivery_ms: { type: 'integer', min: 0 },
  session_duration_ms: { type: 'integer', min: 0 },
  page_views: { type: 'integer', min: 0 },
  actions_taken: { type: 'integer', min: 0 },
  observed_until: { type: 'string', maxLength: 40 },
  is_final: { type: 'boolean' },
};

export interface EventSpec {
  required: string[];
  optional: string[];
  forbidden: string[];
}

const SUPER_PROPERTIES = [
  'user_id_hash',
  'organization_id_hash',
  'plan',
  'signup_date',
  'cohort_week',
  'device_type',
  'os',
  'browser',
  'app_version',
  'is_beta',
  'session_id',
  'experiment',
  'variant',
  'route_template',
  'response_id',
];

export const EVENT_SPECS: Record<string, EventSpec> = {
  signup_completed: {
    required: ['source'],
    optional: ['invite_token_used', 'demo_mode'],
    forbidden: ['referrer', 'utm_source', 'utm_medium', 'utm_campaign'],
  },
  onboarding_step_completed: {
    required: ['step', 'step_number'],
    optional: [
      'duration_ms',
      'provider',
      'repos_selected',
      'checks_enabled',
      'skipped',
      'error_code',
      'recoverable',
    ],
    forbidden: ['checks_detail', 'notification_channels'],
  },
  onboarding_completed: {
    required: ['monitor_id'],
    optional: [
      'total_duration_ms',
      'monitor_type',
      'provider',
      'repo_count',
      'checks_enabled',
      'entry_point',
      'time_to_first_check_ms',
    ],
    forbidden: [],
  },
  first_monitor_created: {
    required: ['monitor_id'],
    optional: ['monitor_type', 'time_to_first_monitor_ms', 'checks_enabled', 'provider'],
    forbidden: [],
  },
  first_alert_received: {
    required: ['alert_id'],
    optional: [
      'monitor_id',
      'severity',
      'alert_type',
      'delivery_channel',
      'time_since_monitor_created_ms',
    ],
    forbidden: ['action_taken', 'time_to_action_ms'],
  },
  playbook_viewed: {
    required: ['playbook_id'],
    optional: ['incident_id', 'trigger_source', 'steps_completed', 'total_steps'],
    forbidden: ['verdict', 'time_to_resolve_ms', 'confidence_score', 'playbook_name'],
  },
  playbook_resolved_incident: {
    required: ['playbook_id', 'incident_id'],
    optional: ['time_to_resolve_ms', 'steps_executed', 'user_initiated', 'cause_category', 'fix_category'],
    forbidden: ['root_cause', 'fix_applied', 'metrics_before', 'metrics_after', 'playbook_name'],
  },
  feedback_submitted: {
    required: ['feedback_type'],
    optional: ['response_id', 'response_time_ms'],
    forbidden: ['sentiment', 'page_context', 'has_screenshot', 'has_annotation', 'title', 'description'],
  },
  survey_completed: {
    required: ['survey_id'],
    optional: ['response_id', 'score', 'nps_category', 'completion_rate', 'time_spent_ms'],
    forbidden: ['dismissed', 'answers', 'reason', 'reasons', 'would_stay', 'contact_consent', 'improvement'],
  },
  pwa_installed: {
    required: ['platform'],
    optional: ['prompt_trigger', 'previous_dismissals', 'was_pwa_before'],
    forbidden: [],
  },
  mobile_session: {
    required: [],
    optional: [],
    forbidden: [
      'session_duration_ms',
      'page_views',
      'actions_taken',
      'critical_alerts_received',
      'alerts_acknowledged',
      'playbooks_viewed',
      'orientation_changes',
      'offline_actions_queued',
    ],
  },
  feature_adoption: {
    required: ['feature'],
    optional: ['first_use'],
    forbidden: ['context_page'],
  },
  churn_signal: {
    required: ['signal_type'],
    optional: ['monitor_count_before', 'days_since_last_login'],
    forbidden: ['last_action'],
  },
  invite_accepted: {
    required: ['invite_id'],
    optional: ['role', 'time_to_accept_hours', 'abbreviated_onboarding', 'onboarding_completed'],
    forbidden: [],
  },
  demo_mode_activated: {
    required: ['entry_point'],
    optional: [],
    forbidden: ['converted_to_real', 'time_in_demo_ms', 'actions_in_demo'],
  },
  alert_acknowledged: {
    required: ['alert_id'],
    optional: ['incident_id', 'time_since_delivery_ms'],
    forbidden: [],
  },
  session_summary: {
    required: ['observed_until'],
    optional: ['session_duration_ms', 'page_views', 'actions_taken', 'is_final'],
    forbidden: [],
  },
};

export const ALLOWED_EVENTS = Object.keys(EVENT_SPECS);

export const PII_PROPERTY_NAMES = [
  'email',
  'email_address',
  'user_email',
  'name',
  'full_name',
  'first_name',
  'last_name',
  'phone',
  'ip',
  'ip_address',
  'title',
  'description',
  'body',
  'text',
  'comment',
  'message',
  'note',
  'notes',
  'detail',
  'details',
  'answer',
  'answers',
  'reason',
  'reasons',
  'improvement',
  'would_stay',
  'contact_consent',
  'screenshot',
  'screenshots',
  'image',
  'images',
  'annotation',
  'annotations',
  'url',
  'urls',
  'uri',
  'link',
  'page_url',
  'query',
  'query_string',
  'referrer',
  'referer',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'root_cause',
  'fix_applied',
  'playbook_name',
  'feature_title',
  'steps_to_reproduce',
  'last_action',
  'context_page',
  'page_context',
];

const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const URL_PATTERN = /https?:\/\//i;
const MAX_WORDS = 6;
const MAX_TOP_LEVEL_KEYS = 8;

export interface ValidatedAnalyticsEvent {
  event: string;
  event_id: string;
  schema_version: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

export interface AnalyticsValidationResult {
  ok: boolean;
  errors: string[];
  event?: ValidatedAnalyticsEvent;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  );
}

function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function validatePropertyValue(name: string, value: unknown, errors: string[]): void {
  const spec = PROPERTY_SPECS[name];
  if (!spec) {
    errors.push(`property "${name}" is not allowed`);
    return;
  }

  if (!isScalar(value)) {
    errors.push(`property "${name}" must be a scalar value`);
    return;
  }

  if (value === null) {
    errors.push(`property "${name}" must not be null`);
    return;
  }

  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') {
      errors.push(`property "${name}" must be a boolean`);
    }
    return;
  }

  if (spec.type === 'number' || spec.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`property "${name}" must be a number`);
      return;
    }
    if (spec.type === 'integer' && !Number.isInteger(value)) {
      errors.push(`property "${name}" must be an integer`);
      return;
    }
    if (spec.min !== undefined && value < spec.min) {
      errors.push(`property "${name}" must be >= ${spec.min}`);
    }
    if (spec.max !== undefined && value > spec.max) {
      errors.push(`property "${name}" must be <= ${spec.max}`);
    }
    return;
  }

  if (typeof value !== 'string') {
    errors.push(`property "${name}" must be a string`);
    return;
  }

  if (spec.maxLength !== undefined && value.length > spec.maxLength) {
    errors.push(`property "${name}" must be at most ${spec.maxLength} characters`);
    return;
  }

  if (spec.enum && !spec.enum.includes(value)) {
    errors.push(`property "${name}" must be one of: ${spec.enum.join(', ')}`);
    return;
  }

  if (spec.pattern && !spec.pattern.test(value)) {
    errors.push(`property "${name}" has an invalid format`);
    return;
  }

  if (EMAIL_PATTERN.test(value)) {
    errors.push(`property "${name}" must not contain an email address`);
    return;
  }

  if (URL_PATTERN.test(value)) {
    errors.push(`property "${name}" must not contain a URL`);
    return;
  }

  if (countWords(value) > MAX_WORDS) {
    errors.push(`property "${name}" must not contain free text`);
  }
}

export function validateAnalyticsEvent(
  payload: unknown,
  options: { now?: number } = {},
): AnalyticsValidationResult {
  const errors: string[] = [];
  const now = options.now ?? Date.now();

  if (!isPlainObject(payload)) {
    return { ok: false, errors: ['payload must be a JSON object'] };
  }

  const allowedTopLevel = ['event', 'event_id', 'schema_version', 'timestamp', 'properties'];
  for (const key of Object.keys(payload)) {
    if (!allowedTopLevel.includes(key)) {
      errors.push(`field "${key}" is not allowed`);
    }
  }
  if (errors.length > MAX_TOP_LEVEL_KEYS) {
    return { ok: false, errors: errors.slice(0, MAX_TOP_LEVEL_KEYS) };
  }

  const eventName = payload.event;
  if (typeof eventName !== 'string' || !eventName.trim()) {
    errors.push('event is required');
  } else if (!EVENT_SPECS[eventName]) {
    errors.push(`event "${eventName}" is not part of the event contract`);
  }

  const eventId = payload.event_id;
  if (typeof eventId !== 'string' || !eventId.trim()) {
    errors.push('event_id is required');
  } else if (!/^[A-Za-z0-9._:-]{1,200}$/.test(eventId)) {
    errors.push('event_id must be 1-200 characters of [A-Za-z0-9._:-]');
  }

  const schemaVersion = payload.schema_version;
  if (typeof schemaVersion !== 'string' || !schemaVersion.trim()) {
    errors.push('schema_version is required');
  } else if (!/^\d+\.\d+$/.test(schemaVersion)) {
    errors.push('schema_version must look like 1.0');
  }

  const timestamp = payload.timestamp;
  if (typeof timestamp !== 'string' || !timestamp.trim()) {
    errors.push('timestamp is required');
  } else {
    const parsed = Date.parse(timestamp);
    if (Number.isNaN(parsed)) {
      errors.push('timestamp must be an ISO-8601 timestamp');
    } else if (parsed > now + 5 * 60 * 1000) {
      errors.push('timestamp must not be in the future');
    }
  }

  const rawProperties = payload.properties;
  if (!isPlainObject(rawProperties)) {
    errors.push('properties must be an object');
  } else {
    const spec = typeof eventName === 'string' ? EVENT_SPECS[eventName] : undefined;
    const allowed = spec
      ? [...SUPER_PROPERTIES, ...spec.required, ...spec.optional]
      : SUPER_PROPERTIES;
    const forbidden = spec ? spec.forbidden : [];

    for (const [name, value] of Object.entries(rawProperties)) {
      if (PII_PROPERTY_NAMES.includes(name)) {
        errors.push(`property "${name}" must not be sent to analytics`);
        continue;
      }
      if (forbidden.includes(name)) {
        errors.push(`property "${name}" is not allowed on event "${eventName}"`);
        continue;
      }
      if (!allowed.includes(name)) {
        errors.push(`property "${name}" is not allowed on event "${eventName}"`);
        continue;
      }
      validatePropertyValue(name, value, errors);
    }

    if (spec) {
      for (const required of spec.required) {
        if (!(required in rawProperties)) {
          errors.push(`property "${required}" is required on event "${eventName}"`);
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors: errors.slice(0, MAX_TOP_LEVEL_KEYS) };
  }

  return {
    ok: true,
    errors: [],
    event: {
      event: eventName as string,
      event_id: eventId as string,
      schema_version: schemaVersion as string,
      timestamp: timestamp as string,
      properties: rawProperties as Record<string, unknown>,
    },
  };
}

export function validateFeedbackResponse(payload: unknown): {
  ok: boolean;
  errors: string[];
  value?: {
    response_id: string;
    kind: 'feedback' | 'survey';
    feedback_type?: string;
    survey_id?: string;
    score?: number;
    response: Record<string, unknown>;
  };
} {
  const errors: string[] = [];

  if (!isPlainObject(payload)) {
    return { ok: false, errors: ['payload must be a JSON object'] };
  }

  const allowed = ['response_id', 'kind', 'feedback_type', 'survey_id', 'score', 'response'];
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      errors.push(`field "${key}" is not allowed`);
    }
  }

  const responseId = payload.response_id;
  if (typeof responseId !== 'string' || !responseId.trim()) {
    errors.push('response_id is required');
  } else if (!/^[A-Za-z0-9._:-]{1,200}$/.test(responseId)) {
    errors.push('response_id must be 1-200 characters of [A-Za-z0-9._:-]');
  }

  const kind = payload.kind;
  if (kind !== 'feedback' && kind !== 'survey') {
    errors.push('kind must be feedback or survey');
  }

  let feedbackType: string | undefined;
  if (kind === 'feedback') {
    feedbackType = payload.feedback_type as string;
    if (typeof feedbackType !== 'string' || !(FEEDBACK_TYPES as readonly string[]).includes(feedbackType)) {
      errors.push(`feedback_type must be one of: ${FEEDBACK_TYPES.join(', ')}`);
    }
    if (payload.survey_id !== undefined) {
      errors.push('survey_id must not be sent with kind feedback');
    }
  }

  let surveyId: string | undefined;
  if (kind === 'survey') {
    surveyId = payload.survey_id as string;
    if (typeof surveyId !== 'string' || !(SURVEY_IDS as readonly string[]).includes(surveyId)) {
      errors.push(`survey_id must be one of: ${SURVEY_IDS.join(', ')}`);
    }
    if (payload.feedback_type !== undefined) {
      errors.push('feedback_type must not be sent with kind survey');
    }
  }

  let score: number | undefined;
  if (payload.score !== undefined) {
    if (typeof payload.score !== 'number' || !Number.isFinite(payload.score)) {
      errors.push('score must be a number');
    } else if (payload.score < 0 || payload.score > 10) {
      errors.push('score must be between 0 and 10');
    } else {
      score = payload.score;
    }
  }

  const response = payload.response;
  if (!isPlainObject(response)) {
    errors.push('response must be an object');
  } else {
    for (const [name, value] of Object.entries(response)) {
      if (!isScalar(value)) {
        errors.push(`response "${name}" must be a scalar value`);
        continue;
      }
      if (typeof value === 'string' && value.length > 4000) {
        errors.push(`response "${name}" is too long`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    value: {
      response_id: responseId as string,
      kind: kind as 'feedback' | 'survey',
      feedback_type: feedbackType,
      survey_id: surveyId,
      score,
      response: response as Record<string, unknown>,
    },
  };
}

export function npsCategoryForScore(score: number): string {
  if (score <= 6) return 'detractor';
  if (score <= 8) return 'passive';
  return 'promoter';
}
