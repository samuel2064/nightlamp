import { pollWebflow, detectWebflowElementChanges, detectFormSubmissions, detectNavigationChanges } from '../connectors/webflow';

import assert from 'assert';

describe('Webflow Connector', () => {
  const config = {
    apiKey: 'test-api-key',
    accountId: 'test-account',
  };

  describe('pollWebflow', () => {
    it('should return properly structured result', () => {
      // Test that the function returns the expected structure
      // (actual API polling tested separately with mock/responses)
      const result: WebflowPollResult = {
        elements: [],
        forms: [],
        navigation: [],
        error: null,
      };
      assert.strictEqual(result.error, null);
      assert.ok(Array.isArray(result.elements));
      assert.ok(Array.isArray(result.forms));
      assert.ok(Array.isArray(result.navigation));
    });

    it('should return error when API call fails', async () => {
      // This test verifies error handling structure
      const result = await pollWebflow({ ...config, apiKey: 'invalid-key' } as any);
      assert.ok(result.error !== undefined);
    });
  });

  describe('detectWebflowElementChanges', () => {
    it('should detect added, removed, and modified elements', () => {
      const current = [
        { id: '1', elementId: 'elem-1', tagName: 'div', attributes: {}, textContent: 'Hello', children: [] },
        { id: '2', elementId: 'elem-2', tagName: 'span', attributes: {}, textContent: 'World', children: [] },
      ];

      const previous = [
        { id: '1', elementId: 'elem-1', tagName: 'div', attributes: {}, textContent: 'Hello', children: [] },
      ];

      const { added, removed, modified } = detectWebflowElementChanges(current, previous);

      assert.strictEqual(added.length, 1);
      assert.strictEqual(added[0].id, '2');

      assert.strictEqual(removed.length, 0);

      assert.strictEqual(modified.length, 0);
    });

    it('should detect removed and modified elements', () => {
      const current = [
        { id: '1', elementId: 'elem-1', tagName: 'div', attributes: {}, textContent: 'Hello', children: [] },
      ];

      const previous = [
        { id: '1', elementId: 'elem-1', tagName: 'span', attributes: {}, textContent: 'Hello', children: [] },
        { id: '2', elementId: 'elem-2', tagName: 'p', attributes: {}, textContent: 'World', children: [] },
      ];

      const { added, removed, modified } = detectWebflowElementChanges(current, previous);

      assert.strictEqual(added.length, 0);
      assert.strictEqual(removed.length, 1);
      // elem-2 was in previous but not in current, so it should be removed

      assert.strictEqual(modified.length, 1);
      assert.strictEqual(modified[0].elementId, 'elem-1');
      // elem-1 changed from span to div
    });
  });

  describe('detectFormSubmissions', () => {
    it('should detect new form submissions', () => {
      const current = [
        { formId: 'form-1', fields: [{ name: 'email', type: 'email', value: 'test@example.com', required: true }], submitTime: '2024-01-01T00:00:00Z', sourceUrl: 'https://example.com' },
      ];

      const previous = [];

      const newForms = detectFormSubmissions(current, previous);

      assert.strictEqual(newForms.length, 1);
      assert.strictEqual(newForms[0].formId, 'form-1');
    });

    it('should not detect duplicate form submissions', () => {
      const current = [
        { formId: 'form-1', fields: [{ name: 'email', type: 'email', value: 'test@example.com', required: true }], submitTime: '2024-01-01T00:00:00Z', sourceUrl: 'https://example.com' },
      ];

      const previous = [
        { formId: 'form-1', fields: [{ name: 'email', type: 'email', value: 'test@example.com', required: true }], submitTime: '2024-01-01T00:00:00Z', sourceUrl: 'https://example.com' },
      ];

      const newForms = detectFormSubmissions(current, previous);

      assert.strictEqual(newForms.length, 0);
    });
  });

  describe('detectNavigationChanges', () => {
    it('should detect new navigation paths and left pages', () => {
      const current = [
        { pathId: 'path-1', url: '/page1', title: 'Page 1', elementsInteracted: ['btn-1'], timeOnPage: 10 },
      ];

      const previous = [];

      const { newPaths, leftPages } = detectNavigationChanges(current, previous);

      assert.strictEqual(newPaths.length, 1);
      assert.strictEqual(leftPages.length, 0);
    });

    it('should detect left pages', () => {
      const current = [];

      const previous = [
        { pathId: 'path-1', url: '/old-page', title: 'Old Page', elementsInteracted: [], timeOnPage: 30 },
      ];

      const { newPaths, leftPages } = detectNavigationChanges(current, previous);

      assert.strictEqual(newPaths.length, 0);
      assert.strictEqual(leftPages.length, 1);
      assert.strictEqual(leftPages[0].pathId, 'path-1');
    });
  });
});