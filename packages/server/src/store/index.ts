import type { ChatSession, UserProfile } from '@wealth/shared';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Persistence contract. Two implementations satisfy it: DynamoDB for the
 * deployed stack and an in-memory map for local development and tests.
 *
 * Keeping the interface this narrow is what lets `npm run dev` work with no AWS
 * account at all while the Lambda uses a real table - same routes, same agent,
 * one env var apart.
 */
export interface Store {
  readonly kind: 'dynamodb' | 'memory';
  getProfile(id: string): Promise<UserProfile | null>;
  putProfile(profile: UserProfile): Promise<UserProfile>;
  deleteProfile(id: string): Promise<void>;
  listProfiles(): Promise<UserProfile[]>;
  getSession(id: string): Promise<ChatSession | null>;
  putSession(session: ChatSession): Promise<ChatSession>;
  listSessions(profileId: string): Promise<ChatSession[]>;
  /** Removes one conversation. Idempotent: deleting an unknown id is not an error. */
  deleteSession(id: string): Promise<void>;
}

export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private readonly profiles = new Map<string, UserProfile>();
  private readonly sessions = new Map<string, ChatSession>();

  async getProfile(id: string): Promise<UserProfile | null> {
    const found = this.profiles.get(id);
    return found ? structuredClone(found) : null;
  }

  async putProfile(profile: UserProfile): Promise<UserProfile> {
    const stored = { ...profile, updatedAt: new Date().toISOString() };
    this.profiles.set(stored.id, stored);
    return structuredClone(stored);
  }

  async deleteProfile(id: string): Promise<void> {
    this.profiles.delete(id);
    for (const [key, session] of this.sessions) {
      if (session.profileId === id) this.sessions.delete(key);
    }
  }

  async listProfiles(): Promise<UserProfile[]> {
    return [...this.profiles.values()].map((p) => structuredClone(p));
  }

  async getSession(id: string): Promise<ChatSession | null> {
    const found = this.sessions.get(id);
    return found ? structuredClone(found) : null;
  }

  async putSession(session: ChatSession): Promise<ChatSession> {
    const stored = { ...session, updatedAt: new Date().toISOString() };
    this.sessions.set(stored.id, stored);
    return structuredClone(stored);
  }

  async listSessions(profileId: string): Promise<ChatSession[]> {
    return [...this.sessions.values()]
      .filter((s) => s.profileId === profileId)
      .map((s) => structuredClone(s))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}

/**
 * Single-table DynamoDB layout:
 *   PROFILE#<id>  / meta            -> the profile document
 *   PROFILE#<id>  / SESSION#<id>    -> a chat session
 *
 * Sessions live under their profile's partition so listing a user's
 * conversations is one query rather than a scan, and deleting a profile takes
 * its history with it.
 */
export class DynamoStore implements Store {
  readonly kind = 'dynamodb' as const;

  private constructor(
    private readonly client: import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  static async create(table: string, region: string): Promise<DynamoStore> {
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
    const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true },
    });
    return new DynamoStore(doc, table);
  }

  private pk(profileId: string): string {
    return `PROFILE#${profileId}`;
  }

  async getProfile(id: string): Promise<UserProfile | null> {
    const { GetCommand } = await import('@aws-sdk/lib-dynamodb');
    const result = await this.client.send(
      new GetCommand({ TableName: this.table, Key: { pk: this.pk(id), sk: 'meta' } }),
    );
    return (result.Item?.data as UserProfile | undefined) ?? null;
  }

  async putProfile(profile: UserProfile): Promise<UserProfile> {
    const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
    const stored = { ...profile, updatedAt: new Date().toISOString() };
    await this.client.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          pk: this.pk(stored.id),
          sk: 'meta',
          type: 'profile',
          updatedAt: stored.updatedAt,
          data: stored,
        },
      }),
    );
    return stored;
  }

  async deleteProfile(id: string): Promise<void> {
    const { QueryCommand, BatchWriteCommand } = await import('@aws-sdk/lib-dynamodb');
    const items = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': this.pk(id) },
        ProjectionExpression: 'pk, sk',
      }),
    );
    const keys = (items.Items ?? []).map((item) => ({
      DeleteRequest: { Key: { pk: item.pk, sk: item.sk } },
    }));
    // BatchWrite caps at 25 items per call.
    for (let i = 0; i < keys.length; i += 25) {
      await this.client.send(
        new BatchWriteCommand({ RequestItems: { [this.table]: keys.slice(i, i + 25) } }),
      );
    }
  }

  async listProfiles(): Promise<UserProfile[]> {
    const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
    // The GSI keeps this a query; a scan would degrade as the table grows.
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: 'byType',
        KeyConditionExpression: '#t = :t',
        ExpressionAttributeNames: { '#t': 'type' },
        ExpressionAttributeValues: { ':t': 'profile' },
        Limit: 50,
      }),
    );
    return (result.Items ?? []).map((item) => item.data as UserProfile);
  }

  async getSession(id: string): Promise<ChatSession | null> {
    const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: 'byType',
        KeyConditionExpression: '#t = :t',
        FilterExpression: 'sessionId = :id',
        ExpressionAttributeNames: { '#t': 'type' },
        ExpressionAttributeValues: { ':t': 'session', ':id': id },
        Limit: 1,
      }),
    );
    return (result.Items?.[0]?.data as ChatSession | undefined) ?? null;
  }

  async putSession(session: ChatSession): Promise<ChatSession> {
    const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
    const stored = { ...session, updatedAt: new Date().toISOString() };
    await this.client.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          pk: this.pk(stored.profileId),
          sk: `SESSION#${stored.id}`,
          type: 'session',
          sessionId: stored.id,
          updatedAt: stored.updatedAt,
          data: stored,
        },
      }),
    );
    return stored;
  }

  async listSessions(profileId: string): Promise<ChatSession[]> {
    const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': this.pk(profileId), ':prefix': 'SESSION#' },
      }),
    );
    return (result.Items ?? [])
      .map((item) => item.data as ChatSession)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async deleteSession(id: string): Promise<void> {
    const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
    // The session id alone does not give the partition key, and the item
    // carries the profile it belongs to - so read it first rather than asking
    // the caller to pass a profile id the route does not have.
    const session = await this.getSession(id);
    if (!session) return;
    await this.client.send(
      new DeleteCommand({
        TableName: this.table,
        Key: { pk: this.pk(session.profileId), sk: `SESSION#${id}` },
      }),
    );
  }
}

let storePromise: Promise<Store> | null = null;

export function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = (async () => {
      if (config.tableName) {
        try {
          const store = await DynamoStore.create(config.tableName, config.awsRegion);
          logger.info('store ready', { kind: 'dynamodb', table: config.tableName });
          return store;
        } catch (error) {
          // A missing table should not take the whole API down - degrade to
          // memory and say so loudly.
          logger.error('DynamoDB unavailable, falling back to in-memory store', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      logger.info('store ready', { kind: 'memory' });
      return new MemoryStore();
    })();
  }
  return storePromise;
}

/** Test seam: forces the next getStore() call to rebuild. */
export function resetStore(): void {
  storePromise = null;
}
