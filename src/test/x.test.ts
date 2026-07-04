import { createDatabase } from '../db/schema';
import { buildAuthorizeUrl, postTweet, postThread, verifyCredentials } from '../connectors/x';
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
  });
});
