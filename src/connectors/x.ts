import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

export interface XConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export interface XTokenStore {
  id: string;
  accessToken: string;
  refreshToken: string;
  scope: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface XTweet {
  id: string;
  text: string;
  tweetId: string | null;
  inReplyToId: string | null;
  position: number;
  postedAt: string | null;
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generateCodeVerifier(): string {
  const buffer = crypto.randomBytes(32);
  return base64UrlEncode(buffer);
}

function generateCodeChallenge(verifier: string): string {
  const hash = crypto.createHash('sha256').update(verifier).digest();
  return base64UrlEncode(hash);
}

function generateState(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function buildAuthorizeUrl(config: XConfig): {
  url: string;
  codeVerifier: string;
  state: string;
} {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: 'tweet.read tweet.write users.read offline.access',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return {
    url: `https://twitter.com/i/oauth2/authorize?${params.toString()}`,
    codeVerifier,
    state,
  };
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  scope: string;
  expiresIn: number;
}

export async function exchangeCodeForToken(
  config: XConfig,
  code: string,
  codeVerifier: string
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    code_verifier: codeVerifier,
  });

  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  const response = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  const data = await response.json() as any;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    scope: data.scope,
    expiresIn: data.expires_in,
  };
}

export async function refreshAccessToken(
  config: XConfig,
  refreshToken: string
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    client_id: config.clientId,
  });

  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  const response = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${text}`);
  }

  const data = await response.json() as any;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    scope: data.scope,
    expiresIn: data.expires_in,
  };
}

export interface PostTweetInput {
  text: string;
  inReplyToTweetId?: string;
}

export interface PostTweetResult {
  tweetId: string;
  text: string;
}

export async function postTweet(
  accessToken: string,
  input: PostTweetInput
): Promise<PostTweetResult> {
  const body: any = { text: input.text };
  if (input.inReplyToTweetId) {
    body.reply = { in_reply_to_tweet_id: input.inReplyToTweetId };
  }

  const response = await fetch('https://api.twitter.com/2/tweets', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Post tweet failed: ${response.status} ${text}`);
  }

  const data = await response.json() as any;
  return {
    tweetId: data.data.id,
    text: data.data.text,
  };
}

export async function postThread(
  accessToken: string,
  tweets: string[]
): Promise<PostTweetResult[]> {
  const results: PostTweetResult[] = [];
  let replyToId: string | undefined;

  for (const text of tweets) {
    const result = await postTweet(accessToken, {
      text,
      inReplyToTweetId: replyToId,
    });
    results.push(result);
    replyToId = result.tweetId;
  }

  return results;
}

export async function verifyCredentials(accessToken: string): Promise<boolean> {
  try {
    const response = await fetch('https://api.twitter.com/2/users/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function parseLaunchThread(content: string): string[] {
  const tweets: string[] = [];
  let currentTweet = '';

  for (const line of content.split('\n')) {
    const tweetMatch = line.match(/^### Tweet (\d+)/);
    if (tweetMatch) {
      if (currentTweet) tweets.push(currentTweet.trim());
      currentTweet = '';
    } else if (line.trim() && !line.startsWith('#') && !line.startsWith('---') && !line.startsWith('`')) {
      if (currentTweet) currentTweet += '\n' + line.trim();
      else currentTweet = line.trim();
    }
  }
  if (currentTweet) tweets.push(currentTweet.trim());

  return tweets;
}
