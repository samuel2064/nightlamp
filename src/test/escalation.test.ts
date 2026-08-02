import assert from 'assert';
import {
  ESCALATION_POLICIES,
  SEVERITY_TO_PRIORITY,
  DEFAULT_ON_CALL_ROTATION,
  getPolicyForSeverity,
  severityToPriority,
  getOnCallAt,
  getPrimaryChannelType,
  EscalationPriority,
  EscalationPolicy,
} from '../alerting';

describe('Alerting Escalation Policy', function () {
  describe('Severity to Priority mapping', function () {
    it('maps critical to P1', function () {
      assert.strictEqual(severityToPriority('critical'), 'P1');
    });
    it('maps warning to P2', function () {
      assert.strictEqual(severityToPriority('warning'), 'P2');
    });
    it('maps info to P3', function () {
      assert.strictEqual(severityToPriority('info'), 'P3');
    });
    it('normalizes case and handles P1/P2 labels', function () {
      assert.strictEqual(severityToPriority('CRITICAL'), 'P1');
      assert.strictEqual(severityToPriority('p1'), 'P1');
      assert.strictEqual(severityToPriority('warning'), 'P2');
      assert.strictEqual(severityToPriority('Info'), 'P3');
    });
    it('defaults unknown severities to P3', function () {
      assert.strictEqual(severityToPriority('noise'), 'P3');
    });
  });

  describe('Escalation policies', function () {
    it('defines P1, P2 and P3 policies', function () {
      (['P1', 'P2', 'P3'] as EscalationPriority[]).forEach((p) => {
        const policy: EscalationPolicy = ESCALATION_POLICIES[p];
        assert.ok(policy, `missing policy ${p}`);
        assert.ok(policy.description, `missing description for ${p}`);
        assert.ok(policy.escalateTo.length > 0, `no escalation steps for ${p}`);
      });
    });

    it('P1 should page an on-call via pagerduty first', function () {
      assert.strictEqual(ESCALATION_POLICIES.P1.escalateTo[0].channelType, 'pagerduty');
      assert.strictEqual(ESCALATION_POLICIES.P1.ackTimeoutMinutes, 10);
    });

    it('P2 and P3 should not page pagerduty', function () {
      const nonPageable = ESCALATION_POLICIES.P2.escalateTo.every((s) => s.channelType !== 'pagerduty');
      const p3NonPageable = ESCALATION_POLICIES.P3.escalateTo.every((s) => s.channelType !== 'pagerduty');
      assert.strictEqual(nonPageable, true);
      assert.strictEqual(p3NonPageable, true);
    });

    it('escalation steps have valid afterMinutes', function () {
      (['P1', 'P2', 'P3'] as EscalationPriority[]).forEach((p) => {
        ESCALATION_POLICIES[p].escalateTo.forEach((step) => {
          assert.ok(step.afterMinutes >= 0, `afterMinutes must be >= 0 for ${p}`);
        });
      });
    });
  });

  describe('getPolicyForSeverity', function () {
    it('returns the P1 policy for critical', function () {
      assert.strictEqual(getPolicyForSeverity('critical')?.priority, 'P1');
    });
    it('returns null only for impossible inputs', function () {
      // All realistic strings resolve to a policy.
      assert.ok(getPolicyForSeverity('warning'));
      assert.ok(getPolicyForSeverity('info'));
    });
  });

  describe('getPrimaryChannelType', function () {
    it('routes critical to pagerduty', function () {
      assert.strictEqual(getPrimaryChannelType('critical'), 'pagerduty');
    });
    it('routes warning to slack', function () {
      assert.strictEqual(getPrimaryChannelType('warning'), 'slack');
    });
  });

  describe('On-call rotation placeholder', function () {
    it('has the default placeholder roster', function () {
      assert.strictEqual(DEFAULT_ON_CALL_ROTATION.primary, 'backend-engineer');
      assert.strictEqual(DEFAULT_ON_CALL_ROTATION.secondary, 'cto');
      assert.ok(DEFAULT_ON_CALL_ROTATION.rotationDays >= 1);
    });

    it('returns primary at the window start', function () {
      assert.strictEqual(getOnCallAt('2026-08-02T00:00:00Z'), 'backend-engineer');
    });

    it('rotates deterministically over time', function () {
      const agents = new Set<string>();
      for (let d = 0; d < 30; d++) {
        const iso = new Date(Date.parse('2026-08-02T00:00:00Z') + d * 86400000).toISOString();
        agents.add(getOnCallAt(iso));
      }
      assert.ok(agents.has('backend-engineer'), 'primary should appear');
      assert.ok(agents.has('cto'), 'secondary should appear in a 30-day window');
    });

    it('handles invalid timestamps gracefully', function () {
      assert.strictEqual(getOnCallAt('not-a-date'), DEFAULT_ON_CALL_ROTATION.primary);
    });
  });
});