import { eq } from 'drizzle-orm';
import { db } from './index.ts';
import { users } from './schema.ts';

export async function getOrCreateUser(uid: string, email: string, displayName = '') {
  try {
    const result = await db
      .insert(users)
      .values({
        uid,
        email,
        displayName,
        preferencesJson: { memoryConsentEnabled: true },
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          email,
          ...(displayName ? { displayName } : {}),
          updatedAt: new Date(),
        },
      })
      .returning();
    return result[0];
  } catch (error) {
    console.error('Database query failed in getOrCreateUser:', error);
    throw new Error('Failed to sync user profile.', { cause: error });
  }
}

export async function getUserByUid(uid: string) {
  try {
    const rows = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
    return rows[0] ?? null;
  } catch (error) {
    console.error('Database query failed in getUserByUid:', error);
    throw new Error('Failed to fetch user profile.', { cause: error });
  }
}

export async function updateUserPreferences(
  uid: string,
  preferences: {
    preferredMaterials?: string[];
    preferredEdgeProcesses?: string[];
    defaultSeamAllowanceMm?: number;
    designHabitNotes?: string[];
    memoryConsentEnabled?: boolean;
  }
) {
  try {
    const existing = await getUserByUid(uid);
    const merged = {
      ...(existing?.preferencesJson ?? { memoryConsentEnabled: true }),
      ...preferences,
    };
    const rows = await db
      .update(users)
      .set({ preferencesJson: merged, updatedAt: new Date() })
      .where(eq(users.uid, uid))
      .returning();
    return rows[0] ?? null;
  } catch (error) {
    console.error('Database query failed in updateUserPreferences:', error);
    throw new Error('Failed to update user preferences.', { cause: error });
  }
}
