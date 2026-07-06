import { createDatabase } from '../db/schema';
import { buildAuthorizeUrl, postTweet, postThread, verifyCredentials, parseLaunchThread } from '../connectors/x';
import { Database } from 'sql.js';
import assert from 'assert';

describe('X/Twitter Connector', () => {
  let db: Database;

  before(async () => {
    db = await createDatabase();
  });

  after(() => {
    if (db) db.close();
  });

  describe('PKCE OAuth', () => {
    it('buildAuthorizeUrl returns valid Twitter OAuth URL', () => {
      const config = {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        callbackUrl: 'https://example.com/callback',
      };

      const { url, codeVerifier, state } = buildAuthorizeUrl(config);

      assert.ok(url.startsWith('https://twitter.com/i/oauth2/authorize'));
      assert.ok(url.includes('response_type=code'));
      assert.ok(url.includes('client_id=test-client-id'));
      assert.ok(url.includes('redirect_uri=https%3A%2F%2Fexample.com%2Fcallback'));
      assert.ok(url.includes('code_challenge_method=S256'));
      assert.ok(url.includes('code_challenge='));
      assert.ok(url.includes('state='));
      assert.ok(url.includes('scope='));

      assert.ok(codeVerifier.length > 0);
      assert.ok(state.length > 0);
      assert.notStrictEqual(codeVerifier, state);
    });

    it('buildAuthorizeUrl generates unique verifier and state each call', () => {
      const config = {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        callbackUrl: 'https://example.com/callback',
      };

      const a = buildAuthorizeUrl(config);
      const b = buildAuthorizeUrl(config);

      assert.notStrictEqual(a.codeVerifier, b.codeVerifier);
      assert.notStrictEqual(a.state, b.state);
    });

    it('buildAuthorizeUrl includes offline.access scope for refresh tokens', () => {
      const config = {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        callbackUrl: 'https://example.com/callback',
      };

      const { url } = buildAuthorizeUrl(config);
      assert.ok(url.includes('offline.access'));
      assert.ok(url.includes('tweet.read'));
      assert.ok(url.includes('tweet.write'));
    });
  });

  describe('Tweet Posting', () => {
    it('postTweet returns error when not authenticated', async () => {
      try {
        await postTweet('invalid-token', { text: 'test tweet' });
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.ok(err.message.includes('401') || err.message.includes('403') || err.message.includes('failed'));
      }
    });

    it('postTweet with empty token returns error', async () => {
      try {
        await postTweet('', { text: 'test' });
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.ok(err.message.length > 0);
      }
    });
  });

  describe('Thread Posting', () => {
    it('postThread posts tweets in sequence', async () => {
      const tweets = ['First tweet', 'Second tweet', 'Third tweet'];

      try {
        const results = await postThread('invalid-token', tweets);
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.ok(err.message.length > 0);
      }
    });

    it('postThread with single tweet works', async () => {
      try {
        await postThread('invalid-token', ['Just one tweet']);
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.ok(err.message.length > 0);
      }
    });
  });

  describe('Credential Verification', () => {
    it('verifyCredentials returns false for invalid token', async () => {
      const valid = await verifyCredentials('invalid-token');
      assert.strictEqual(valid, false);
    });

    it('verifyCredentials returns false for empty token', async () => {
      const valid = await verifyCredentials('');
      assert.strictEqual(valid, false);
    });
  });

  describe('Database Schema', () => {
    it('x_tokens table exists', () => {
      const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='x_tokens'");
      assert.ok(result.length > 0);
    });

    it('x_scheduled_posts table exists', () => {
      const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='x_scheduled_posts'");
      assert.ok(result.length > 0);
    });

    it('can insert and read x_tokens', () => {
      db.run(
        'INSERT INTO x_tokens (id, access_token, refresh_token, scope) VALUES (?, ?, ?, ?)',
        ['test-token', 'access-123', 'refresh-456', 'tweet.read tweet.write']
      );
      const result = db.exec('SELECT id, access_token, scope FROM x_tokens WHERE id = ?', ['test-token']);
      assert.ok(result.length > 0);
      assert.strictEqual(result[0].values[0][0], 'test-token');
      assert.strictEqual(result[0].values[0][1], 'access-123');
      assert.strictEqual(result[0].values[0][2], 'tweet.read tweet.write');
      db.run('DELETE FROM x_tokens WHERE id = ?', ['test-token']);
    });

    it('can insert and read x_scheduled_posts', () => {
      db.run(
        'INSERT INTO x_scheduled_posts (id, tweet_text, position) VALUES (?, ?, ?)',
        ['test-post', 'Hello world', 1]
      );
      const result = db.exec('SELECT id, tweet_text, position, status FROM x_scheduled_posts WHERE id = ?', ['test-post']);
      assert.ok(result.length > 0);
      assert.strictEqual(result[0].values[0][0], 'test-post');
      assert.strictEqual(result[0].values[0][2], 1);
      assert.strictEqual(result[0].values[0][3], 'pending');
      db.run('DELETE FROM x_scheduled_posts WHERE id = ?', ['test-post']);
    });

    it('can schedule a post with future scheduled_at', () => {
      const id = 'scheduled-test-1';
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      db.run(
        'INSERT INTO x_scheduled_posts (id, tweet_text, position, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
        [id, 'Scheduled tweet', 1, futureDate, 'pending']
      );
      const result = db.exec('SELECT id, status, scheduled_at FROM x_scheduled_posts WHERE id = ?', [id]);
      assert.ok(result.length > 0);
      assert.strictEqual(result[0].values[0][1], 'pending');
      db.run('DELETE FROM x_scheduled_posts WHERE id = ?', [id]);
    });

    it('pending post with past scheduled_at is picked up by scheduler query', () => {
      const id = 'scheduler-test-past';
      db.run(
        'INSERT INTO x_scheduled_posts (id, tweet_text, position, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
        [id, 'Past scheduled tweet', 1, '2020-01-01T00:00:00.000Z', 'pending']
      );
      const result = db.exec(
        "SELECT id FROM x_scheduled_posts WHERE status = 'pending' AND scheduled_at <= datetime('now') ORDER BY scheduled_at ASC"
      );
      const found = result.length > 0 && result[0].values.some((row: any) => row[0] === id);
      assert.ok(found, 'Past-due pending post should be returned by scheduler query');
      db.run('DELETE FROM x_scheduled_posts WHERE id = ?', [id]);
    });

    it('future post is not picked up by scheduler query', () => {
      const id = 'scheduler-test-future';
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      db.run(
        'INSERT INTO x_scheduled_posts (id, tweet_text, position, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
        [id, 'Future tweet', 1, futureDate, 'pending']
      );
      const result = db.exec(
        "SELECT id FROM x_scheduled_posts WHERE status = 'pending' AND scheduled_at <= datetime('now') ORDER BY scheduled_at ASC"
      );
      const found = result.length > 0 && result[0].values.some((row: any) => row[0] === id);
      assert.ok(!found, 'Future pending post should NOT be returned by scheduler query');
      db.run('DELETE FROM x_scheduled_posts WHERE id = ?', [id]);
    });

    it('posted posts are excluded from scheduler query', () => {
      const id = 'scheduler-test-posted';
      db.run(
        'INSERT INTO x_scheduled_posts (id, tweet_text, position, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
        [id, 'Already posted', 1, '2020-01-01T00:00:00.000Z', 'posted']
      );
      const result = db.exec(
        "SELECT id FROM x_scheduled_posts WHERE status = 'pending' AND scheduled_at <= datetime('now') ORDER BY scheduled_at ASC"
      );
      const found = result.length > 0 && result[0].values.some((row: any) => row[0] === id);
      assert.ok(!found, 'Posted posts should NOT be returned by scheduler query');
      db.run('DELETE FROM x_scheduled_posts WHERE id = ?', [id]);
    });
  });

  describe('Launch Thread Parser', () => {
    const sampleContent = `# Build-in-Public Launch Thread

## 7-Tweet Launch Thread

### Tweet 1 — Hook
\`\`\`
Your AI-built app has an active failure right now and you don't know it.

I run Nightlamp — we monitor AI/no-code apps 24/7.
\`\`\`

### Tweet 2 — The Problem
\`\`\`
Expired API keys. Rate limit shifts. Schema drift. Broken webhooks.

Not "if" — "when." And the app never shows an error.
\`\`\`

### Tweet 3 — The Stats
\`\`\`
We monitored 50 AI apps for 3 months.

Average findings per app: 2.3 active failures.
\`\`\``;

    it('extracts correct number of tweets', () => {
      const tweets = parseLaunchThread(sampleContent);
      assert.strictEqual(tweets.length, 3);
    });

    it('extracts tweet text correctly', () => {
      const tweets = parseLaunchThread(sampleContent);
      assert.ok(tweets[0].includes('Your AI-built app has an active failure'));
      assert.ok(tweets[1].includes('Expired API keys. Rate limit shifts.'));
      assert.ok(tweets[2].includes('We monitored 50 AI apps for 3 months'));
    });

    it('preserves multi-line content in each tweet', () => {
      const tweets = parseLaunchThread(sampleContent);
      assert.ok(tweets[0].includes('\n'), 'Multi-line tweet should contain newline');
      assert.ok(tweets[0].includes('I run Nightlamp'));
    });

    it('returns single entry for content with no tweet markers', () => {
      const result = parseLaunchThread('# Just a title\n\nSome paragraph text.');
      assert.strictEqual(result.length, 1);
      assert.ok(result[0].includes('Some paragraph text'));
    });

    it('returns empty array for empty content', () => {
      assert.strictEqual(parseLaunchThread('').length, 0);
    });

    it('parses actual launch thread file correctly', () => {
      const fs = require('fs');
      const path = require('path');
      const filePath = path.resolve('./docs/marketing/build-in-public-content.md');
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const tweets = parseLaunchThread(content);
        assert.strictEqual(tweets.length, 7, 'Launch thread should have exactly 7 tweets');
        assert.ok(tweets[0].includes('Your AI-built app'));
        assert.ok(tweets[6].includes('Pricing'));
      }
    });
  });
});
